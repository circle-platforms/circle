// A button whose tooltip is open can hide its still-mounted drawer on press,
// before the release produces a click. Opening the browser again must work in
// both the development app and the package people install.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { listenForBrowser } from '../../../tests/browser-port.mjs';
import { captureFailure, observePage } from './helpers/diagnostics.mjs';
import { patience } from './helpers/patience.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-popout-press-'));
const workspace = join(temp, 'project');
await mkdir(workspace);
const site = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(`<title>local page</title><h1>${request.url}</h1>`);
});
await listenForBrowser(site);
const address = `http://127.0.0.1:${site.address().port}/again`;
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_MODE: 'preview',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({ files: [], workspace }),
};
delete env.ELECTRON_RUN_AS_NODE;
const output = join(root, 'artifacts', 'popout-press');
await mkdir(output, { recursive: true });
const mode = process.env.CIRCLE_DESKTOP_EXECUTABLE ? 'packaged' : 'development';
const activation =
  process.env.CIRCLE_POPOUT_ACTIVATION === 'keyboard' ? 'keyboard' : 'pointer';
const until = async (check, label) => {
  const stop = Date.now() + patience(20000);
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= stop) throw Error(`timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 50));
  }
};
let app;
let main;
const errors = [];
try {
  app = await electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    chromiumSandbox: true,
    env,
    timeout: 60000,
  });
  main = await app.firstWindow();
  observePage(main, errors);
  main.setDefaultTimeout(patience(20000));
  await main.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const info = await main.evaluate(() => window.circleDesktop.info());
  assert.equal(info.dataPath, env.CIRCLE_WORKBENCH_DATA_DIR);
  assert.equal(info.frontendOnly, true);
  await main
    .getByRole('button', { name: 'browser panel', exact: true })
    .click();
  await main.locator('.native-browser').waitFor();
  const field = main.getByRole('textbox', { name: 'browser address' });
  await field.fill(address);
  await field.press('Enter');
  await until(async () => {
    const state = await main.evaluate(() =>
      window.circleDesktop.browserState('session1'),
    );
    return state.url === address && !state.loading;
  }, 'the local page is loaded in the drawer');

  const button = main
    .locator('.inspector .browser-address')
    .getByRole('button', { name: 'open in a window', exact: true });
  await button.hover();
  await main.getByRole('tooltip', { name: 'open in a window' }).waitFor();
  await main.mouse.down();
  await main.locator('.work-drawer').waitFor({ state: 'hidden' });
  await main.mouse.up();
  const popouts = () =>
    app.windows().filter((page) => page.url().includes('#/popout/browser/'));
  const first = await until(() => popouts()[0], 'the first browser window');
  await first.getByRole('button', { name: 'put back in the drawer' }).click();
  await until(() => popouts().length === 0, 'the first browser window closes');
  await main.locator('.work-drawer').waitFor({ state: 'visible' });
  await field.fill(address + '?again');
  await field.press('Enter');
  await until(async () => {
    const state = await main.evaluate(() =>
      window.circleDesktop.browserState('session1'),
    );
    return state.url === address + '?again' && !state.loading;
  }, 'the second local page is loaded');
  if (activation === 'keyboard') {
    await button.focus();
    await main.keyboard.press('Enter');
  } else {
    await button.click();
  }
  const second = await until(() => popouts()[0], 'the second browser window');
  assert.notEqual(second, first, 'the closed window was not reused');
  const state = await second.evaluate(() =>
    window.circleDesktop.browserState('session1'),
  );
  assert.equal(state.url, address + '?again');
  await second.getByRole('button', { name: 'put back in the drawer' }).click();
  await until(() => popouts().length === 0, 'the second browser window closes');
  await main.locator('.work-drawer').waitFor({ state: 'visible' });
  await writeFile(
    join(output, `${mode}-${activation}.json`),
    JSON.stringify({
      firstOpened: true,
      secondOpened: true,
      activation,
      url: state.url,
    }) + '\n',
  );
} catch (error) {
  await captureFailure(main, error, errors, output);
  let windows = [];
  let state = 'unavailable';
  try {
    windows = app?.windows().map((page) => page.url()) ?? [];
    let timer;
    try {
      state = await Promise.race([
        main?.evaluate(() => window.circleDesktop.browserState('session1')),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('unavailable'), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch (reason) {
    state = String(reason);
  }
  await writeFile(
    join(output, `${mode}-${activation}-failure.json`),
    JSON.stringify(
      { error: String(error?.stack ?? error), windows, state },
      null,
      2,
    ) + '\n',
  ).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  site.close();
  await rm(temp, { recursive: true, force: true });
}
