// What a runtime publication costs through the real application: worker, main process,
// sandboxed renderer and paint, against stored history. Electron on a scripted model and
// a scratch data folder; never real Circle data. Build first, then run it from the root:
//   npm --prefix apps/desktop run build
//   node --import tsx apps/desktop/scripts/benchmark-publish-native.mjs --sessions 40 --messages 1000
// The stages in Node are in benchmark-publish.ts. It reads only what any window receives,
// so the same script compares two builds whatever the update looks like.
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishBenchmarkMessages } from './publish-benchmark-fixture.mjs';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
};
const sessions = option('sessions', 10);
const messages = option('messages', 300);
const publishes = option('publishes', 20);
const toolCalls = option('tool-calls', 10);
const profileAt = process.argv.indexOf('--profile');
// Where to write the renderer's CPU profile of the tool turn, to read in DevTools.
const profilePath = profileAt < 0 ? undefined : process.argv[profileAt + 1];
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const appAt = process.argv.indexOf('--app');
// Another build to run, such as a copy of apps/desktop built from an earlier commit.
const appPath = appAt < 0 ? root : resolve(process.argv[appAt + 1]);
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-benchmark-publish-native-'));
const data = join(temp, 'data');
const home = join(data, 'runtime-home');
const workspace = join(temp, 'workspace');
await mkdir(join(home, 'cache'), { recursive: true });
await mkdir(join(workspace, '.git'), { recursive: true });
await writeFile(join(workspace, 'note.txt'), 'benchmark file\n');
await writeFile(
  join(home, 'cache', 'models-dev.json'),
  JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
);
const settings = trustFolder(defaultSettings(), workspace);
settings.workspace_folder = workspace;
saveSettings(settings, home);
const selected = 'benchmark-session-0';
const store = new CheckpointStore(home);
for (let index = sessions - 1; index >= 0; index--) {
  const id = `benchmark-session-${index}`;
  store.create(workspace, 'fixture', `session ${index}`, id);
  store.append(id, publishBenchmarkMessages(id, messages));
}
store.close();
await writeFile(
  join(home, 'desktop-session.json'),
  JSON.stringify({ workspace, sessionId: selected }),
);
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 };
const fixturePath = join(temp, 'model.json');
await writeFile(
  fixturePath,
  JSON.stringify({
    model: 'fixture-model',
    // Wide enough that the stored history never makes the turn compact.
    contextWindow: 1_000_000_000,
    replies: [
      ...Array.from({ length: toolCalls }, (_, index) => ({
        message: {
          id: `benchmark-turn-${index}`,
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `benchmark-call-${index}`,
              name: 'read_file',
              args: { file_path: 'note.txt' },
            },
          ],
        },
        usage,
      })),
      {
        message: {
          id: 'benchmark-turn-end',
          role: 'assistant',
          content: 'benchmark turn ended',
        },
        usage,
      },
    ],
  }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({ workspace }),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
};
delete env.ELECTRON_RUN_AS_NODE;

const quantile = (values, q) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * q))
  ] ?? 0;
const spread = (values) => ({
  p50: Math.round(quantile(values, 0.5)),
  p95: Math.round(quantile(values, 0.95)),
});
const sum = (values) => values.reduce((a, b) => a + b, 0);

// Seconds of CPU each kind of process has used. It holds up on a busy machine, where a
// wall clock also counts the other work waiting for a core.
const cpu = async (app) =>
  app.evaluate(({ app: electronApp }) => {
    const seconds = {};
    const memoryKb = {};
    for (const row of electronApp.getAppMetrics()) {
      seconds[row.type] = (seconds[row.type] ?? 0) + row.cpu.cumulativeCPUUsage;
      memoryKb[row.type] =
        (memoryKb[row.type] ?? 0) + row.memory.workingSetSize;
    }
    return { seconds, memoryKb };
  });
const cpuSpent = (before, after) =>
  Object.fromEntries(
    ['Utility', 'Browser', 'Tab'].map((type) => [
      { Utility: 'runtime', Browser: 'main', Tab: 'renderer' }[type],
      Number(
        ((after.seconds[type] ?? 0) - (before.seconds[type] ?? 0)).toFixed(3),
      ),
    ]),
  );

let app;
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath: require('electron'),
    args: [appPath],
    cwd: root,
    env,
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(180_000);
  await page.bringToFront();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  // Everything below reads one thing a window receives: the update as it arrives.
  await page.evaluate(() => {
    const rows = [];
    const longTasks = [];
    window.__publishBenchmark = { rows, longTasks };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    }).observe({ type: 'longtask' });
    window.circleDesktop.onRuntime((update) => {
      const row = {
        seq: update.seq,
        kind: update.event?.kind,
        // Stamped while the runtime builds the snapshot, on this machine's clock.
        observedAt: Date.parse(update.snapshot.runtime.observedAt),
        receivedAt: Date.now(),
      };
      rows.push(row);
      const start = performance.now();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          row.paintedAt = Date.now();
          row.afterReceiveMs = performance.now() - start;
          // Outside the window measured above: what this payload costs a copy.
          const before = performance.now();
          structuredClone(update);
          row.cloneMs = performance.now() - before;
          row.bytes = JSON.stringify(update).length;
          row.done = true;
        }),
      );
    });
  });
  const command = (name, payload = {}) =>
    page.evaluate(
      async ({ name, payload, sessionId }) => {
        const reply = await window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name,
          payload,
          sessionId,
        });
        if (!reply.ok) throw Error(reply.error);
        return reply.data;
      },
      { name, payload, sessionId: selected },
    );
  const take = () =>
    page.evaluate(() => {
      const { rows, longTasks } = window.__publishBenchmark;
      return {
        rows: rows.splice(0),
        longTasks: longTasks.splice(0),
      };
    });
  const settled = () =>
    page.waitForFunction(
      () => window.__publishBenchmark.rows.every((row) => row.done),
      undefined,
      { polling: 20 },
    );
  const report = (taken, spent) => {
    const rows = taken.rows.filter((row) => row.done);
    return {
      updates: rows.length,
      megabytesPerUpdate: Number(
        (sum(rows.map((row) => row.bytes)) / rows.length / 1024 / 1024).toFixed(
          3,
        ),
      ),
      runtimeToRendererMs: spread(
        rows.map((row) => row.receivedAt - row.observedAt),
      ),
      runtimeToPaintMs: spread(
        rows.map((row) => row.paintedAt - row.observedAt),
      ),
      receiveToPaintMs: spread(rows.map((row) => row.afterReceiveMs)),
      cloneMs: spread(rows.map((row) => row.cloneMs)),
      rendererLongTaskMs: Math.round(sum(taken.longTasks)),
      cpuSecondsPerUpdate: Object.fromEntries(
        Object.entries(spent).map(([name, seconds]) => [
          name,
          Number((seconds / Math.max(rows.length, 1)).toFixed(4)),
        ]),
      ),
    };
  };

  await settled();
  await take();
  // One publication at a time: nothing but a title changes, and the next waits for paint.
  const idleBefore = await cpu(app);
  for (let index = 0; index < publishes; index++) {
    await command('rename-session', { title: `renamed ${index}` });
    await page.waitForFunction(
      () => window.__publishBenchmark.rows.length > 0,
      undefined,
      { polling: 5 },
    );
    await settled();
    await page.waitForTimeout(30);
  }
  const idleAfter = await cpu(app);
  const idle = report(await take(), cpuSpent(idleBefore, idleAfter));

  // A turn with tool calls, as fast as the runtime can publish them.
  const profiler = profilePath
    ? await page.context().newCDPSession(page)
    : undefined;
  if (profiler) {
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.start');
  }
  const turnBefore = await cpu(app);
  const started = Date.now();
  await command('prompt', { text: 'read the note' });
  await page
    .getByText('benchmark turn ended', { exact: true })
    .waitFor({ timeout: 180_000 });
  const finished = Date.now();
  await page.waitForFunction(
    () =>
      window.__publishBenchmark.rows.some((row) => row.kind === 'run_end') &&
      window.__publishBenchmark.rows.every((row) => row.done),
    undefined,
    { polling: 20 },
  );
  const turnAfter = await cpu(app);
  if (profiler)
    await writeFile(
      profilePath,
      JSON.stringify((await profiler.send('Profiler.stop')).profile),
    );
  const turn = report(await take(), cpuSpent(turnBefore, turnAfter));

  console.log(
    JSON.stringify(
      {
        benchmark: 'desktop runtime publication, native',
        sessions,
        messagesPerSession: messages,
        publishOneAtATime: idle,
        toolTurn: {
          toolCalls,
          promptToAnswerShownMs: finished - started,
          ...turn,
        },
        memoryMegabytes: Object.fromEntries(
          ['Utility', 'Browser', 'Tab'].map((type) => [
            { Utility: 'runtime', Browser: 'main', Tab: 'renderer' }[type],
            Math.round((turnAfter.memoryKb[type] ?? 0) / 1024),
          ]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
