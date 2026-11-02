import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeTokenBuffer } from '../src/runtime-token-stream.ts';
import type {
  RuntimeTokenDelta,
  RuntimeUpdate,
} from '../src/runtime-protocol.ts';
import { createFixtures } from '../../workbench/src/preview/fixtures.ts';
import type { CompactionSnapshot } from '../../../src/compaction.ts';
function baseline(seq = 1, tokenSeq = 0): RuntimeUpdate {
  const snapshot = createFixtures();
  snapshot.sessions[0].messages = Array.from({ length: 10000 }, (_, n) => ({
    id: `history-${n}`,
    parentId: null,
    role: 'user' as const,
    text: `message ${n}`,
    at: 'fixture',
  }));
  return {
    seq,
    connected: true,
    snapshot,
    tokenStream: { epoch: 'epoch-one', seq: tokenSeq },
  };
}

test('compaction deltas keep ten thousand history rows by reference and reject stale operation updates', () => {
  const full = baseline();
  const session = full.snapshot.sessions[0];
  const progress: CompactionSnapshot = {
    operationId: 'compact-one',
    sessionId: session.id,
    branchHead: 'history-9999',
    trigger: 'tool',
    status: 'running',
    stage: 'summarizing',
    startedAt: 1,
    updatedAt: 1,
    completed: 0,
    total: 4,
    covered: 0,
    sourceSize: 10000,
    attempts: 0,
    recoveries: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
    unknownCalls: 0,
    liveTokens: 0,
    recoverable: false,
  };
  session.compaction = progress;
  const buffer = new RuntimeTokenBuffer();
  buffer.acceptFull(full);
  for (let seq = 1; seq <= 100; seq++) {
    const chunk = {
      ...delta(full, seq),
      text: undefined,
      streamId: 'compaction-compact-one',
      compaction: { ...progress, updatedAt: seq, liveTokens: seq },
    };
    assert.ok(JSON.stringify(chunk).length < 2000);
    assert.equal(buffer.apply(chunk), 'applied');
    assert.equal(
      buffer.materialize().snapshot.sessions[0].messages,
      session.messages,
    );
  }
  assert.equal(
    buffer.materialize().snapshot.sessions[0].compaction!.liveTokens,
    100,
  );
  assert.equal(
    buffer.apply({
      ...delta(full, 101),
      text: undefined,
      compaction: { ...progress, operationId: 'old' },
    }),
    'gap',
  );
  const finished = {
    ...full,
    seq: 2,
    tokenStream: { epoch: 'epoch-one', seq: 100 },
    snapshot: {
      ...full.snapshot,
      sessions: full.snapshot.sessions.map((s) =>
        s.id === session.id
          ? { ...s, compaction: { ...progress, status: 'succeeded' as const } }
          : s,
      ),
    },
  };
  assert.equal(buffer.acceptFull(finished), true);
  assert.equal(
    buffer.apply({
      ...delta(finished, 101),
      text: undefined,
      compaction: { ...progress, updatedAt: 101 },
    }),
    'gap',
  );
  assert.equal(
    buffer.materialize().snapshot.sessions[0].compaction!.status,
    'succeeded',
  );
});
function delta(
  update: RuntimeUpdate,
  seq: number,
  text = 'chunk',
): RuntimeTokenDelta {
  return {
    epoch: 'epoch-one',
    seq,
    baseSeq: update.seq,
    sessionId: update.snapshot.sessions[0].id,
    streamId: 'stream-current',
    parentId: 'history-9999',
    text,
    at: 'fixture',
  };
}
test('ten thousand historical messages remain immutable while text and thinking hydrate exactly', () => {
  const full = baseline();
  const buffer = new RuntimeTokenBuffer();
  buffer.acceptFull(full);
  assert.equal(buffer.apply(delta(full, 1, 'hello')), 'applied');
  assert.equal(
    buffer.apply({ ...delta(full, 2), text: undefined, thinking: 'reason' }),
    'applied',
  );
  assert.equal(buffer.apply(delta(full, 3, ' world')), 'applied');
  assert.equal(full.snapshot.sessions[0].messages.length, 10000);
  const hydrated = buffer.materialize();
  assert.equal(hydrated.snapshot.sessions[0].messages.length, 10001);
  assert.equal(
    hydrated.snapshot.sessions[0].messages[0],
    full.snapshot.sessions[0].messages[0],
  );
  assert.equal(
    hydrated.snapshot.sessions[0].messages.at(-1)!.text,
    'hello world',
  );
  assert.equal(
    hydrated.snapshot.sessions[0].messages.at(-1)!.thinking,
    'reason',
  );
  assert.equal(hydrated.tokenStream!.seq, 3);
});
test('duplicate, gap, foreign-session and retired epoch tokens cannot corrupt another session', () => {
  const full = baseline();
  const buffer = new RuntimeTokenBuffer();
  buffer.acceptFull(full);
  assert.equal(buffer.apply(delta(full, 1)), 'applied');
  assert.equal(buffer.apply(delta(full, 1)), 'duplicate');
  assert.equal(buffer.apply(delta(full, 3)), 'gap');
  assert.equal(
    buffer.apply({ ...delta(full, 2), sessionId: 'deleted-session' }),
    'missing-session',
  );
  assert.equal(buffer.apply({ ...delta(full, 2), baseSeq: 999 }), 'gap');
  const restarted = baseline(1, 0);
  restarted.tokenStream!.epoch = 'epoch-two';
  assert.equal(buffer.acceptFull(restarted), true);
  assert.equal(buffer.apply(delta(full, 2)), 'duplicate');
  assert.equal(
    buffer.materialize().snapshot.sessions[0].messages.length,
    10000,
  );
});
test('full resync retains latest chunk and deletion never resurrects the removed conversation', () => {
  const full = baseline();
  const buffer = new RuntimeTokenBuffer();
  buffer.acceptFull(full);
  buffer.apply(delta(full, 1, 'kept'));
  const hydrated = buffer.materialize();
  assert.equal(buffer.acceptFull(hydrated), false);
  const deleted = {
    ...hydrated,
    seq: 2,
    snapshot: {
      ...hydrated.snapshot,
      sessions: hydrated.snapshot.sessions.slice(1),
    },
  };
  assert.equal(buffer.acceptFull(deleted), true);
  assert.equal(
    buffer.apply({ ...delta(full, 2, 'wrong'), baseSeq: 2 }),
    'missing-session',
  );
  assert.equal(
    buffer
      .materialize()
      .snapshot.sessions.some((s) => s.id === full.snapshot.sessions[0].id),
    false,
  );
});
