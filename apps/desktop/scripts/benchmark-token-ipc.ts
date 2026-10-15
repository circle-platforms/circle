import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createFixtures } from '../../workbench/src/preview/fixtures.ts';
import type {
  RuntimeTokenDelta,
  RuntimeUpdate,
} from '../src/runtime-protocol.ts';

// Actual worker-thread MessagePort transport, with exact JSON byte payloads.
// This is not Electron renderer latency or a native keyboard/paint measurement.
const worker = new Worker(
  `const {parentPort}=require('node:worker_threads');parentPort.on('message',({id,bytes})=>{const value=JSON.parse(Buffer.from(bytes).toString('utf8'));parentPort.postMessage({id,bytes:bytes.byteLength,seq:value.seq});});`,
  { eval: true },
);
let id = 0;
async function roundTrip(payload: unknown) {
  const bytes = Buffer.from(JSON.stringify(payload));
  const key = ++id,
    start = performance.now();
  const done = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off('message', receive);
      reject(Error('IPC benchmark timed out'));
    }, 10000);
    const receive = (reply: { id: number; bytes: number }) => {
      if (reply.id !== key) return;
      clearTimeout(timer);
      worker.off('message', receive);
      resolve(reply.bytes);
    };
    worker.on('message', receive);
  });
  worker.postMessage({ id: key, bytes });
  return { bytes: await done, ms: performance.now() - start };
}
const snapshot = createFixtures();
const session = snapshot.sessions[0];
session.messages = Array.from({ length: 10000 }, (_, n) => ({
  id: `history-${n}`,
  parentId: null,
  role: 'user' as const,
  text: 'synthetic historical message '.repeat(4),
  at: 'fixture',
}));
snapshot.sessions = Array.from({ length: 8 }, (_, n) => ({
  ...session,
  id: `session-${n}`,
  messages: n ? [] : session.messages,
}));
const full: RuntimeUpdate = {
  seq: 1,
  connected: true,
  snapshot,
  tokenStream: { epoch: 'benchmark', seq: 0 },
};
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
try {
  await roundTrip({ warmup: true });
  const baseline: { bytes: number; ms: number }[] = [],
    incremental: { bytes: number; ms: number }[] = [];
  for (let n = 1; n <= 64; n++) {
    baseline.push(await roundTrip({ ...full, seq: n }));
    const delta: RuntimeTokenDelta = {
      epoch: 'benchmark',
      seq: n,
      baseSeq: 1,
      sessionId: `session-${n % 8}`,
      streamId: `stream-${n % 8}`,
      parentId: null,
      text: 'chunk',
      at: 'fixture',
    };
    incremental.push(await roundTrip(delta));
  }
  const summary = (rows: typeof baseline) => ({
    totalPayloadBytes: rows.reduce((n, row) => n + row.bytes, 0),
    roundTripMs: {
      p50: percentile(
        rows.map((r) => r.ms),
        0.5,
      ),
      p95: percentile(
        rows.map((r) => r.ms),
        0.95,
      ),
    },
  });
  console.log(
    JSON.stringify(
      {
        benchmark: 'actual MessagePort JSON payload round trips',
        historicalMessages: 10000,
        sessions: 8,
        updates: 64,
        fullSnapshotPerChunk: summary(baseline),
        tokenDeltaPerChunk: summary(incremental),
        excluded: [
          'Electron IPC serialization',
          'controller history projection CPU',
          'native rendering/input/paint',
          'model/network wait',
        ],
        note: 'Initial/non-token authoritative full snapshots remain; only streaming chunks use the incremental path.',
      },
      null,
      2,
    ),
  );
} finally {
  await worker.terminate();
}
