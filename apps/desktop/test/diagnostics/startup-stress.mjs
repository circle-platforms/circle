// Temporary diagnostics for 1.8.1: launch the packaged application again and
// again, as consecutive tests do, and record how far a window that stays
// blank got. Not part of any suite.
import { _electron as electron } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const runs = Number(process.env.STRESS_RUNS ?? 20);
const output = process.env.STRESS_OUTPUT ?? join(tmpdir(), 'startup-stress');
const results = [];
for (let run = 1; run <= runs; run++) {
  const temp = await mkdtemp(join(tmpdir(), 'circle-stress-'));
  const env = {
    ...process.env,
    CIRCLE_HOME: join(temp, 'home'),
    CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
    CIRCLE_WORKBENCH_MODE: 'live',
    CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
    CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
    CIRCLE_NO_UPDATE_CHECK: '1',
    CIRCLE_NO_MODELS_REFRESH: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const row = { run };
  const logs = [];
  let app;
  try {
    app = await electron.launch({
      executablePath:
        process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
      args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
      cwd: root,
      env,
      chromiumSandbox: true,
      timeout: 60000,
    });
    const child = app.process();
    child.stdout?.on('data', (data) => logs.push(['out', String(data)]));
    child.stderr?.on('data', (data) => logs.push(['err', String(data)]));
    const page = await app.firstWindow();
    row.window = Date.now() - started;
    const deadline = Date.now() + 90000;
    for (;;) {
      const probe = await page
        .evaluate(() => ({
          readyState: document.readyState,
          boot: document.documentElement.dataset.boot ?? null,
          rootChildren: document.getElementById('root')?.childElementCount,
          files: [
            ...Array.from(document.scripts, (node) => node.src),
            ...Array.from(
              document.querySelectorAll('link[href]'),
              (n) => n.href,
            ),
          ].map((url) => url.split('/').pop()),
          loaded: performance
            .getEntriesByType('resource')
            .map((entry) => [
              entry.name.split('/').pop(),
              Math.round(entry.duration),
            ]),
        }))
        .catch((error) => ({ error: String(error) }));
      if (probe.rootChildren > 0) {
        row.rendered = Date.now() - started;
        row.boot = probe.boot;
        break;
      }
      if (Date.now() > deadline) {
        row.stalled = probe;
        row.logs = logs.slice(-40);
        break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
  } catch (error) {
    row.error = String(error);
    row.logs = logs.slice(-40);
  } finally {
    await app?.close().catch(() => {});
  }
  results.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(output + '.json', JSON.stringify(results, null, 2));
const slow = results.filter((row) => !row.rendered || row.rendered > 30000);
console.log(
  JSON.stringify({
    runs,
    stalls: slow.length,
    renderedMs: results.map((row) => row.rendered ?? null),
  }),
);
