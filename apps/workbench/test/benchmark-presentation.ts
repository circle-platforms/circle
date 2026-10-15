import { performance } from 'node:perf_hooks';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
const snapshot = createFixtures();
snapshot.sessions[0].messages = Array.from({ length: 10000 }, (_, n) => ({
  id: `history-${n}`,
  parentId: null,
  role: 'user' as const,
  text: 'history '.repeat(8),
  at: 'fixture',
}));
const host = { onRuntime: () => () => {} } as unknown as DesktopBridge;
const runtime = new LiveRuntime(host, { seq: 1, connected: true, snapshot });
const id = runtime.getSnapshot().sessions[0].id;
const history = runtime.getSnapshot().sessions[0].messages;
const measure = (action: (n: number) => void) => {
  const timings: number[] = [];
  for (let n = 0; n < 64; n++) {
    const start = performance.now();
    action(n);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return { p50Ms: timings[31], p95Ms: timings[60] };
};
try {
  const explicit = measure((n) =>
    runtime.updateSessionView(id, { draft: `typed ${n}` }),
  );
  const referencesPreserved =
    runtime.getSnapshot().sessions[0].messages === history;
  const compatibilityRecipe = measure((n) =>
    runtime.change((state) => {
      state.sessions[0].draft = `recipe ${n}`;
    }),
  );
  console.log(
    JSON.stringify(
      {
        benchmark: 'real LiveRuntime presentation mutations',
        historicalMessages: 10000,
        samples: 64,
        explicit,
        compatibilityRecipe,
        referencesPreserved,
        excluded: [
          'DOM/rendering',
          'native keyboard latency',
          'IPC',
          'localStorage disk/quota cost',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  runtime.dispose();
}
