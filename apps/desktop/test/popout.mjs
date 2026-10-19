// The browser and the terminal in windows of their own, in the running window: the
// pop-out and put-back buttons, the page that moves with its window and back, the button
// that brings a window forward, and the windows that close when another conversation is shown.
// The development app; the packaged one is covered by the live checks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
if (
  process.env.CIRCLE_DESKTOP_EXECUTABLE ||
  (process.getuid?.() === 0 && !process.env.DISPLAY_WRAPPER)
) {
  console.log('SKIP popout harness: needs a desktop-capable session');
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-popout-'));
const dataDir = join(temp, 'data');
await mkdir(join(dataDir, 'runtime-home'), { recursive: true });
const workspace = join(temp, 'project');
await mkdir(workspace, { recursive: true });
// A page to show: the browser only reaches http and https.
const site = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(
    '<!doctype html><title>pop</title><h1 id="mark">popped page</h1>',
  );
});
await new Promise((done) => site.listen(0, '127.0.0.1', done));
const address = `127.0.0.1:${site.address().port}`;
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: dataDir,
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_MODE: 'preview',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
    files: [],
    workspace,
    exportPath: join(temp, 'export.md'),
  }),
};
delete env.ELECTRON_RUN_AS_NODE;
const until = async (check, what, ms = 20000) => {
  const stop = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= stop) throw Error(`timed out: ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
};
let app;
try {
  app = await electron.launch({
    executablePath: require('electron'),
    chromiumSandbox: true,
    args: [join(root, 'dist', 'main.cjs')],
    env,
    timeout: 60000,
  });
  const main = await app.firstWindow();
  await main.waitForFunction(() => !!window.circleDesktop, null, {
    timeout: 30000,
  });
  await main.locator('.topbar').waitFor({ timeout: 30000 });
  await main.setViewportSize?.({ width: 1500, height: 900 });
  const titles = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((one) => one.getTitle()),
    );
  const views = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(
        (one) => one.contentView.children.length,
      ),
    );
  const windowsOf = async (hash) =>
    app.windows().filter((one) => one.url().includes(hash));

  // ---- the browser leaves the drawer
  await main
    .getByRole('button', { name: 'browser panel', exact: true })
    .click();
  await main.locator('.native-browser').waitFor();
  await main
    .locator('.inspector .browser-address')
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  const popped = await until(
    async () => (await windowsOf('#/popout/browser/'))[0],
    'the browser window',
  );
  await popped.locator('.native-browser').waitFor();
  assert.equal(
    await popped
      .getByRole('button', { name: 'put back in the drawer' })
      .count(),
    1,
  );
  assert.equal(
    await popped.getByRole('button', { name: 'full view' }).count(),
    0,
    'a window of its own has no full view',
  );
  assert.ok((await titles()).some((title) => title.startsWith('browser · ')));
  // The drawer let go of the mode, and its button is marked.
  await main.locator('.work-drawer').waitFor({ state: 'hidden' });
  await main.locator('.drawer-mode-button.popped').waitFor();

  // A page opened in the window is in that window.
  await popped.getByRole('textbox', { name: 'browser address' }).fill(address);
  await popped.getByRole('textbox', { name: 'browser address' }).press('Enter');
  await until(async () => (await views())[1] >= 1, 'the page in the popout');
  assert.equal(
    (await views())[0],
    0,
    'the page left the main window with the browser',
  );

  // The button of a popped mode brings its window forward instead of opening the drawer.
  await main.getByRole('button', { name: /browser panel/ }).click();
  assert.equal(await main.locator('.work-drawer').isVisible(), false);
  assert.equal(
    (await windowsOf('#/popout/browser/')).length,
    1,
    'no second window',
  );

  // Back into the drawer: the window goes, the page comes along.
  await popped.getByRole('button', { name: 'put back in the drawer' }).click();
  await until(
    async () => (await windowsOf('#/popout/browser/')).length === 0,
    'the window closes',
  );
  await until(async () => (await views()).length === 1, 'one window left');
  assert.equal(
    (await views())[0] >= 1,
    true,
    'the page is back in the main window',
  );
  await main
    .locator('.drawer-mode-button.popped')
    .waitFor({ state: 'detached' });

  // ---- the terminal, and a conversation switch that brings it back
  await main
    .getByRole('button', { name: 'terminal panel', exact: true })
    .click();
  await main.locator('.term-tabbar').waitFor();
  await main
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  const terminal = await until(
    async () => (await windowsOf('#/popout/terminal/'))[0],
    'the terminal window',
  );
  await terminal.locator('.term-tabbar').waitFor();
  await main.locator('.drawer-mode-button.popped').waitFor();
  const rows = main.locator('.sidebar .session-row');
  const at = await rows.count();
  assert.ok(at > 1, 'a second conversation to switch to');
  // Show another conversation: its windows are not shown, they come back.
  const here = await main.evaluate(() => location.hash);
  for (let index = 0; index < at; index++) {
    await rows.nth(index).click();
    if ((await main.evaluate(() => location.hash)) !== here) break;
  }
  await until(
    async () => (await windowsOf('#/popout/terminal/')).length === 0,
    'the terminal window closes with the conversation',
  );
  console.log('popout: ok');
} finally {
  await app?.close().catch(() => {});
  site.close();
  await rm(temp, { recursive: true, force: true });
}
