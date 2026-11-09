import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { ContextManager } from '../src/context_middleware.js';
import { ExtensionHost } from '../src/extensions.js';
import {
  compactionPoint,
  contextReminder,
} from '../src/middleware/context_notice.js';
import { requestBudget } from '../src/request_budget.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

test('the context notice comes between 80% and 100% of the compaction point, the sooner of 85% of the window and the room left beside the answer', () => {
  // A 128k window keeping 32k for the answer and a 12.8k margin stops fitting at 83.2k, before 85%
  const tight = { window: 128000, availableInput: 83200 };
  assert.equal(compactionPoint(tight), 83200);
  assert.equal(
    compactionPoint({ window: 128000, availableInput: 111104 }),
    108800,
  );
  assert.equal(
    contextReminder([], { ...tight, input: 66000 }, 'start', true),
    undefined,
  );
  const notice = contextReminder([], { ...tight, input: 70000 }, 'start', true);
  assert.equal(notice?.role, 'user');
  assert.equal(notice?.internal, 'context_reminder');
  assert.match(
    notice!.content,
    /^<system-reminder data-source="circle-context">\nContext: about 70k of the model's 128k tokens\. At about 83k Circle replaces the earlier conversation with a summary\./,
  );
  assert.match(notice!.content, /call compact_conversation/);
  // At the point itself Circle compacts instead of telling
  assert.equal(
    contextReminder([], { ...tight, input: 83200 }, 'start', true),
    undefined,
  );
  // Once per context
  assert.equal(
    contextReminder([notice!], { ...tight, input: 80000 }, 'start', true),
    undefined,
  );
  // A notice the summary kept among the newest messages belongs to the context before it
  assert.ok(
    contextReminder([notice!], { ...tight, input: 80000 }, 'cut-1', true),
  );
  // A subagent has no compact_conversation to call
  const subagent = contextReminder(
    [],
    { ...tight, input: 70000 },
    'start',
    false,
  );
  assert.doesNotMatch(subagent!.content, /compact_conversation/);
  assert.match(subagent!.content, /in your next message/);
});

test('a request near the compaction point carries the notice once; after the summary the next context carries it again', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const window = 20000;
  // A summary may be made in several parts, each its own request
  const model = new ScriptedModel(
    Array.from({ length: 8 }, (_, index) => ({
      message: {
        id: 'summary-' + index,
        role: 'assistant' as const,
        content: 'structured summary',
      },
    })),
  );
  const manager = new ContextManager(store, join(root, 'data'), {
    contextWindow: window,
  });
  const signal = new AbortController().signal;
  const input = (messages: Message[]) =>
    requestBudget(model, { system: '', tools: [], messages }, window).input;
  const point = compactionPoint(
    requestBudget(model, { system: '', tools: [], messages: [] }, window),
  );
  // A message whose text brings the request to `share` of the compaction point
  const padded = (share: number, make: (text: string) => Message): Message => {
    // What the next request carries: after a summary, the summary and what follows it
    const before = manager.project(session.id);
    const base = input([...before, make('')]);
    const each = (input([...before, make('x'.repeat(4000))]) - base) / 4000;
    return make('x'.repeat(Math.floor((point * share - base) / each)));
  };
  const notices = () =>
    store
      .messages(session.id)
      .filter((message) => message.internal === 'context_reminder');
  const prompt = (id: string) => (text: string) =>
    ({ id, role: 'user', content: 'step ' + id + text }) as Message;

  // Below the share: nothing
  store.append(session.id, [padded(0.5, prompt('u1'))]);
  let sent = await manager.prepare(session.id, model, '', [], signal);
  assert.equal(notices().length, 0);

  // Past 80% of the point: the request ends with the notice, kept in history
  store.append(session.id, [
    { id: 'a1', role: 'assistant', content: 'working on it' },
    padded(0.9, prompt('u2')),
  ]);
  sent = await manager.prepare(session.id, model, '', [], signal);
  assert.equal(notices().length, 1);
  assert.equal(sent.at(-1)!.internal, 'context_reminder');
  const share = input(sent) / point;
  assert.ok(share >= 0.8 && share < 1, String(share));
  assert.match(
    sent.at(-1)!.content,
    new RegExp(`At about ${Math.round(point / 1000)}k Circle replaces`),
  );

  // The next request in the same context: still one
  store.append(session.id, [
    {
      id: 'a2',
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c2', name: 'read_file', args: { file_path: 'a' } }],
    },
    { id: 't2', role: 'tool', tool_call_id: 'c2', content: 'ok' },
  ]);
  sent = await manager.prepare(session.id, model, '', [], signal);
  assert.equal(notices().length, 1);
  assert.equal(
    sent.filter((message) => message.internal === 'context_reminder').length,
    1,
  );

  // Past the point: Circle summarizes, and the notice goes with what was summarized
  store.append(session.id, [
    { id: 'a3', role: 'assistant', content: 'one more step' },
    padded(1.2, prompt('u3')),
    { id: 'a4', role: 'assistant', content: 'done with that' },
  ]);
  sent = await manager.prepare(session.id, model, '', [], signal);
  assert.match(sent[0]!.content, /structured summary/);
  assert.equal(
    sent.some((message) => message.internal === 'context_reminder'),
    false,
  );
  assert.ok(model.requests.length >= 1, 'the summary was asked for');

  // The new context fills again: it hears it once more
  store.append(session.id, [padded(0.9, prompt('u4'))]);
  sent = await manager.prepare(session.id, model, '', [], signal);
  assert.equal(notices().length, 2);
  assert.equal(sent.at(-1)!.internal, 'context_reminder');
});

test('a request with no room left for the notice goes without it and still fits', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const window = 20000;
  const model = new ScriptedModel();
  const manager = new ContextManager(store, join(root, 'data'), {
    contextWindow: window,
  });
  const budget = (messages: Message[]) =>
    requestBudget(model, { system: '', tools: [], messages }, window);
  const point = compactionPoint(budget([]));
  // The largest prompt that still stays below the point on its own
  const make = (length: number): Message => ({
    id: 'u',
    role: 'user',
    content: 'x'.repeat(length),
  });
  let length = 0;
  for (let step = 1 << 16; step >= 1; step >>= 1)
    if (budget([make(length + step)]).input < point) length += step;
  store.append(session.id, [make(length)]);
  assert.ok(budget([make(length)]).input >= point * 0.99);
  const sent = await manager.prepare(
    session.id,
    model,
    '',
    [],
    new AbortController().signal,
  );
  assert.equal(
    sent.some((message) => message.internal === 'context_reminder'),
    false,
  );
  assert.ok(budget(sent).fits);
  assert.equal(model.requests.length, 0, 'nothing was summarized');
});

test('without automatic compaction there is no notice', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const model = new ScriptedModel();
  const manager = new ContextManager(store, join(root, 'data'), {
    contextWindow: 20000,
    autoCompact: false,
  });
  store.append(session.id, [
    { id: 'u', role: 'user', content: 'x'.repeat(40000) },
  ]);
  const sent = await manager.prepare(
    session.id,
    model,
    '',
    [],
    new AbortController().signal,
  );
  assert.equal(
    sent.some((message) => message.internal === 'context_reminder'),
    false,
  );
});

test("an extension's model wrapper measures a request as the model does: its input limit, estimate and identity", (t) => {
  const root = scratch(t);
  const base = Object.assign(new ScriptedModel(), {
    contextWindow: 24000,
    outputBudget: 1024,
    inputLimit: 20000,
    outputLimit: 8000,
    budgetIdentity: 'connection-a',
    inputEstimateFactor: 2,
    estimateInput: (request: { system: string }) => request.system.length,
  });
  const wrapper = new ExtensionHost({
    workspace: root,
    home: root,
    trusted: false,
  }).model(base);
  const frame = { system: 'x'.repeat(9000), tools: [], messages: [] };
  assert.deepEqual(requestBudget(wrapper, frame), requestBudget(base, frame));
  assert.equal(requestBudget(wrapper, frame).availableInput, 18000);
  assert.equal(requestBudget(wrapper, frame).input, 18000);
  assert.equal(requestBudget(wrapper, frame).identity, 'connection-a');
  // Read when asked: a limit the model learns later is the wrapper's too
  base.inputLimit = 16000;
  assert.equal(requestBudget(wrapper, frame).fits, false);
});
