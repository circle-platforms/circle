import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { patience } from './helpers/patience.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-window-crash-'));
const dataDir = join(temp, 'data');
const home = join(dataDir, 'runtime-home');
await mkdir(join(home, 'cache'), { recursive: true });
await writeFile(
  join(home, 'cache', 'models-dev.json'),
  JSON.stringify({ schema: 'circle.models-dev/v1', providers: {} }),
);
const log = join(dataDir, 'logs', 'runtime.log');
const snapshotFile = join(dataDir, 'logs', 'window-samples.json');
const logText = () => readFile(log, 'utf8').catch(() => '');
const snapshotData = () =>
  readFile(snapshotFile, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);
const until = async (check, what, limit = patience(20000)) => {
  const deadline = Date.now() + limit;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
};
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: dataDir,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_WORKBENCH_BACKGROUND_TEST: '1',
  CIRCLE_WORKBENCH_WINDOW_SAMPLE_MS: '250',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CIRCLE_DESKTOP_RUNTIME_FIXTURE;
let application;
let printed = '';
try {
  application = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 45000,
  });
  application.process().stderr?.on('data', (chunk) => {
    printed += chunk;
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(patience(12000));
  const runtime = () =>
    page.evaluate(async () => await window.circleDesktop.runtimeState());
  const first = await until(async () => {
    const state = await runtime();
    return state.connected ? state : undefined;
  }, 'the runtime');
  const inMain = (code) =>
    application.evaluate(({ BrowserWindow }, source) => {
      const main =
        BrowserWindow.getAllWindows().find(
          (w) => !w.webContents.getURL().includes('#/popout/'),
        ) ?? BrowserWindow.getAllWindows()[0];
      return new Function('contents', `return ${source}`)(main.webContents);
    }, code);
  await page.waitForLoadState('load');
  await page.waitForFunction(
    () => document.readyState === 'complete' && !!window.circleDesktop,
  );
  await until(
    () => inMain('!contents.isLoading() && !contents.isLoadingMainFrame()'),
    'the main window load to complete',
  );
  // Wait for rolling disk snapshot completion signal instead of a fixed 31s sleep.
  const mainSample = await until(async () => {
    const snap = await snapshotData();
    const entries = snap?.windows ? Object.values(snap.windows) : [];
    return entries.find(
      (w) =>
        w.name === 'main' &&
        w.pid > 0 &&
        w.samples.some(
          (s) => s.windowMb > 20 && (s.renderer?.jsHeapMb ?? 0) > 0,
        ),
    );
  }, 'the main window snapshot on disk');
  assert.ok(mainSample.pid > 0);

  // F12: a second launch that exits on single-instance lock must NOT rotate/clobber window-samples.previous.json.
  const previousFile = join(dataDir, 'logs', 'window-samples.previous.json');
  const sentinelPayload = JSON.stringify({ sentinel: 'keep-previous' });
  await writeFile(previousFile, sentinelPayload);
  const secondLaunch = spawn(
    process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let secondStderr = '';
  secondLaunch.stderr?.on('data', (chunk) => {
    secondStderr += chunk;
  });
  const secondExit = await Promise.race([
    once(secondLaunch, 'exit'),
    new Promise((_, reject) =>
      setTimeout(() => {
        secondLaunch.kill('SIGKILL');
        reject(new Error(`second launch timed out: ${secondStderr}`));
      }, 20000),
    ),
  ]);
  assert.equal(secondExit[0], 0, secondStderr);
  assert.equal(secondExit[1], null, secondStderr);
  assert.equal(
    await readFile(previousFile, 'utf8'),
    sentinelPayload,
    'second launch must not overwrite window-samples.previous.json',
  );
  assert.ok(
    await snapshotData(),
    'primary window-samples.json must remain intact after second launch exit',
  );

  await inMain('contents.forcefullyCrashRenderer()');
  const entry = await until(async () => {
    const text = await logText();
    return text.includes('window main renderer gone') ? text : undefined;
  }, 'the crash in the log');
  const named =
    /window main renderer gone: reason (\S+), exit code (-?\d+), (\d+) s after opening, highest (\d+) MB/.exec(
      entry,
    );
  assert.ok(named, entry);
  assert.ok(Number(named[3]) >= 0, entry);
  assert.ok(Number(named[4]) > 20 && Number(named[4]) < 4096, entry);
  const taken = /window (\d+) MB, all (\d+) MB/.exec(entry);
  assert.ok(taken, entry);
  assert.ok(Number(taken[1]) > 20 && Number(taken[1]) < 4096, entry);
  assert.ok(Number(taken[2]) >= Number(taken[1]), entry);
  assert.match(entry, /heap \d+\/\d+ MB, blink \d+ MB/);
  assert.equal(await inMain('contents.isCrashed()'), true);

  // The runtime goes on and says so; broadcasting while a renderer is crashed does not throw or crash main.
  const runtimePid = first.snapshot.runtime.processId;
  assert.ok(Number.isSafeInteger(runtimePid) && runtimePid !== process.pid);
  process.kill(runtimePid, 'SIGKILL');
  await until(
    async () => (await logText()).includes('runtime stopped'),
    'the runtime to stop',
  );

  await inMain('contents.reload()');
  await until(async () => {
    if (await inMain('contents.isCrashed()')) return false;
    return inMain(
      `contents.executeJavaScript("document.readyState === 'complete' && !!window.circleDesktop")`,
    ).catch(() => false);
  }, 'the window to come back');
  const info = await inMain(
    'contents.executeJavaScript("window.circleDesktop.info()")',
  );
  assert.equal(info.frontendOnly, false);

  // C24c + C14: popout crash isolates telemetry and reloads via Reload Window menu action.
  const sessionId = first.snapshot.activeSessionId;
  await inMain(
    `contents.executeJavaScript(${JSON.stringify(`window.circleDesktop.popoutOpen('terminal', ${JSON.stringify(sessionId)}, 'Terminal')`)})`,
  );
  await until(
    () =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) =>
          w.webContents.getURL().includes('#/popout/'),
        ),
      ),
    'popout window to open',
  );
  await until(
    () =>
      application.evaluate(async ({ BrowserWindow }) => {
        const popout = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('#/popout/'),
        );
        if (
          !popout ||
          popout.webContents.isLoading() ||
          popout.webContents.isLoadingMainFrame()
        )
          return false;
        return await popout.webContents
          .executeJavaScript(
            "document.readyState === 'complete' && !!window.circleDesktop",
          )
          .catch(() => false);
      }),
    'popout window load to complete',
  );
  const popoutSample = await until(async () => {
    const snap = await snapshotData();
    const entries = snap?.windows ? Object.values(snap.windows) : [];
    return entries.find(
      (w) =>
        w.name === 'popout' &&
        w.pid > 0 &&
        (w.samples.at(-1)?.windowMb ?? 0) > 20,
    );
  }, 'popout window snapshot on disk');
  assert.ok(popoutSample.samples.at(-1).windowMb > 20);
  const mainBeforePopoutCrash = await until(async () => {
    const snap = await snapshotData();
    const entries = snap?.windows ? Object.values(snap.windows) : [];
    const main = entries.find(
      (w) =>
        w.name === 'main' &&
        w.pid > 0 &&
        w.samples.some((s) => s.windowMb > 20),
    );
    return main;
  }, 'reloaded main window snapshot before popout crash');
  await application.evaluate(({ BrowserWindow }) => {
    const popout = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('#/popout/'),
    );
    if (!popout) throw new Error('popout window missing');
    popout.webContents.forcefullyCrashRenderer();
  });
  await until(
    async () => (await logText()).includes('window popout renderer gone'),
    'popout crash in log',
  );
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => {
      const popout = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('#/popout/'),
      );
      return Boolean(popout?.webContents.isCrashed());
    }),
    true,
  );
  // Main window remains alive and its diagnostics stay isolated from the crashed popout.
  assert.equal(
    await inMain('!contents.isDestroyed() && !contents.isCrashed()'),
    true,
    'main window must remain alive when popout crashes',
  );
  const mainSampleAfterCrash = await until(async () => {
    const snap = await snapshotData();
    const entries = snap?.windows ? Object.values(snap.windows) : [];
    const main = entries.find((w) => w.name === 'main');
    if (!main || main.pid !== mainBeforePopoutCrash.pid) return undefined;
    const latest = main.samples.at(-1);
    return latest &&
      latest.at > mainBeforePopoutCrash.samples.at(-1).at &&
      latest.windowMb > 20
      ? main
      : undefined;
  }, 'main window diagnostics sample after popout crash');
  assert.equal(mainSampleAfterCrash.pid, mainBeforePopoutCrash.pid);
  assert.doesNotMatch(
    await logText(),
    /window main renderer gone.*window main renderer gone/s,
    'popout crash must not emit a duplicate main crash log',
  );
  await application.evaluate(({ BrowserWindow, Menu }) => {
    const popout = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('#/popout/'),
    );
    const menu = Menu.getApplicationMenu();
    const reloadItem = menu?.items
      .flatMap((top) => top.submenu?.items ?? [])
      .find((item) => item.accelerator === 'CmdOrCtrl+Shift+R');
    if (!reloadItem || !popout)
      throw new Error('reload menu item or popout not found');
    reloadItem.click(reloadItem, popout, {});
  });
  await until(async () => {
    return await application
      .evaluate(async ({ BrowserWindow }) => {
        const popout = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('#/popout/'),
        );
        if (!popout || popout.webContents.isCrashed()) return false;
        return await popout.webContents
          .executeJavaScript(
            "document.readyState === 'complete' && !!window.circleDesktop",
          )
          .catch(() => false);
      })
      .catch(() => false);
  }, 'crashed popout window to reload');
  assert.doesNotMatch(printed, /Render frame was disposed/);

  // T4: prove main.ts checkSender rejects an untrusted BrowserWindow calling ipcMain.handle('circle:info').
  const untrustedRejection = await application.evaluate(
    async ({ app, BrowserWindow }) => {
      const sep = process.platform === 'win32' ? '\\' : '/';
      const untrusted = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: `${app.getAppPath()}${sep}dist${sep}preload.cjs`,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      try {
        await untrusted.loadURL(
          'data:text/html,<!doctype html><title>untrusted</title>',
        );
        try {
          await untrusted.webContents.executeJavaScript(
            'window.circleDesktop.info()',
          );
          return { rejected: false, message: 'unexpectedly succeeded' };
        } catch (error) {
          return {
            rejected: true,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      } finally {
        if (!untrusted.isDestroyed()) untrusted.destroy();
      }
    },
  );
  assert.equal(
    untrustedRejection.rejected,
    true,
    `expected untrusted IPC rejection, got: ${untrustedRejection.message}`,
  );
  assert.match(untrustedRejection.message, /untrusted IPC sender/);

  console.log('window crash: logged, isolated, popout reloaded');
} catch (error) {
  console.error('window-crash-native failed:', error, {
    exitCode: application?.process()?.exitCode,
    signalCode: application?.process()?.signalCode,
    stderr: printed,
  });
  console.error(await logText());
  throw error;
} finally {
  if (application) {
    await Promise.race([
      application.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    try {
      application.process()?.kill('SIGKILL');
    } catch {}
  }
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}
