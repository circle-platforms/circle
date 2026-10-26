import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheckpointStore, emptyContextState } from '../src/checkpoint_store.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { ContextManager } from '../src/context_middleware.js';
import { summaryTranscript } from '../src/compaction_engine.js';
import { requestBudget } from '../src/request_budget.js';
import {
  emptyUsage,
  type ChatModel,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from '../src/types.js';
import { scratch, cleanup } from './helpers.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const response = (
  text: string,
  reason: 'stop' | 'length' = 'stop',
  provider_reason?: string,
): ModelResponse => ({
  message: {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: text,
    completion: { reason, provider_reason },
  },
  usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0 },
});
const history = (): Message[] => [
  {
    id: 'goal',
    role: 'user',
    content: 'Preserve SENTINEL_GOAL and exact evidence.',
  },
  {
    id: 'calls',
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call',
        name: 'execute',
        args: {
          command:
            'SENTINEL_COMMAND ' +
            'code '.repeat(10000) +
            ' SENTINEL_COMMAND_END',
        },
      },
    ],
    cost: {
      model: 'fake',
      amount: 100,
      currency: 'USD',
      tokens: {},
      rates: {},
    } as Message['cost'],
  },
  {
    id: 'result',
    role: 'tool',
    tool_call_id: 'call',
    name: 'execute',
    status: 'success',
    content:
      'SENTINEL_BEGIN ' +
      'output '.repeat(10000) +
      ' SENTINEL_MIDDLE ' +
      'output '.repeat(10000) +
      ' SENTINEL_END',
  },
  { id: 'current', role: 'user', content: 'Continue the existing task.' },
];
function fixture(
  t: Parameters<typeof scratch>[0],
  complete?: (r: ModelRequest, n: number) => Promise<ModelResponse>,
) {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'synthetic', 'fixed title');
  store.claimSession(session.id);
  const requests: ModelRequest[] = [];
  const model: ChatModel = {
    model: 'synthetic',
    contextWindow: 8192,
    outputLimit: 4096,
    async complete(request) {
      requests.push(request);
      assert.equal(
        requestBudget(model, request).fits,
        true,
        'every complete request fits, including summary instructions',
      );
      if (complete) return complete(request, requests.length);
      const facts = [
        ...new Set(
          request.messages
            .map((m) => m.content)
            .join('\n')
            .match(/SENTINEL_[A-Z_]+/g),
        ),
      ];
      return response(
        facts.join(' ') || 'No additional named fact in this fragment.',
      );
    },
  };
  const manager = new ContextManager(store, join(root, 'data'));
  return { root, store, session, requests, model, manager };
}

test('long tool input and output are fully covered, reduced hierarchically and never executed', async (t) => {
  const f = fixture(t);
  const raw = history();
  f.store.append(f.session.id, raw);
  const before = digest(f.store.messages(f.session.id));
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  assert.ok(f.requests.length > 2);
  assert.ok(
    f.requests.every((r) => r.tools.length === 0 && r.maxTokens! <= 4096),
  );
  assert.ok(
    f.requests.every((r) => !r.messages[0]!.content.includes('"amount":100')),
  );
  const state = f.store.contextState(f.session.id);
  for (const fact of [
    'GOAL',
    'COMMAND',
    'COMMAND_END',
    'BEGIN',
    'MIDDLE',
    'END',
  ])
    assert.ok(state.summary!.text.includes('SENTINEL_' + fact), fact);
  assert.equal(f.manager.project(f.session.id).at(-1)?.id, 'current');
  assert.equal(digest(f.store.messages(f.session.id)), before);
  const archive = readFileSync(
    join(f.root, 'data', state.summary!.historyPath!.slice(1)),
    'utf8',
  );
  assert.deepEqual(
    archive
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    raw.slice(0, 3),
  );
  const operation = f.store.compactions.operations(f.session.id).at(-1)!;
  assert.equal(operation.snapshot.status, 'succeeded');
  assert.equal(operation.snapshot.covered, operation.snapshot.sourceSize);
  assert.equal(
    f.store.compactions.attempts(operation.snapshot.operationId).length,
    f.requests.length,
  );
  const result = f.store.compactions.node(
    f.session.id,
    operation.nodes!.at(-1)!,
  )!;
  assert.deepEqual(
    result.ranges,
    raw.slice(0, 3).map((m, index) => ({
      messageId: `${index}:${m.id}`,
      start: 0,
      end: summaryTranscript(m).length,
    })),
  );
  const fork = f.store.fork(f.session.id, f.root);
  assert.equal(
    f.store.contextState(fork.id).summary!.text,
    state.summary!.text,
  );
  assert.equal(
    f.store.compactions.operations(fork.id).at(-1)!.snapshot.sessionId,
    fork.id,
  );
  assert.equal(
    f.store.compactions.operations(fork.id).at(-1)!.snapshot.status,
    'succeeded',
  );
});

test('history that fits as a conversation or tool round stays together in summary requests', async (t) => {
  const f = fixture(t, async () => response('Complete synthetic checkpoint.'));
  const raw: Message[] = [];
  for (let n = 0; n < 5; n++) {
    raw.push(
      {
        id: `user-${n}`,
        role: 'user',
        content: `TURN_${n} preserve the actual result.`,
      },
      {
        id: `call-${n}`,
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `call-${n}`,
            name: 'execute',
            args: { command: `COMMAND_${n} ` + 'input '.repeat(600) },
          },
        ],
      },
      {
        id: `result-${n}`,
        role: 'tool',
        tool_call_id: `call-${n}`,
        name: 'execute',
        status: 'success',
        content: `RESULT_${n} ` + 'output '.repeat(600),
      },
    );
  }
  raw.push({ id: 'current', role: 'user', content: 'Continue.' });
  f.store.append(f.session.id, raw);
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  assert.ok(f.requests.length > 1);
  for (let n = 0; n < 5; n++) {
    const carrying = f.requests.filter(
      (r) =>
        r.messages[0]!.content.includes(`TURN_${n}`) ||
        r.messages[0]!.content.includes(`COMMAND_${n}`) ||
        r.messages[0]!.content.includes(`RESULT_${n}`),
    );
    assert.equal(
      carrying.length,
      1,
      `turn ${n} should fit in one summary request`,
    );
    assert.match(carrying[0]!.messages[0]!.content, new RegExp(`TURN_${n}`));
    assert.match(carrying[0]!.messages[0]!.content, new RegExp(`COMMAND_${n}`));
    assert.match(carrying[0]!.messages[0]!.content, new RegExp(`RESULT_${n}`));
  }
  assert.equal(digest(f.store.messages(f.session.id)), digest(raw));
});

test('provider context rejection shrinks the next request rather than replaying the same payload', async (t) => {
  const f = fixture(t, async (r, n) => {
    if (n === 1)
      return response('partial', 'length', 'model_context_window_exceeded');
    return response('A complete summary.');
  });
  f.store.append(f.session.id, [
    { id: 'old', role: 'user', content: 'context '.repeat(1000) },
    { id: 'answer', role: 'assistant', content: 'done' },
    { id: 'current', role: 'user', content: 'continue' },
  ]);
  await f.manager.compact(
    f.session.id,
    f.model,
    new AbortController().signal,
    '',
    { trigger: 'auto' },
  );
  assert.ok(f.requests.length >= 3);
  assert.ok(
    f.requests[1]!.messages[0]!.content.length <
      f.requests[0]!.messages[0]!.content.length,
  );
  const operation = f.store.compactions.operations(f.session.id).at(-1)!;
  assert.equal(operation.snapshot.status, 'succeeded');
  assert.equal(operation.snapshot.recoveries, 1);
  assert.equal(
    f.store.compactions.attempts(operation.snapshot.operationId)[0]!.completion!
      .provider_reason,
    'model_context_window_exceeded',
  );
});

test('an oversized turn is split at complete tool rounds before splitting a tool result', async (t) => {
  const f = fixture(t, async () => response('Complete checkpoint.'));
  const raw: Message[] = [
    { id: 'goal', role: 'user', content: 'Complete all five reads.' },
  ];
  for (let n = 0; n < 5; n++)
    raw.push(
      {
        id: `call-${n}`,
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `c-${n}`,
            name: 'read_file',
            args: { path: `PATH_${n}`, detail: 'input '.repeat(600) },
          },
        ],
      },
      {
        id: `result-${n}`,
        role: 'tool',
        tool_call_id: `c-${n}`,
        name: 'read_file',
        content: `RESULT_${n} ` + 'output '.repeat(600),
      },
    );
  raw.push({ id: 'current', role: 'user', content: 'Continue.' });
  f.store.append(f.session.id, raw);
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  for (let n = 0; n < 5; n++) {
    const calls = f.requests.filter(
      (r) =>
        r.messages[0]!.content.includes(`PATH_${n}`) ||
        r.messages[0]!.content.includes(`RESULT_${n}`),
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.messages[0]!.content, new RegExp(`PATH_${n}`));
    assert.match(calls[0]!.messages[0]!.content, new RegExp(`RESULT_${n}`));
  }
});

test('large-to-small-to-large window changes re-budget the prior summary and summarize only new history', async (t) => {
  const f = fixture(t, async (request, n) =>
    response(
      n === 1
        ? 'SENTINEL_GOAL ' + 'remember '.repeat(2800)
        : [
            ...new Set(request.messages[0]!.content.match(/SENTINEL_[A-Z_]+/g)),
          ].join(' ') || 'Complete checkpoint.',
    ),
  );
  f.model.contextWindow = 128000;
  f.model.outputLimit = 32000;
  f.model.budgetIdentity = 'endpoint-a:medium';
  f.store.append(f.session.id, history());
  const original = digest(f.store.messages(f.session.id));
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  assert.equal(f.requests.length, 1);
  const largeSummary = f.store.contextState(f.session.id).summary!.text;
  assert.ok(largeSummary.length > 20000);
  f.model.contextWindow = 8192;
  f.model.outputLimit = 1024;
  f.model.budgetIdentity = 'endpoint-b:high';
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  assert.ok(f.requests.length > 2);
  assert.ok(f.requests.slice(1).every((r) => r.maxTokens! <= 1024));
  assert.ok(
    f.requests
      .slice(1)
      .every((r) => !r.messages[0]!.content.includes('SENTINEL_COMMAND')),
  );
  assert.ok(
    requestBudget(f.model, {
      system: '',
      messages: f.manager.project(f.session.id),
      tools: [],
    }).fits,
  );
  assert.match(
    f.store.contextState(f.session.id).summary!.text,
    /SENTINEL_GOAL/,
  );
  assert.equal(digest(f.store.messages(f.session.id)), original);
  const before = f.requests.length;
  f.model.contextWindow = 1000000;
  f.model.outputLimit = 32000;
  f.model.budgetIdentity = 'endpoint-c:low';
  f.store.append(f.session.id, [
    {
      id: 'new-history',
      role: 'assistant',
      content: 'SENTINEL_NEW ' + 'new data '.repeat(60000),
    },
    {
      id: 'new-current',
      role: 'user',
      content: 'Keep this instruction exactly.',
    },
  ]);
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  assert.equal(f.requests.length - before, 1);
  assert.doesNotMatch(
    f.requests.at(-1)!.messages[0]!.content,
    /SENTINEL_COMMAND/,
  );
  assert.match(f.requests.at(-1)!.messages[0]!.content, /SENTINEL_GOAL/);
  assert.match(f.requests.at(-1)!.messages[0]!.content, /SENTINEL_NEW/);
  assert.equal(
    f.manager.project(f.session.id).at(-1)!.content,
    'Keep this instruction exactly.',
  );
});

test('replanning a cached summary for a smaller window still keeps fitting tool rounds together', async (t) => {
  const f = fixture(t, async (_request, n) =>
    response(n === 1 ? 'remember '.repeat(2800) : 'Complete checkpoint.'),
  );
  f.model.contextWindow = 128000;
  f.model.outputLimit = 32000;
  const raw: Message[] = [];
  for (let n = 0; n < 5; n++)
    raw.push(
      { id: `u-${n}`, role: 'user', content: `TURN_${n}` },
      {
        id: `a-${n}`,
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `c-${n}`,
            name: 'read_file',
            args: { path: `PATH_${n}`, detail: 'input '.repeat(600) },
          },
        ],
      },
      {
        id: `r-${n}`,
        role: 'tool',
        tool_call_id: `c-${n}`,
        content: `RESULT_${n} ` + 'output '.repeat(600),
      },
    );
  raw.push({ id: 'current', role: 'user', content: 'Continue.' });
  f.store.append(f.session.id, raw);
  await f.manager.compact(
    f.session.id,
    f.model,
    new AbortController().signal,
    '',
    { minimalTail: true },
  );
  assert.equal(f.requests.length, 1);
  f.store.setContextState(f.session.id, emptyContextState());
  f.model.contextWindow = 8192;
  f.model.outputLimit = 1024;
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  for (let n = 0; n < 5; n++) {
    const carrying = f.requests
      .slice(1)
      .filter(
        (r) =>
          r.messages[0]!.content.includes(`PATH_${n}`) ||
          r.messages[0]!.content.includes(`RESULT_${n}`),
      );
    assert.equal(
      carrying.length,
      1,
      `cached turn ${n} stays together after re-budgeting`,
    );
    assert.match(carrying[0]!.messages[0]!.content, new RegExp(`PATH_${n}`));
    assert.match(carrying[0]!.messages[0]!.content, new RegExp(`RESULT_${n}`));
  }
});

test('deterministic output failures are bounded and continue does not resend known failed requests', async (t) => {
  const f = fixture(t, async () => response('partial', 'length', 'max_tokens'));
  f.store.append(f.session.id, [
    { id: 'old', role: 'user', content: 'context '.repeat(2000) },
    { id: 'answer', role: 'assistant', content: 'done' },
    { id: 'current', role: 'user', content: 'continue' },
  ]);
  await assert.rejects(
    f.manager.compact(f.session.id, f.model, new AbortController().signal, '', {
      trigger: 'auto',
    }),
  );
  const first = new Set(
    f.requests.map((r) =>
      JSON.stringify({
        content: r.messages[0]!.content,
        max: r.maxTokens,
        system: r.system,
      }),
    ),
  );
  assert.ok(f.requests.length <= 9);
  const before = f.requests.length;
  await assert.rejects(
    f.manager.compact(f.session.id, f.model, new AbortController().signal, '', {
      trigger: 'auto',
    }),
  );
  assert.ok(
    f.requests.slice(before).every(
      (r) =>
        !first.has(
          JSON.stringify({
            content: r.messages[0]!.content,
            max: r.maxTokens,
            system: r.system,
          }),
        ),
    ),
  );
  assert.equal(f.store.contextState(f.session.id).summary, undefined);
});

test('cancel retains completed nodes, restart is read-only and resuming reuses them', async (t) => {
  let reached!: () => void;
  const ready = new Promise<void>((r) => (reached = r));
  const f = fixture(t, async (r, n) => {
    if (n === 2) {
      reached();
      await new Promise<void>((_resolve, reject) =>
        r.signal.addEventListener('abort', () => reject(r.signal.reason), {
          once: true,
        }),
      );
    }
    return response('Complete part.');
  });
  f.store.append(f.session.id, history());
  const original = digest(f.store.messages(f.session.id));
  const running = f.manager.compact(
    f.session.id,
    f.model,
    new AbortController().signal,
  );
  const rejected = assert.rejects(running, /Interrupted/);
  await ready;
  const live = f.manager.compactor.snapshot(f.session.id)!;
  assert.equal(
    f.manager.compactor.cancel(f.session.id, 'stale-operation'),
    false,
  );
  assert.equal(
    f.manager.compactor.cancel(f.session.id, live.operationId),
    true,
  );
  await rejected;
  assert.equal(f.store.contextState(f.session.id).summary, undefined);
  assert.equal(digest(f.store.messages(f.session.id)), original);
  f.store.close();
  const reopened = new CheckpointStore(f.root);
  cleanup(t, () => reopened.close());
  const manager = new ContextManager(reopened, join(f.root, 'data'));
  assert.equal(manager.compactor.snapshot(f.session.id)!.status, 'cancelled');
  assert.equal(
    f.requests.length,
    2,
    'reading a snapshot never requests a model',
  );
  const successfulBefore = reopened.compactions
    .operations(f.session.id)
    .at(-1)!.nodes!;
  let newCalls = 0;
  const model: ChatModel = {
    ...f.model,
    complete: async () => {
      newCalls++;
      return response('Complete part.');
    },
  };
  await manager.compact(f.session.id, model, new AbortController().signal);
  const operation = reopened.compactions.operations(f.session.id).at(-1)!;
  assert.ok(successfulBefore.every((key) => operation.nodes!.includes(key)));
  assert.ok(newCalls > 0);
  assert.equal(operation.snapshot.status, 'succeeded');
});

test('tiny window fails before any model request when the current user input alone cannot fit', async (t) => {
  const f = fixture(t);
  f.model.contextWindow = 1000;
  f.store.append(f.session.id, [
    ...history().slice(0, 3),
    { id: 'large', role: 'user', content: 'x'.repeat(5000) },
  ]);
  await assert.rejects(
    f.manager.prepare(
      f.session.id,
      f.model,
      '',
      [],
      new AbortController().signal,
    ),
    /context budget/,
  );
  assert.equal(f.requests.length, 0);
});

test('parallel-capable models overlap independent parts with at most two requests in flight', async (t) => {
  let active = 0,
    maximum = 0,
    calls = 0,
    release!: () => void;
  const overlap = new Promise<void>((resolve) => (release = resolve));
  const f = fixture(t, async () => {
    active++;
    maximum = Math.max(maximum, active);
    const n = ++calls;
    if (n === 2) release();
    if (n <= 2) await overlap;
    await Promise.resolve();
    active--;
    return response('Complete bounded part.');
  });
  f.model.sideRequests = true;
  f.store.append(f.session.id, history());
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.equal(f.manager.compactor.snapshot(f.session.id)!.status, 'succeeded');
});

test('a failed parallel part aborts its sibling and cannot install a partial summary', async (t) => {
  let second!: () => void;
  const entered = new Promise<void>((resolve) => (second = resolve));
  let siblingAborted = false;
  const f = fixture(t, async (request, n) => {
    if (n === 1) {
      await entered;
      return {
        ...response('refused'),
        message: {
          id: 'refusal',
          role: 'assistant',
          content: 'refused',
          completion: { reason: 'filter', provider_reason: 'refusal' },
        },
      };
    }
    second();
    await new Promise<void>((_resolve, reject) =>
      request.signal.addEventListener(
        'abort',
        () => {
          siblingAborted = true;
          reject(request.signal.reason);
        },
        { once: true },
      ),
    );
    return response('late');
  });
  f.model.sideRequests = true;
  f.store.append(f.session.id, history());
  await assert.rejects(
    f.manager.compact(f.session.id, f.model, new AbortController().signal),
    /filtered/,
  );
  assert.equal(siblingAborted, true);
  assert.equal(f.manager.compactor.snapshot(f.session.id)!.status, 'failed');
  assert.equal(f.store.contextState(f.session.id).summary, undefined);
});

test('imported repeated message ids preserve every original and bind the cutoff to its checkpoint', async (t) => {
  const f = fixture(t);
  const rows: Message[] = [
    {
      id: 'duplicate',
      role: 'user',
      content: 'SENTINEL_FIRST ' + 'a'.repeat(12000),
    },
    {
      id: 'duplicate',
      role: 'assistant',
      content: 'SENTINEL_SECOND ' + 'b'.repeat(12000),
    },
    { id: 'current', role: 'user', content: 'continue' },
  ];
  f.store.append(f.session.id, rows);
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  const state = f.store.contextState(f.session.id);
  assert.match(state.summary!.text, /SENTINEL_FIRST/);
  assert.match(state.summary!.text, /SENTINEL_SECOND/);
  assert.ok(state.summary!.cutoffCheckpointId);
  assert.equal(f.store.summaryCutoffIndex(f.session.id, state.summary!), 1);
  assert.equal(f.manager.project(f.session.id).length, 2);
  const fork = f.store.fork(f.session.id, f.root);
  assert.equal(
    f.store.summaryCutoffIndex(fork.id, f.store.contextState(fork.id).summary!),
    1,
  );
  assert.equal(f.store.projectedMessages(fork.id).length, 2);
  assert.deepEqual(f.store.messages(f.session.id), rows);
});

test('thousands of source references stay in storage and cannot overflow a small-window merge request', async (t) => {
  const f = fixture(t, async () => response('A complete short checkpoint.'));
  f.store.append(
    f.session.id,
    Array.from({ length: 3000 }, (_, n) => ({
      id: crypto.randomUUID(),
      role: n % 2 ? ('assistant' as const) : ('user' as const),
      content: 'Synthetic history step ' + n + '. '.repeat(20),
    })),
  );
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  assert.ok(f.requests.length > 2);
  const merges = f.requests.filter((r) =>
    r.messages[0]!.content.includes('[summary of'),
  );
  assert.ok(merges.length > 0);
  assert.ok(
    merges.every((r) => r.messages[0]!.content.length < 2000),
    'merge prompts contain bounded provenance labels, not the full range manifest',
  );
  const op = f.store.compactions.operations(f.session.id).at(-1)!;
  assert.equal(op.snapshot.covered, op.snapshot.sourceSize);
  const result = f.store.compactions.node(f.session.id, op.nodes!.at(-1)!)!;
  assert.ok(result.ranges.length > 2000);
});

test('the final operation and context projection commit atomically', async (t) => {
  const f = fixture(t, async () => response('A complete checkpoint.'));
  f.store.append(f.session.id, history());
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  const prior = f.store.contextState(f.session.id);
  const original = f.store.compactions.operations(f.session.id).at(-1)!;
  const candidate = structuredClone(original);
  candidate.snapshot.operationId = crypto.randomUUID();
  candidate.snapshot.status = 'running';
  f.store.compactions.saveOperation(candidate);
  const db = (f.store as unknown as { db: import('node:sqlite').DatabaseSync })
    .db;
  db.exec(
    "CREATE TRIGGER fail_compaction_commit BEFORE UPDATE ON compaction_operations BEGIN SELECT RAISE(ABORT, 'synthetic commit failure'); END",
  );
  candidate.snapshot.status = 'succeeded';
  assert.throws(
    () =>
      f.store.finalizeCompaction(
        f.session.id,
        {
          ...prior,
          compactionOperationId: candidate.snapshot.operationId,
          summary: { ...prior.summary!, text: 'must roll back' },
        },
        candidate,
      ),
    /synthetic commit failure/,
  );
  assert.deepEqual(f.store.contextState(f.session.id), prior);
  assert.equal(
    f.store.compactions
      .operations(f.session.id)
      .find((o) => o.snapshot.operationId === candidate.snapshot.operationId)!
      .snapshot.status,
    'running',
  );
});

test('a fresh owner durably retires abandoned compaction without requesting a model', async (t) => {
  const f = fixture(t, async () => response('Complete checkpoint.'));
  f.store.append(f.session.id, history());
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  const abandoned = structuredClone(
    f.store.compactions.operations(f.session.id).at(-1)!,
  );
  abandoned.snapshot.operationId = crypto.randomUUID();
  abandoned.snapshot.status = 'running';
  f.store.compactions.saveOperation(abandoned);
  f.store.compactions.saveAttempt(f.session.id, {
    id: crypto.randomUUID(),
    operationId: abandoned.snapshot.operationId,
    nodeKey: 'unfinished',
    requestHash: 'unfinished',
    model: 'synthetic',
    status: 'running',
    createdAt: Date.now(),
    usage: { input_tokens: 37, output_tokens: 0, cache_read_tokens: 0 },
    usageComplete: false,
  });
  f.store.close();
  const model = new ScriptedModel();
  const runtime = new AgentRuntime({
    workspace: f.root,
    home: f.root,
    session: f.session.id,
    settings: defaultSettings(),
    model,
    headless: true,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  const stored = runtime.store.compactions.operations(f.session.id).at(-1)!;
  assert.equal(stored.snapshot.status, 'interrupted');
  assert.equal(stored.snapshot.usage.input_tokens, 37);
  assert.equal(stored.snapshot.unknownCalls, 1);
  assert.equal(model.requests.length, 0);
});

test('the latest compaction is ordered by creation even when wall-clock timestamps are equal', async (t) => {
  const f = fixture(t, async () => response('A complete checkpoint.'));
  f.store.append(f.session.id, history());
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  const original = f.store.compactions.operations(f.session.id).at(-1)!;
  for (const id of ['z-earlier', 'a-later']) {
    const operation = structuredClone(original);
    operation.snapshot.operationId = id;
    f.store.compactions.saveOperation(operation);
  }
  assert.equal(
    f.manager.compactor.snapshot(f.session.id)!.operationId,
    'a-later',
  );
});

test('large Unicode messages and their boundary context remain valid UTF-8 without losing source text', async (t) => {
  const f = fixture(t, async (request) => {
    for (const message of request.messages)
      assert.equal(
        Buffer.from(message.content).toString('utf8'),
        message.content,
      );
    return response('Complete Unicode checkpoint.');
  });
  const original: Message[] = [
    { id: 'unicode', role: 'user', content: '😀☂'.repeat(10000) },
    { id: 'answer', role: 'assistant', content: 'done' },
    { id: 'current', role: 'user', content: 'continue' },
  ];
  f.store.append(f.session.id, original);
  await f.manager.compact(f.session.id, f.model, new AbortController().signal);
  assert.ok(f.requests.length > 1);
  assert.deepEqual(f.store.messages(f.session.id), original);
});

test('recovery shrinks history room without shrinking below the fixed summary instructions', async (t) => {
  const f = fixture(t, async (_request, n) =>
    n === 1
      ? response('partial', 'length', 'model_context_window_exceeded')
      : response('Complete checkpoint.'),
  );
  f.store.append(f.session.id, [
    { id: 'old', role: 'user', content: 'x'.repeat(6000) },
    { id: 'old-answer', role: 'assistant', content: 'done' },
    { id: 'current', role: 'user', content: 'continue' },
  ]);
  await f.manager.compact(
    f.session.id,
    f.model,
    new AbortController().signal,
    'focus '.repeat(1000),
    { trigger: 'auto' },
  );
  assert.equal(f.manager.compactor.snapshot(f.session.id)!.status, 'succeeded');
  assert.equal(f.manager.compactor.snapshot(f.session.id)!.recoveries, 1);
  assert.ok(f.requests.length > 1);
});
