import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { CheckpointStore, emptyContextState } from '../src/checkpoint_store.js';
import { ContextManager } from '../src/context_middleware.js';
import {
  nextPruneState,
  pruneBatchTokens,
  pruneMessages,
  pruneProtectTokens,
} from '../src/middleware/tool_result_prune.js';
import { planReminder, planTail } from '../src/middleware/plan_tail.js';
import { analyze, loopReminder } from '../src/middleware/loop_guard.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import type { Message, ModelRequest } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
const assistant = (
  id: string,
  content: string,
  name?: string,
  args: Record<string, unknown> = {},
): Message => ({
  id,
  role: 'assistant',
  content,
  ...(name ? { tool_calls: [{ id: 'call-' + id, name, args }] } : {}),
});
const tool = (id: string, name: string, content: string): Message => ({
  id: 'result-' + id,
  role: 'tool',
  name,
  content,
  tool_call_id: 'call-' + id,
  status: 'success',
});
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('pruning persists one batch, protects structured and question results, and strips only already-existing affected thinking', () => {
  const messages: Message[] = [{ id: 'user', role: 'user', content: 'go' }];
  for (let index = 0; index < 2; index++)
    messages.push(
      {
        ...assistant('ai-' + index, 'step', 'tick', { index }),
        thinking: 'original thought',
        provider_content: [
          { type: 'thinking', thinking: 'thought', signature: 'signature' },
          { type: 'text', text: 'step' },
        ],
      },
      tool('ai-' + index, 'tick', 'x'.repeat(40000)),
    );
  const original = digest(messages);
  const state = nextPruneState(messages, emptyContextState(), {
    protectTokens: 0,
  });
  assert.deepEqual(state.prunedIds, ['result-ai-0', 'result-ai-1']);
  assert.deepEqual(state.stripThinkingIds, ['ai-1']);
  assert.equal(nextPruneState(messages, state, { protectTokens: 0 }), state);
  const projected = pruneMessages(messages, state);
  assert.match(projected[2]!.content, /pruned to free context/);
  assert.equal(projected[1]!.thinking, 'original thought');
  assert.equal(projected[3]!.thinking, undefined);
  assert.equal(digest(messages), original);
  const protectedMessages = [
    tool('question', 'question', 'x'.repeat(100000)),
    tool('skill', 'skill', 'x'.repeat(100000)),
    tool('json', 'read_file', JSON.stringify({ data: 'x'.repeat(100000) })),
  ];
  assert.equal(
    nextPruneState(protectedMessages, emptyContextState(), { protectTokens: 0 })
      .prunedIds.length,
    0,
  );
  messages.push({ ...assistant('later', 'later'), thinking: 'new thought' });
  assert.equal(pruneMessages(messages, state).at(-1)!.thinking, 'new thought');
});
test('real tool loop preserves request prefixes between batches and reuses projection after restart', async (t) => {
  const root = scratch(t);
  const replies = Array.from({ length: 8 }, (_, index) => ({
    message: {
      ...assistant('ai-' + index, 'step', 'tick', { index }),
      thinking: 'thought-' + index,
    },
  }));
  const model = new ScriptedModel([
    ...replies,
    { message: assistant('done', 'done') },
  ]);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.harness.tools.push({
    name: 'tick',
    description: 'numbered output',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' } },
      required: ['index'],
    },
    run: async (args) => `${args.index}:` + 'x'.repeat(40000),
  });
  await runtime.harness.run('go');
  assert.equal(model.requests.length, 9);
  const prefix = (a: number, b: number) =>
    digest(model.requests[a]!.messages) ===
    digest(
      model.requests[b]!.messages.slice(0, model.requests[a]!.messages.length),
    );
  for (const index of [0, 1, 2, 3, 5, 7])
    assert.equal(prefix(index, index + 1), true, `prefix ${index}`);
  assert.equal(prefix(4, 5), false);
  assert.equal(prefix(6, 7), false);
  assert.equal(
    runtime.store.contextState(runtime.session.id).prunedIds.length,
    4,
  );
  assert.ok(
    runtime.harness.messages
      .filter((message) => message.role === 'tool')
      .every((message) => message.content.length > 40000),
  );
  const state = runtime.store.contextState(runtime.session.id);
  const id = runtime.session.id;
  await runtime.close();
  const follow = new ScriptedModel([{ message: assistant('follow', 'again') }]);
  const reopened = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model: follow,
    session: id,
    headless: true,
  });
  cleanup(t, () => reopened.close());
  assert.equal(reopened.session.id, id);
  await reopened.harness.run('next');
  assert.deepEqual(reopened.store.contextState(id).prunedIds, state.prunedIds);
  assert.match(
    JSON.stringify(follow.requests[0]!.messages),
    /pruned to free context/,
  );
});
test('summary projections belong to their branch and fork, not a session-wide mutable pointer', (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const prefix = store.append(session.id, [
    { id: 'user', role: 'user', content: 'go' },
  ]);
  const a = store.append(session.id, [assistant('a', 'branch A')])!;
  store.setSummary(session.id, a, 'summary A');
  const aRaw = digest(store.messages(session.id));
  store.select(session.id, prefix);
  const b = store.append(session.id, [assistant('b', 'branch B')])!;
  assert.equal(store.contextState(session.id).summary, undefined);
  store.setSummary(session.id, b, 'summary B');
  store.select(session.id, a);
  assert.match(store.projectedMessages(session.id)[0]!.content, /summary A/);
  assert.equal(digest(store.messages(session.id)), aRaw);
  const fork = store.fork(session.id, root);
  assert.match(store.projectedMessages(fork.id)[0]!.content, /summary A/);
  store.select(session.id, b);
  assert.match(store.projectedMessages(session.id)[0]!.content, /summary B/);
});
test('large tool output is offloaded as exact bytes, recovered after relocation, and corrupt artifacts are rejected', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const raw = '中文 output\n'.repeat(10000);
  store.append(session.id, [
    { id: 'user', role: 'user', content: 'go' },
    assistant('read', '', 'read_file', {}),
    tool('read', 'read_file', raw),
  ]);
  const before = digest(store.messages(session.id));
  const data = join(root, 'data');
  const manager = new ContextManager(store, data, { autoCompact: false });
  const model = new ScriptedModel();
  const signal = new AbortController().signal;
  const projected = await manager.prepare(session.id, model, '', [], signal);
  const virtual = store.contextState(session.id).offloaded['result-read']!;
  const path = join(data, virtual.slice(1));
  assert.equal(readFileSync(path, 'utf8'), raw);
  assert.match(projected.at(-1)!.content, /Full output saved/);
  assert.equal(digest(store.messages(session.id)), before);
  unlinkSync(path);
  await manager.prepare(session.id, model, '', [], signal);
  assert.equal(readFileSync(path, 'utf8'), raw);
  const relocated = new ContextManager(store, join(root, 'relocated'), {
    autoCompact: false,
  });
  await relocated.prepare(session.id, model, '', [], signal);
  assert.equal(
    readFileSync(join(root, 'relocated', virtual.slice(1)), 'utf8'),
    raw,
  );
  writeFileSync(path, 'corrupt');
  await assert.rejects(
    manager.prepare(session.id, model, '', [], signal),
    /does not match raw history/,
  );
  assert.equal(readFileSync(path, 'utf8'), 'corrupt');
});
test('automatic compaction uses a balanced prefix, retains raw bytes, and exposes recoverable history', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const raw: Message[] = [];
  for (let i = 0; i < 6; i++)
    raw.push(
      {
        id: 'user-' + i,
        role: 'user',
        content: 'goal ' + i + 'x'.repeat(3000),
      },
      assistant('ai-' + i, 'answer ' + i),
    );
  store.append(session.id, raw);
  const before = digest(store.messages(session.id));
  const model = new ScriptedModel([
    { message: assistant('summary', 'structured summary') },
  ]);
  const manager = new ContextManager(store, join(root, 'data'), {
    contextWindow: 10000,
  });
  const result = await manager.prepare(
    session.id,
    model,
    '',
    [],
    new AbortController().signal,
  );
  assert.match(result[0]!.content, /structured summary/);
  assert.equal(result.length, 4);
  assert.equal(digest(store.messages(session.id)), before);
  const state = store.contextState(session.id);
  assert.ok(state.summary?.historyPath);
  const artifact = readFileSync(
    join(root, 'data', state.summary.historyPath.slice(1)),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(artifact, raw.slice(0, 9));
  assert.equal(model.requests[0]!.tools.length, 0);
});
test('plan reminders are bounded, after tool results, current-turn-only and do not treat subagents as the main agent', () => {
  const todos = [{ content: 'work', status: 'in_progress' as const }];
  const raw: Message[] = [
    { id: 'user', role: 'user', content: 'go' },
    assistant('plan', '', 'write_todos', { todos }),
    tool('plan', 'write_todos', 'updated'),
  ];
  for (let index = 0; index < 10; index++)
    raw.push(
      assistant('ai-' + index, '', 'tick', { index }),
      tool('ai-' + index, 'tick', 'found'),
    );
  const reminder = planReminder(raw, raw, todos)!;
  assert.equal(reminder.internal, 'plan-reminder');
  assert.match(
    reminder.content,
    /^<system-reminder data-source="circle-plan">\n[\s\S]*\[>\] work[\s\S]*<\/system-reminder>$/,
  );
  assert.equal(planReminder(raw, raw, todos, true), undefined);
  assert.equal(
    planReminder(
      [
        ...raw,
        { id: 'next', role: 'user', content: 'new task' },
        tool('after', 'tick', 'found'),
      ],
      raw,
      todos,
    ),
    undefined,
  );
  const long = Array.from({ length: 40 }, (_, index) => ({
    content: 'step ' + index + 'x'.repeat(200),
    status: index < 20 ? ('completed' as const) : ('pending' as const),
  }));
  assert.equal(
    planTail(long)
      .split('\n')
      .filter((line) => line.startsWith('[')).length,
    15,
  );
  assert.match(planTail(long), /step 20/);
});
test('loop analysis groups parallel empty results as one round and permits ordered paging progress', () => {
  const messages: Message[] = [{ id: 'u', role: 'user', content: 'search' }];
  for (let round = 0; round < 4; round++) {
    const answer = assistant('a' + round, '');
    answer.tool_calls = Array.from({ length: 3 }, (_, index) => ({
      id: `r${round}-${index}`,
      name: 'grep',
      args: { pattern: 'missing' + index },
    }));
    messages.push(
      answer,
      ...answer.tool_calls.map((call) => ({
        id: call.id + '-result',
        role: 'tool' as const,
        content: 'No matches found',
        tool_call_id: call.id,
      })),
    );
  }
  assert.equal(analyze(messages).emptyRounds, 4);
  assert.equal(loopReminder(messages)?.internal, 'loop-guard');
  const pages = Array.from({ length: 8 }, (_, index) =>
    assistant('page' + index, '', 'read_file', {
      file_path: 'a',
      offset: index * 100,
    }),
  );
  assert.equal(analyze(pages).loose, 0);
  for (const message of pages) message.tool_calls![0]!.args.offset = 1;
  assert.equal(analyze(pages).loose, 8);
  const charPages = Array.from({ length: 8 }, (_, index) =>
    assistant('char-page-' + index, '', 'read_file', {
      file_path: 'long.txt',
      offset: 1,
      char_offset: index * 2000,
    }),
  );
  assert.equal(analyze(charPages).loose, 0);
  const editedReads: Message[] = [
    { id: 'u', role: 'user', content: 'edit loop' },
  ];
  for (let index = 0; index < 6; index++) {
    editedReads.push(
      assistant(`read-${index}`, '', 'read_file', {
        file_path: 'a.ts',
        offset: 1,
      }),
      tool(`read-${index}`, 'read_file', 'line 1'),
    );
    if (index < 5)
      editedReads.push(
        assistant(`edit-${index}`, '', 'edit_file', {
          file_path: 'a.ts',
          old_string: `v${index}`,
          new_string: `v${index + 1}`,
        }),
        tool(`edit-${index}`, 'edit_file', 'Edited a.ts'),
      );
  }
  assert.equal(analyze(editedReads).loose, 0);
  assert.equal(analyze(editedReads).duplicate, 1);
  const failedEditReads: Message[] = [
    { id: 'u', role: 'user', content: 'failed edit loop' },
  ];
  for (let index = 0; index < 6; index++) {
    failedEditReads.push(
      assistant(`fread-${index}`, '', 'read_file', {
        file_path: 'a.ts',
        offset: 1,
      }),
      tool(`fread-${index}`, 'read_file', 'line 1'),
    );
    if (index < 5)
      failedEditReads.push(
        assistant(`fedit-${index}`, '', 'edit_file', {
          file_path: 'a.ts',
          old_string: `v${index}`,
          new_string: `v${index + 1}`,
        }),
        {
          id: `fedit-${index}-err`,
          role: 'tool',
          content: 'no match',
          tool_call_id: `call-fedit-${index}`,
          status: 'error',
        },
      );
  }
  assert.equal(analyze(failedEditReads).loose, 6);
  const patchedReads: Message[] = [
    { id: 'u', role: 'user', content: 'patch loop' },
  ];
  for (let index = 0; index < 6; index++) {
    patchedReads.push(
      assistant(`pread-${index}`, '', 'read_file', {
        file_path: 'a.ts',
        offset: 1,
      }),
      tool(`pread-${index}`, 'read_file', 'line 1'),
    );
    if (index < 5)
      patchedReads.push(
        assistant(`patch-${index}`, '', 'apply_patch', {
          patchText: `*** Begin Patch\n*** Update File: a.ts\n@@\n-v${index}\n+v${index + 1}\n*** End Patch`,
        }),
        tool(`patch-${index}`, 'apply_patch', 'Updated a.ts'),
      );
  }
  assert.equal(analyze(patchedReads).loose, 0);
  assert.equal(analyze(patchedReads).duplicate, 1);
});
test('productive long turns are not cut off at the prototype one-hundred-call limit', async (t) => {
  const root = scratch(t);
  const replies = Array.from({ length: 105 }, (_, index) => ({
    message: assistant('ai-' + index, '', 'tick', { index }),
  }));
  const model = new ScriptedModel([
    ...replies,
    { message: assistant('done', 'completed the long task') },
  ]);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.harness.tools.push({
    name: 'tick',
    description: '',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' } },
      required: ['index'],
    },
    effect: 'read',
    run: async (args) => 'new result ' + args.index,
  });
  assert.equal(
    (await runtime.harness.run('long task')).answer,
    'completed the long task',
  );
  assert.equal(model.requests.length, 106);
  assert.equal(
    runtime.harness.messages.filter(
      (message) => message.internal === 'loop-guard',
    ).length,
    1,
  );
});
test('loop guard resets repeated-call evidence across warnings without repeating soft-budget noise', () => {
  const messages: Message[] = [
    { id: 'u', role: 'user', content: 'investigate' },
  ];
  for (let index = 0; index < 4; index++) {
    messages.push(
      assistant(`dup-${index}`, '', 'read_file', { file_path: 'same.txt' }),
      tool(`dup-${index}`, 'read_file', 'same content'),
    );
  }
  const first = loopReminder(messages);
  assert.equal(first?.internal, 'loop-guard');
  assert.match(first!.content, /going in circles/);
  messages.push(first!);
  for (let index = 0; index < 9; index++) {
    messages.push(
      assistant(`next-${index}`, '', 'grep', { pattern: `token-${index}` }),
      tool(`next-${index}`, 'grep', `match ${index}`),
    );
  }
  assert.equal(loopReminder(messages), undefined);
  for (let index = 0; index < 4; index++) {
    messages.push(
      assistant(`again-${index}`, '', 'read_file', { file_path: 'again.txt' }),
      tool(`again-${index}`, 'read_file', 'same again'),
    );
  }
  const second = loopReminder(messages);
  assert.equal(second?.internal, 'loop-guard');
  assert.match(second!.content, /going in circles/);
});

for (const reason of [
  'filter',
  'pause',
  'unknown',
  'length',
  'missing',
] as const) {
  test(`compaction rejects ${reason} with visible partial text without replacing history`, async (t) => {
    const root = scratch(t);
    const store = new CheckpointStore(root);
    cleanup(t, () => store.close());
    const session = store.create(root, 'test');
    const raw: Message[] = [];
    for (let i = 0; i < 6; i++)
      raw.push(
        { id: `u-${i}`, role: 'user', content: 'x'.repeat(3000) },
        assistant(`a-${i}`, 'answer'),
      );
    store.append(session.id, raw);
    const before = digest(store.messages(session.id));
    const model = new ScriptedModel(
      Array.from({ length: reason === 'length' ? 9 : 1 }, () => ({
        message: {
          ...assistant('summary', 'unfinished summary'),
          completion: { reason },
        },
        usage: { input_tokens: 17, output_tokens: 23, cache_read_tokens: 3 },
      })),
    );
    const manager = new ContextManager(store, join(root, 'data'), {
      contextWindow: 10000,
    });
    await assert.rejects(
      manager.prepare(session.id, model, '', [], new AbortController().signal),
    );
    if (reason === 'length')
      assert.ok(model.requests.length > 1 && model.requests.length <= 9);
    else assert.equal(model.requests.length, 1);
    assert.equal(store.contextState(session.id).summary, undefined);
    const operation = store.compactions.operations(session.id).at(-1)!;
    const calls = store.compactions.attempts(operation.snapshot.operationId);
    assert.equal(calls.length, model.requests.length);
    assert.deepEqual(calls[0]?.usage, {
      input_tokens: 17,
      output_tokens: 23,
      cache_read_tokens: 3,
    });
    assert.equal(digest(store.messages(session.id)), before);
  });
}

// Ten results of 10,000 tokens each, or as many as asked, as an agent that read ten files leaves them
const reads = (count: number): Parameters<typeof nextPruneState>[0] => {
  const messages: Parameters<typeof nextPruneState>[0] = [];
  for (let index = 0; index < count; index++)
    messages.push(
      assistant('read-' + index, 'step', 'read_file', { index }),
      tool('read-' + index, 'read_file', 'x'.repeat(40000)),
    );
  return messages;
};
const unlessSet = async (run: () => void | Promise<void>) => {
  const saved = process.env.CIRCLE_PRUNE_PROTECT_TOKENS;
  delete process.env.CIRCLE_PRUNE_PROTECT_TOKENS;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.CIRCLE_PRUNE_PROTECT_TOKENS;
    else process.env.CIRCLE_PRUNE_PROTECT_TOKENS = saved;
  }
};

test('the tool output pruning leaves untouched grows with the most input the model takes, and the environment setting still decides when it is given', () =>
  unlessSet(() => {
    assert.equal(pruneProtectTokens(), 40000);
    assert.equal(pruneProtectTokens(128000), 40000);
    assert.equal(pruneProtectTokens(200000), 50000);
    assert.equal(pruneProtectTokens(1000000), 250000);
    const messages = reads(10);
    const pruned = (options: Parameters<typeof nextPruneState>[2]) =>
      nextPruneState(messages, emptyContextState(), options).prunedIds;
    // ten results of 10,000 tokens each: the default keeps the four most recent
    assert.deepEqual(
      pruned({}),
      [0, 1, 2, 3, 4, 5].map((index) => 'result-read-' + index),
    );
    assert.deepEqual(
      pruned({ inputLimit: 200000 }),
      [0, 1, 2, 3, 4].map((index) => 'result-read-' + index),
    );
    assert.deepEqual(
      pruned({ inputLimit: 1000000 }),
      [],
      'a model that takes a million tokens keeps what its agent read',
    );
    assert.equal(
      pruned({ inputLimit: 1000000, protectTokens: 0 }).length,
      10,
      'an explicit option still decides',
    );
    process.env.CIRCLE_PRUNE_PROTECT_TOKENS = '10000';
    assert.equal(
      pruned({ inputLimit: 1000000 }).length,
      9,
      'CIRCLE_PRUNE_PROTECT_TOKENS still decides',
    );
  }));

test('the least pruned in one batch is half of what is left untouched, 20,000 tokens at least, and an explicit option still wins', () =>
  unlessSet(() => {
    assert.equal(pruneBatchTokens(40000), 20000);
    assert.equal(pruneBatchTokens(250000), 125000);
    assert.equal(pruneBatchTokens(10000), 20000, 'never less than the floor');
    const pruned = (
      count: number,
      options: Parameters<typeof nextPruneState>[2] = {},
    ) =>
      nextPruneState(reads(count), emptyContextState(), options).prunedIds
        .length;
    // At the floor, as before: 40,000 tokens stay, and a batch is 20,000, two of the results
    assert.equal(pruned(5), 0, 'one result is less than a batch');
    assert.equal(pruned(6), 2);
    // A model that takes a million tokens leaves 250,000 and waits for 125,000 more
    assert.equal(
      pruned(37, { inputLimit: 1000000 }),
      0,
      '120,000 are no batch',
    );
    assert.equal(pruned(38, { inputLimit: 1000000 }), 13);
    // The same when what is left untouched is given
    assert.equal(pruned(14, { protectTokens: 100000 }), 0);
    assert.equal(pruned(15, { protectTokens: 100000 }), 5);
    process.env.CIRCLE_PRUNE_PROTECT_TOKENS = '100000';
    assert.equal(pruned(14), 0);
    assert.equal(pruned(15), 5);
    // An explicit least wins over both
    assert.equal(
      pruned(14, { protectTokens: 100000, minimumTokens: 30000 }),
      4,
    );
    assert.equal(
      pruned(15, { protectTokens: 100000, minimumTokens: 60000 }),
      0,
    );
  }));

test('the context middleware sizes what pruning leaves untouched from the most input the model takes', (t) =>
  unlessSet(async () => {
    const root = scratch(t);
    const store = new CheckpointStore(root);
    cleanup(t, () => store.close());
    const manager = new ContextManager(store, join(root, 'data'), {
      autoCompact: false,
    });
    const signal = new AbortController().signal;
    // Six results of 10,000 tokens each, in a conversation of their own, for a model with these limits
    const prunedFor = async (limits: {
      contextWindow?: number;
      inputLimit?: number;
    }) => {
      const session = store.create(root, 'test');
      store.append(session.id, [
        { id: 'user', role: 'user', content: 'go' },
        ...reads(6),
      ]);
      await manager.prepare(
        session.id,
        Object.assign(new ScriptedModel(), limits),
        '',
        [],
        signal,
      );
      return store.contextState(session.id).prunedIds;
    };
    const oldest = ['result-read-0', 'result-read-1'];
    assert.deepEqual(
      await prunedFor({}),
      oldest,
      'the default window leaves 40,000 tokens untouched',
    );
    assert.deepEqual(
      await prunedFor({ contextWindow: 1000000 }),
      [],
      'a window of a million tokens leaves 250,000: nothing is pruned',
    );
    assert.deepEqual(
      await prunedFor({ contextWindow: 1000000, inputLimit: 100000 }),
      oldest,
      'a model that takes 100,000 tokens of input is sized by that, not by its window',
    );
  }));
