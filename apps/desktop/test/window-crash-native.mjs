import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
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
const logText = () => readFile(log, 'utf8').catch(() => '');
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
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CIRCLE_DESKTOP_RUNTIME_FIXTURE;
let application;
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
  let printed = '';
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
    application.evaluate(
      ({ BrowserWindow }, source) =>
        new Function('contents', `return ${source}`)(
          BrowserWindow.getAllWindows()[0].webContents,
        ),
      code,
    );
  // One real sample, with the real process list: a wrong pid or unit shows here.
  await new Promise((done) => setTimeout(done, 31000));
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
  assert.ok(Number(named[3]) >= 30, entry);
  const taken = /window (\d+) MB, all (\d+) MB/.exec(entry);
  assert.ok(taken, entry);
  assert.ok(Number(taken[1]) > 20 && Number(taken[1]) < 4096, entry);
  assert.ok(Number(taken[2]) >= Number(taken[1]), entry);
  assert.equal(await inMain('contents.isCrashed()'), true);

  // The runtime goes on and says so; a crashed window hears nothing and prints nothing.
  const runtimePid = first.snapshot.runtime.processId;
  assert.ok(Number.isSafeInteger(runtimePid) && runtimePid !== process.pid);
  process.kill(runtimePid, 'SIGKILL');
  await until(
    async () => (await logText()).includes('runtime stopped'),
    'the runtime to stop',
  );
  await new Promise((done) => setTimeout(done, 1000));
  assert.doesNotMatch(printed, /Render frame was disposed/);

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
  console.log('window crash: logged, quiet, reloaded');
} catch (error) {
  console.error(await logText());
  throw error;
} finally {
  await application?.close().catch(() => {});
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}
