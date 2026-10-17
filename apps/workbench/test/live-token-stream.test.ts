import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type {
  RuntimeUpdate,
  RuntimeTokenDelta,
} from '../../desktop/src/runtime-protocol.ts';
test('renderer batches text/thinking chunks, restores gaps and unsubscribes on dispose', async () => {
  const snapshot = createFixtures();
  const id = snapshot.sessions[0].id;
  snapshot.runtime = { connected: true, configured: true };
  let full: RuntimeUpdate = {
    seq: 1,
    connected: true,
    snapshot,
    tokenStream: { epoch: 'one', seq: 0 },
  };
  let receive!: (delta: RuntimeTokenDelta) => void;
  let reads = 0,
    unsubscribed = false;
  const host = {
    onRuntime: () => () => {},
    onRuntimeDelta: (callback: typeof receive) => {
      receive = callback;
      return () => {
        unsubscribed = true;
      };
    },
    runtimeState: async () => {
      reads++;
      return full;
    },
  } as unknown as DesktopBridge;
  const runtime = new LiveRuntime(host, full);
  const delta = (seq: number, text: string): RuntimeTokenDelta => ({
    epoch: 'one',
    seq,
    baseSeq: 1,
    sessionId: id,
    streamId: 'stream',
    parentId: null,
    text,
    at: 'now',
  });
  let renders = 0;
  runtime.subscribe(() => renders++);
  receive(delta(1, 'A'));
  receive({ ...delta(2, ''), thinking: 'reason' });
  receive(delta(3, 'B'));
  await delay(25);
  assert.equal(renders, 1);
  assert.equal(runtime.getSnapshot().sessions[0].messages.at(-1)!.text, 'AB');
  assert.equal(
    runtime.getSnapshot().sessions[0].messages.at(-1)!.thinking,
    'reason',
  );
  const recovered = structuredClone(runtime.getSnapshot());
  recovered.sessions[0].messages.at(-1)!.text = 'ABCD';
  full = {
    seq: 1,
    connected: true,
    snapshot: recovered,
    tokenStream: { epoch: 'one', seq: 5 },
  };
  receive(delta(5, 'D'));
  await delay(25);
  assert.equal(reads, 1);
  assert.equal(runtime.getSnapshot().sessions[0].messages.at(-1)!.text, 'ABCD');
  runtime.dispose();
  assert.equal(unsubscribed, true);
  receive(delta(6, 'late'));
  await delay(20);
  assert.equal(runtime.getSnapshot().sessions[0].messages.at(-1)!.text, 'ABCD');
});
