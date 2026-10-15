import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceEventStream } from '../src/workspace/event-stream.ts';
import { WorkspaceStreamStore } from '../../workbench/src/model/workspace-stream-store.ts';

// Storage/store microbenchmark only. Does not measure native rendering, keyboard
// latency, model/network wait or constitute an end-to-end performance acceptance.
const dir = await mkdtemp(join(tmpdir(), 'circle-stream-benchmark-'));
const stream = await WorkspaceEventStream.open(join(dir, 'events.jsonl'));
const store = new WorkspaceStreamStore({ maxEventsPerResource: 32 });
const latencies: number[] = [];
const delivery: number[] = [];
stream.subscribe((event) => {
  const began = performance.now();
  store.apply(event);
  delivery.push(performance.now() - began);
});
const began = performance.now();
try {
  for (let batch = 0; batch < 313; batch++) {
    const start = performance.now();
    const size = Math.min(32, 10000 - batch * 32);
    await stream.appendBatch(
      Array.from({ length: size }, (_, index) => ({
        workspaceId: 'fixture',
        sessionId: `agent-${(batch * 32 + index) % 8}`,
        service: 'terminal' as const,
        resourceId: 'output',
        data: { text: 'synthetic line '.repeat(20) },
      })),
    );
    latencies.push(performance.now() - start);
  }
  const percentile = (items: number[], n: number) =>
    [...items].sort((a, b) => a - b)[Math.ceil(items.length * n) - 1];
  console.log(
    JSON.stringify(
      {
        benchmark: 'durable journal and renderer store only',
        node: process.version,
        platform: process.platform,
        events: stream.cursor.seq,
        agentResources: 8,
        syncBeforePublish: true,
        elapsedMs: performance.now() - began,
        appendBatch32Ms: {
          p50: percentile(latencies, 0.5),
          p95: percentile(latencies, 0.95),
        },
        storeApplyMs: {
          p50: percentile(delivery, 0.5),
          p95: percentile(delivery, 0.95),
        },
        journalCacheBytes: stream.cachedBytes,
        rendererCacheBytes: store.cachedBytes,
        excluded: [
          'native UI rendering and input',
          'IPC transport',
          'model and network wait',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await stream.close();
  await rm(dir, { recursive: true, force: true });
}
