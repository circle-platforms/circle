// Diagnostic only (issue #124): records when the main window first produces animation
// frames, relative to the production show lifecycle, under the current display.
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const appPath = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root);
const require = createRequire(import.meta.url);
const label = process.env.PROBE_LABEL ?? 'probe';
const iterations = Number(process.env.PROBE_ITERATIONS ?? 1);
// harness: show the window if production has not yet (as desktop.mjs does)
// production: never show it from the harness
const showMode = process.env.PROBE_SHOW ?? 'harness';
const output = join(root, '../../outputs/frames-124');
await mkdir(output, { recursive: true });

async function once(iteration) {
  const temp = await mkdtemp(join(tmpdir(), 'circle-frames-'));
  const workspace = join(temp, 'project');
  await mkdir(workspace);
  const env = {
    ...process.env,
    CIRCLE_HOME: join(temp, 'home'),
    CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
    CIRCLE_NO_UPDATE_CHECK: '1',
    CIRCLE_NO_MODELS_REFRESH: '1',
    CIRCLE_WORKBENCH_MODE: 'preview',
    CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
      files: [],
      workspace,
      exportPath: join(temp, 'export.md'),
    }),
    ELECTRON_ENABLE_LOGGING: '1',
    ELECTRON_LOG_FILE: join(temp, 'chromium.log'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.PROBE_DROP_CACHES) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('bash', ['-c', process.env.PROBE_DROP_CACHES], {
      stdio: 'inherit',
    });
  }
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const record = { label, iteration, showMode, timeline: [], stderr: [] };
  const mark = (name, extra) => record.timeline.push({ name, at: at(), ...extra });
  let app;
  try {
    app = await electron.launch({
      chromiumSandbox: true,
      executablePath:
        process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
      args: [appPath],
      cwd: root,
      env,
      timeout: 60000,
    });
    mark('launched');
    let stacking = Boolean(process.env.PROBE_STACKS) && iteration === 0;
    record.stacks = [];
    const stacker = (async () => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const sampled = new Map();
      while (stacking) {
        let pids = [];
        try {
          pids = (
            await run('pgrep', ['-f', '--', '--type=gpu-process'], {
              encoding: 'utf8',
            })
          ).stdout
            .split('\n')
            .filter(Boolean);
        } catch {}
        for (const pid of pids) {
          const count = sampled.get(pid) ?? 0;
          if (count >= 3) continue;
          sampled.set(pid, count + 1);
          let text;
          try {
            text = (
              await run(
                'sudo',
                ['gdb', '-batch', '-nx', '-p', pid, '-ex', 'set pagination off', '-ex', 'thread apply all bt 30'],
                { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 24 },
              )
            ).stdout;
          } catch (error) {
            text = String(error.stdout ?? '') + String(error.stderr ?? error);
          }
          record.stacks.push({
            at: at(),
            pid,
            text: text
              .split('\n')
              .filter((line) => /^#|^Thread /.test(line))
              .slice(0, 300),
          });
        }
        await new Promise((r) => setTimeout(r, 700));
      }
    })();
    app.process().stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n'))
        if (line.trim() && record.stderr.length < 400)
          record.stderr.push(at() + ' ' + line.slice(0, 400));
    });
    await app.evaluate(
      ({ app, BrowserWindow }, t0) => {
        const events = (globalThis.__probeEvents = []);
        const log = (name, extra) =>
          events.push({ name, at: Date.now() - t0, ...extra });
        const watch = (w) => {
          log('window', {
            id: w.id,
            visible: w.isVisible(),
            bounds: w.getBounds(),
            content: w.getContentSize(),
          });
          w.on('ready-to-show', () =>
            log('ready-to-show', {
              visible: w.isVisible(),
              content: w.getContentSize(),
            }),
          );
          w.on('show', () => log('show', { content: w.getContentSize() }));
          w.on('resize', () => log('resize', { content: w.getContentSize() }));
          w.webContents.on('dom-ready', () => log('dom-ready'));
          w.webContents.on('did-finish-load', () => log('did-finish-load'));
          w.webContents.on('unresponsive', () => log('unresponsive'));
          w.webContents.on('responsive', () => log('responsive'));
        };
        BrowserWindow.getAllWindows().forEach(watch);
        app.on('browser-window-created', (_event, w) => watch(w));
        app.on('child-process-gone', (_event, details) =>
          log('child-process-gone', details),
        );
        app.on('render-process-gone', (_event, _contents, details) =>
          log('render-process-gone', details),
        );
        app.on('gpu-info-update', () => log('gpu-info-update'));
        const seen = new Set();
        const poll = setInterval(() => {
          for (const metric of app.getAppMetrics())
            if (!seen.has(metric.pid)) {
              seen.add(metric.pid);
              log('process', {
                type: metric.type,
                pid: metric.pid,
                created: metric.creationTime - t0,
              });
            }
        }, 50);
        setTimeout(() => clearInterval(poll), 60000);
      },
      t0,
    );
    mark('hooked');
    const page = await app.firstWindow();
    mark('first-window');
    await page.waitForURL(/^circle:\/\/workbench/, { timeout: 30000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    mark('document');
    await page.evaluate(() => {
      const frames = (window.__frames = {
        count: 0,
        first: null,
        last: null,
        visibility: [[Date.now(), document.visibilityState]],
      });
      document.addEventListener('visibilitychange', () =>
        frames.visibility.push([Date.now(), document.visibilityState]),
      );
      const tick = () => {
        frames.count++;
        frames.first ??= Date.now();
        frames.last = Date.now();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    mark('frame-counter');
    const frameState = () =>
      page.evaluate(() => ({
        count: window.__frames?.count,
        first: window.__frames?.first,
        last: window.__frames?.last,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        innerWidth,
        innerHeight,
      }));
    const nativeVisible = () =>
      app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        return {
          visible: w.isVisible(),
          content: w.getContentSize(),
          bounds: w.getBounds(),
        };
      });
    await page
      .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
      .waitFor({ timeout: 30000 });
    mark('heading', { native: await nativeVisible(), frames: await frameState() });
    if (showMode === 'harness' && !(await nativeVisible()).visible) {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].show(),
      );
      mark('harness-show');
    }
    const samples = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          samples.push({
            at: at(),
            native: (await nativeVisible()).visible,
            frames: await frameState(),
          });
        } catch (error) {
          samples.push({ at: at(), error: String(error).slice(0, 200) });
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    const trialStart = at();
    record.trial = await page
      .getByRole('button', { name: 'browser panel', exact: true })
      .click({ trial: true, timeout: 10000 })
      .then(
        () => ({ ok: true, ms: at() - trialStart }),
        (error) => ({
          ok: false,
          ms: at() - trialStart,
          error: String(error).slice(0, 600),
        }),
      );
    mark('trial-done', { ok: record.trial.ok });
    stacking = false;
    await stacker;
    // Keep watching after a stalled trial: does it ever recover, and on what event?
    const watchUntil = at() + (record.trial.ok ? 1000 : 20000);
    while (at() < watchUntil) {
      const state = await frameState().catch(() => undefined);
      if (record.trial.ok || (state && state.count > 5)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const shotStart = at();
    record.screenshot = await page
      .screenshot({ timeout: 5000 })
      .then(
        (png) => ({ ok: true, ms: at() - shotStart, bytes: png.length }),
        (error) => ({
          ok: false,
          ms: at() - shotStart,
          error: String(error).slice(0, 200),
        }),
      );
    sampling = false;
    await sampler;
    record.samples = samples.filter(
      (s, i) =>
        i === 0 ||
        i === samples.length - 1 ||
        JSON.stringify([s.native, s.frames?.count > 0, s.frames?.visibility]) !==
          JSON.stringify([
            samples[i - 1].native,
            samples[i - 1].frames?.count > 0,
            samples[i - 1].frames?.visibility,
          ]),
    );
    record.finalFrames = await frameState().catch((e) => String(e));
    record.main = await app.evaluate(async ({ app }) => ({
      events: globalThis.__probeEvents,
      gpuFeatureStatus: app.getGPUFeatureStatus(),
      processes: app.getAppMetrics().map((m) => m.type),
      gpuInfo: await Promise.race([
        app.getGPUInfo('basic').then(
          (info) => ({
            gpuDevice: info.gpuDevice,
            auxAttributes: info.auxAttributes && {
              glRenderer: info.auxAttributes.glRenderer,
              glImplementationParts: info.auxAttributes.glImplementationParts,
              softwareRendering: info.auxAttributes.softwareRendering,
            },
          }),
          (error) => 'gpu info unavailable: ' + String(error),
        ),
        new Promise((r) => setTimeout(() => r('gpu info timed out'), 3000)),
      ]),
    }));
    record.firstFrameAfterHeadingMs =
      record.finalFrames?.first != null
        ? record.finalFrames.first -
          t0 -
          record.timeline.find((e) => e.name === 'heading').at
        : null;
  } catch (error) {
    record.error = String(error).slice(0, 1000);
  } finally {
    record.total = at();
    record.launchedAtEpoch = t0;
    if (app) await app.close().catch(() => {});
    try {
      const { readFile } = await import('node:fs/promises');
      record.chromiumLog = (await readFile(join(temp, 'chromium.log'), 'utf8'))
        .split('\n')
        .filter((line) => line.trim())
        .slice(0, 300);
    } catch (error) {
      record.chromiumLog = String(error);
    }
    await rm(temp, { recursive: true, force: true });
  }
  const summary = {
    label,
    iteration,
    showMode,
    trial: record.trial,
    screenshot: record.screenshot,
    heading: record.timeline.find((e) => e.name === 'heading'),
    harnessShow: record.timeline.some((e) => e.name === 'harness-show'),
    firstFrameAfterHeadingMs: record.firstFrameAfterHeadingMs,
    readyToShow: record.main?.events.find((e) => e.name === 'ready-to-show'),
    show: record.main?.events.find((e) => e.name === 'show'),
    gpuProcesses: record.main?.events.filter(
      (e) => e.name === 'process' && e.type === 'GPU',
    ),
    gone: record.main?.events.filter((e) => e.name === 'child-process-gone'),
    error: record.error,
  };
  console.log('FRAMES ' + JSON.stringify(summary));
  await writeFile(
    join(output, `${label}-${iteration}.json`),
    JSON.stringify(record, null, 2) + '\n',
  );
  return summary;
}

const results = [];
for (let i = 0; i < iterations; i++) results.push(await once(i));
console.log(
  'FRAMES-SUMMARY ' +
    JSON.stringify({
      label,
      iterations,
      stalled: results.filter((r) => r.trial && !r.trial.ok).length,
      harnessShow: results.filter((r) => r.harnessShow).length,
    }),
);
