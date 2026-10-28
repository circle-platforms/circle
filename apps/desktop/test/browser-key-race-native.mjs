// Exercise a browser shortcut while the renderer still holds the previous tab.
// The native session owns the authoritative active tab; closing the wrong tab
// loses the loaded page even though the tab count appears to be correct.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { listenForBrowser } from '../../../tests/browser-port.mjs';

if (process.env.CIRCLE_DESKTOP_EXECUTABLE) {
  console.log(
    'SKIP browser shortcut harness: packaged application uses popout',
  );
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-browser-key-race-'));
const output = join(root, 'artifacts/browser-key-race');
await mkdir(output, { recursive: true });
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(
    '<title>retained page</title><p id="fixture">retained bytes</p>',
  );
});
await listenForBrowser(server);
const url = `http://127.0.0.1:${server.address().port}/`;
const bundle = join(temp, 'browser.cjs');
await build({
  entryPoints: [join(root, 'src/browser.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: bundle,
});
const main = join(temp, 'main.cjs');
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(temp, 'data'))});
app.whenReady().then(async()=>{const window=new BrowserWindow({show:true,width:1000,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL('about:blank');const {BrowserSessions}=require(${JSON.stringify(bundle)});globalThis.browser=new BrowserSessions(window,()=>{},()=> 'en',undefined,new Map(),${JSON.stringify(join(temp, 'downloads'))});});
app.on('window-all-closed',()=>app.quit());`,
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
let failed = false;
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [main],
    cwd: root,
    env,
    chromiumSandbox: true,
  });
  await app.firstWindow();
  const result = await app.evaluate(async ({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows()[0];
    await browser.navigate('fixture', url);
    const stale = browser.state('fixture');
    const created = browser.tabs('fixture', 'new');
    const events = [];
    let prevented = false;
    browser.sendKey = (event) => events.push(event);
    browser.keys('fixture', true, window);
    browser.windowKey(
      { preventDefault: () => (prevented = true) },
      {
        type: 'keyDown',
        key: 'w',
        meta: process.platform === 'darwin',
        control: process.platform !== 'darwin',
        alt: false,
        shift: false,
      },
      window,
    );
    const event = events.at(-1);
    // This is the renderer's actual fallback if its last state still names the
    // old tab and the native key event did not identify its active tab.
    browser.tabs('fixture', 'close', event?.tab ?? stale.tab);
    const after = browser.state('fixture');
    const page = window.contentView.children.find(
      (view) =>
        !view.webContents.isDestroyed() && view.webContents.getURL() === url,
    );
    const text = page
      ? await page.webContents.executeJavaScript(
          'document.querySelector("#fixture")?.textContent',
        )
      : null;
    const next = browser.tabs('fixture', 'new');
    let activeClose;
    try {
      activeClose = { state: browser.tabs('fixture', 'close', undefined) };
    } catch (error) {
      activeClose = { error: String(error) };
    }
    return { stale, created, event, prevented, after, text, next, activeClose };
  }, url);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(result, null, 2),
  );
  assert.equal(result.created.tabs.length, 2);
  assert.notEqual(result.created.tab, result.stale.tab);
  assert.equal(result.prevented, true);
  assert.equal(result.event.action, 'close-tab');
  assert.equal(
    result.event.tab,
    result.created.tab,
    'close targets the active native tab',
  );
  assert.equal(result.after.tabs.length, 1);
  assert.equal(
    result.after.tab,
    result.stale.tab,
    'the loaded tab remains active',
  );
  assert.equal(result.after.url, url);
  assert.equal(result.text, 'retained bytes');
  assert.equal(result.next.tabs.length, 2);
  assert.equal(result.activeClose.error, undefined);
  assert.equal(result.activeClose.state.tabs.length, 1);
  assert.equal(result.activeClose.state.tab, result.stale.tab);
  assert.equal(result.activeClose.state.url, url);
  console.log(
    'PASS browser shortcut closes the active tab even when the renderer state is stale',
  );
} catch (error) {
  failed = true;
  console.error(`kept isolated data at ${temp}`);
  throw error;
} finally {
  await app?.evaluate(() => browser.close()).catch(() => {});
  await app?.close().catch(() => {});
  await new Promise((done) => server.close(done));
  if (!failed) await rm(temp, { recursive: true, force: true, maxRetries: 10 });
}
