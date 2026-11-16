import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CheckpointStore, emptyContextState } from '../src/checkpoint_store.js';
import type { PriceReceipt } from '../src/pricing.js';
import { AgentRuntime, type RuntimeOptions } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import type { Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const cost = (amount: number): PriceReceipt => ({
  model: 'priced',
  currency: 'USD',
  amount,
  tokens: {
    input_miss: 0,
    input_hit: 0,
    input_write: 0,
    input_write_1h: 0,
    output: 0,
  },
  rates: { input: 1, output: 2 },
  provider: 'fixture',
});
const ask = (id: string): Message => ({ id, role: 'user', content: id });
const answer = (id: string, input: number, amount: number): Message => ({
  id,
  role: 'assistant',
  content: 'answer ' + id,
  usage: { input_tokens: input, output_tokens: 3, cache_read_tokens: 0 },
  // Tenths do not add up exactly, so a sum taken in another order would show.
  cost: cost(amount),
});

/**
 * A conversation whose root started `count` subagents: the first started one of its
 * own and the second compacted once. Its own connection writes it, so the runtime
 * opened on it holds only the root and that connection can still write a subagent.
 */
function seed(t: TestContext, count: number) {
  const home = scratch(t, 'circle-stats-cache-');
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const root = store.create(home, 'scripted', 'root conversation');
  store.append(root.id, [ask('root-ask'), answer('root-answer', 100, 0.3)]);
  const children = Array.from({ length: count }, (_, i) => {
    const child = store.create(
      home,
      'scripted',
      'child ' + i,
      undefined,
      root.id,
    );
    store.append(child.id, [
      ask(`child-${i}-task`),
      answer(`child-${i}-answer`, 10 + i, 0.1 * (i + 1)),
    ]);
    return child.id;
  });
  const grandchild = store.create(
    home,
    'scripted',
    'grandchild',
    undefined,
    children[0],
  );
  store.append(grandchild.id, [
    ask('grandchild-task'),
    answer('grandchild-answer', 7, 0.7),
  ]);
  store.setContextState(children[0]!, {
    ...emptyContextState(),
    subagentSessionIds: [grandchild.id],
  });
  const operationId = randomUUID();
  store.compactions.saveOperation({
    snapshot: {
      operationId,
      sessionId: children[1]!,
      branchHead: store.get(children[1]!)!.head!,
      trigger: 'auto',
      status: 'succeeded',
      stage: 'done',
      startedAt: 1,
      updatedAt: 1,
      completed: 1,
      total: 1,
      covered: 0,
      sourceSize: 0,
      attempts: 1,
      recoveries: 0,
      usage: { input_tokens: 40, output_tokens: 4, cache_read_tokens: 0 },
      unknownCalls: 0,
      liveTokens: 0,
      recoverable: false,
    },
    sourceHash: 'source',
    cutoffId: 'cutoff',
    policy: 'complete-history-v1',
  });
  store.compactions.saveAttempt(children[1]!, {
    id: randomUUID(),
    operationId,
    requestHash: 'request',
    nodeKey: 'node',
    model: 'priced',
    status: 'succeeded',
    usage: { input_tokens: 40, output_tokens: 4, cache_read_tokens: 0 },
    usageComplete: true,
    cost: cost(0.05),
    createdAt: 1,
  });
  store.setContextState(root.id, {
    ...emptyContextState(),
    subagentSessionIds: children,
  });
  return { home, store, root: root.id, children, grandchild: grandchild.id };
}

function open(
  t: TestContext,
  home: string,
  session: string,
  options: Partial<RuntimeOptions> = {},
): AgentRuntime {
  const runtime = new AgentRuntime({
    home,
    userHome: home,
    workspace: home,
    session,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
    bundledExtensions: false,
    ...options,
  });
  cleanup(t, () => runtime.close());
  return runtime;
}

/** The sessions each store read is asked about, and the checkpoints it decodes. */
function reads(store: CheckpointStore) {
  const sessions: string[] = [];
  const checkpoints: string[] = [];
  const watch = (target: object, name: string, seen: (id: unknown) => void) => {
    const methods = target as Record<string, (...args: unknown[]) => unknown>;
    const original = methods[name]!.bind(target);
    methods[name] = (...args: unknown[]) => {
      seen(args[0]);
      return original(...args);
    };
  };
  const session = (id: unknown) => sessions.push(String(id));
  for (const name of ['get', 'messages', 'contextState'])
    watch(store, name, session);
  watch(store.compactions, 'operations', session);
  watch(store, 'checkpoint', (id) => checkpoints.push(String(id)));
  return {
    get sessions() {
      return new Set(sessions);
    },
    get count() {
      return sessions.length + checkpoints.length;
    },
    get checkpoints() {
      return new Set(checkpoints);
    },
    reset() {
      sessions.length = 0;
      checkpoints.length = 0;
    },
  };
}

test('footer totals over seventy subagents read nothing again until one writes', async (t) => {
  const f = seed(t, 70);
  const runtime = open(t, f.home, f.root);
  const first = runtime.stats();
  // The root's answer, seventy subagents, the grandchild and one summary call.
  assert.equal(first.costs.calls, 73);
  assert.equal(
    first.usage.input_tokens,
    100 + 70 * 10 + (69 * 70) / 2 + 7 + 40,
  );
  const probe = reads(runtime.store);
  assert.deepEqual(runtime.stats(), first);
  assert.equal(probe.count, 0, 'nothing is read while nothing writes');

  runtime.store.append(f.children[42]!, [answer('child-42-more', 1000, 0.25)]);
  probe.reset();
  const second = runtime.stats();
  // The root only through the conversation's own messages, which the store keeps; its
  // context and receipts were kept with the count, and the child's context came along
  // with the append, so no checkpoint is decoded.
  assert.deepEqual(probe.sessions, new Set([f.root, f.children[42]]));
  assert.equal(probe.checkpoints.size, 0);
  assert.equal(second.usage.input_tokens, first.usage.input_tokens + 1000);
  assert.equal(second.costs.calls, first.costs.calls + 1);

  f.store.append(f.children[7]!, [answer('child-7-more', 2000, 0.125)]);
  const third = runtime.stats();
  assert.equal(third.usage.input_tokens, second.usage.input_tokens + 2000);
  assert.equal(third.costs.calls, second.costs.calls + 1);

  runtime.store.append(f.children[13]!, [answer('child-13-more', 3, 0.2)]);
  probe.reset();
  const fourth = runtime.stats();
  assert.deepEqual(probe.sessions, new Set([f.root, f.children[13]]));
  await runtime.close();
  // What was kept adds up to exactly what a cold read of the same store gives.
  assert.deepEqual(open(t, f.home, f.root).stats(), fourth);
});

test("a result is the caller's own", (t) => {
  const f = seed(t, 3);
  const runtime = open(t, f.home, f.root);
  const first = runtime.stats();
  const expected = structuredClone(first);
  first.costs.amounts.USD = -1;
  first.costs.calls = 0;
  first.usage.input_tokens = -1;
  const second = runtime.stats();
  assert.deepEqual(second, expected);
  second.costs.amounts = {};
  second.usage.output_tokens = -1;
  assert.deepEqual(runtime.stats(), expected);
});

test('stats follow newSession and switchSession without a write', async (t) => {
  const f = seed(t, 5);
  const runtime = open(t, f.home, f.root, { deferSession: true });
  const first = runtime.stats();
  const version = runtime.store.changeVersion();
  await runtime.newSession();
  assert.equal(runtime.store.changeVersion(), version, 'nothing was written');
  const empty = runtime.stats();
  assert.equal(empty.messages, 0);
  assert.equal(empty.usage.input_tokens, 0);
  assert.equal(empty.costs.calls, 0);
  await runtime.switchSession(f.root);
  // The new session's count kept only what it reached, so its subagents are read
  // once more on the way back, and then not again.
  const probe = reads(runtime.store);
  assert.deepEqual(runtime.stats(), first);
  assert.ok(probe.sessions.has(f.root));
  probe.reset();
  assert.deepEqual(runtime.stats(), first);
  assert.equal(probe.count, 0, 'nothing is read again while nothing writes');
});

test('a failed read is not remembered', (t) => {
  const f = seed(t, 5);
  const runtime = open(t, f.home, f.root);
  const first = runtime.stats();
  const db = (f.store as unknown as { db: DatabaseSync }).db;
  const head = f.store.get(f.children[3]!)!.head!;
  const parent = f.store.checkpoint(head)!.parent;
  db.prepare('UPDATE checkpoints SET parent = ? WHERE id = ?').run(head, head);
  assert.throws(() => runtime.stats(), /checkpoint ancestry cycle/);
  db.prepare('UPDATE checkpoints SET parent = ? WHERE id = ?').run(
    parent,
    head,
  );
  assert.deepEqual(runtime.stats(), first);

  // A failure with nothing written since: the next call reads that session again.
  runtime.store.append(f.children[2]!, [answer('child-2-more', 50, 0.5)]);
  const messages = runtime.store.messages.bind(runtime.store);
  let failing = true;
  runtime.store.messages = (id, at) => {
    if (failing && id === f.children[2]) throw new Error('injected failure');
    return messages(id, at);
  };
  assert.throws(() => runtime.stats(), /injected failure/);
  failing = false;
  const after = runtime.stats();
  assert.equal(after.usage.input_tokens, first.usage.input_tokens + 50);
  assert.equal(after.costs.calls, first.costs.calls + 1);
});
