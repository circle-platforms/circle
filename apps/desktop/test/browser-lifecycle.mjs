import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
if (process.env.CIRCLE_DESKTOP_EXECUTABLE) {
  console.log(
    'SKIP browser lifecycle harness: packaged application uses browser-live',
  );
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-browser-lifecycle-'));
const cookies = [];
const hits = [];
const server = createServer((req, res) => {
  if (req.url.startsWith('/hit')) {
    hits.push(req.url);
    res.end('yes');
    return;
  }
  cookies.push(req.headers.cookie ?? '');
  res.setHeader('Set-Cookie', 'fixture=kept; SameSite=Lax');
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/coordinates')
    res.end(
      '<title>coordinates</title><span id=missing style="display:inline-block;width:80px;height:30px">...</span><script>document.querySelector("#missing").addEventListener("click",()=>document.body.dataset.clicked="yes")</script>',
    );
  else if (req.url === '/hover')
    res.end(
      '<!doctype html><title>hover fixture</title><button style="margin:100px;width:220px;height:60px">Show details</button><script>const b=document.querySelector("button");b.addEventListener("mouseenter",()=>{b.textContent="Delete configuration";b.dataset.delete="yes"});b.addEventListener("click",()=>fetch("/hit-"+b.dataset.delete));</script>',
    );
  else if (req.url === '/scroll')
    res.end(
      '<!doctype html><title>nested scroll</title><style>#s{width:300px;height:100px;overflow:auto;margin:180px}button{display:block;height:100px;width:280px}</style><div id=s><button id=a>Open first</button><button id=b>Open second</button><button id=c>Other</button></div><script>for(const b of document.querySelectorAll("button"))b.onclick=()=>fetch("/hit-"+b.id);</script>',
    );
  else if (req.url === '/popup')
    res.end(
      '<title>popup</title><button onclick="window.close()">close this page</button>',
    );
  else
    res.end(
      '<title>opener</title><button onclick="window.open(\'/popup\')">open popup</button>',
    );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
globalThis.browserErrors=[];globalThis.browserEvents=[];
process.on('uncaughtException',error=>browserErrors.push(error.message));
app.whenReady().then(async()=>{const window=new BrowserWindow({show:true,width:1000,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL('about:blank');const {BrowserSessions}=require(${JSON.stringify(bundle)});globalThis.browser=new BrowserSessions(window,state=>browserEvents.push(state),()=> 'en',undefined,new Map(),${JSON.stringify(join(temp, 'downloads'))});});
app.on('window-all-closed',()=>app.quit());`,
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [main],
    cwd: root,
    env,
    chromiumSandbox: true,
  });
  await app.firstWindow();
  const run = (action, args = {}) =>
    app.evaluate(
      async (_, { action, args }) =>
        browser.agent(
          { id: 'check', sessionId: 'fixture', action, args },
          new AbortController().signal,
        ),
      { action, args },
    );
  await run('navigate', { url });
  await run('click', { ref: 'e1', element: 'open popup' });
  const before = await app.evaluate(() => browser.state('fixture'));
  assert.equal(before.tabs.length, 2);
  // A tab the person or Circle opened is not the page's to close: as in Chrome, only a
  // window a script opened may close itself. The tab above was opened by navigation, so a
  // window.close() in it must leave the tab strip untouched.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .contentView.children.find(
        (view) => view.webContents.getTitle() === 'opener',
      )
      .webContents.executeJavaScript('window.close()'),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    (await app.evaluate(() => browser.state('fixture'))).tabs.length,
    2,
    'a page cannot close a tab it did not open',
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .contentView.children.find(
        (view) => view.webContents.getTitle() === 'popup',
      )
      .webContents.executeJavaScript('window.close()'),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(
    await app.evaluate(() => browserErrors),
    [],
    'page self-close must not throw in the main process',
  );
  const after = await app.evaluate(() => browser.state('fixture'));
  assert.equal(after.tabs.length, 1);
  assert.equal(after.tab, 't1');
  const listed = await run('tabs', { action: 'list' });
  assert.match(listed.text, /tab t2 closed \(the page closed it\)/);
  assert.match((await run('navigate', { url })).text, /opener/);
  assert.ok(cookies.at(-1).includes('fixture=kept'));
  const events = await app.evaluate(() => browserEvents);
  assert.equal(events.at(-1).tabs.length, 1);
  console.log(
    'PASS native close rules: a page keeps a tab it did not open, closes its own popup, and Circle cleans up, publishes and goes on navigating',
  );
  await run('navigate', { url: url + 'coordinates' });
  const shown = await run('snapshot');
  assert.doesNotMatch(shown.text, /\[e\d+\].*"\.\.\."/);
  const point = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .contentView.children.find(
        (view) => view.webContents.getTitle() === 'coordinates',
      )
      .webContents.executeJavaScript(
        '(()=>{const r=document.querySelector("#missing").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
      ),
  );
  const shot = await run('screenshot');
  const args = { ...point, screenshotId: shot.screenshot.id };
  const asked = await run('click_at', args);
  assert.equal(asked.approval.kind, 'coordinate');
  await run('click_at', {
    ...args,
    approval: { token: asked.approval.token, scope: 'once' },
  });
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.find(
          (view) => view.webContents.getTitle() === 'coordinates',
        )
        .webContents.executeJavaScript('document.body.dataset.clicked'),
    ),
    'yes',
  );
  await assert.rejects(run('click_at', args), /screenshot is stale/);
  const stale = await run('screenshot');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .contentView.children.find(
        (view) => view.webContents.getTitle() === 'coordinates',
      )
      .webContents.executeJavaScript(
        'document.querySelector("#missing").textContent="new"',
      ),
  );
  await assert.rejects(
    run('click_at', { ...point, screenshotId: stale.screenshot.id }),
    /screenshot is stale/,
  );
  console.log(
    'PASS native coordinates: non-semantic hit, single approval, real DOM effect and stale rejection',
  );
  await run('navigate', { url: url + 'hover' });
  const hoverShot = await run('screenshot');
  const hoverPoint = { x: 218, y: 138 };
  await assert.rejects(
    run('click_at', { ...hoverPoint, screenshotId: hoverShot.screenshot.id }),
    /screenshot.*(?:stale|changed)/,
  );
  assert.deepEqual(hits, []);
  const nextShot = await run('screenshot');
  const hoverArgs = { ...hoverPoint, screenshotId: nextShot.screenshot.id };
  const hoverAsk = await run('click_at', hoverArgs);
  assert.equal(hoverAsk.approval.kind, 'coordinate');
  assert.equal(hoverAsk.approval.destructive, true);
  assert.equal(hoverAsk.approval.element, 'Delete configuration');
  assert.deepEqual(hits, []);
  await run('click_at', {
    ...hoverArgs,
    approval: { token: hoverAsk.approval.token, scope: 'once' },
  });
  assert.deepEqual(hits, ['/hit-yes']);
  console.log(
    'PASS native hover mutation: no mouse press before fresh screenshot and destructive approval',
  );
  await run('navigate', { url: url + 'scroll' });
  const scrollShot = await run('screenshot');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .contentView.children.find(
        (view) => view.webContents.getTitle() === 'nested scroll',
      )
      .webContents.executeJavaScript(
        'document.querySelector("#s").scrollTop=100',
      ),
  );
  await assert.rejects(
    run('click_at', { x: 328, y: 230, screenshotId: scrollShot.screenshot.id }),
    /screenshot is stale/,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(
    run('click_at', { x: 328, y: 230, screenshotId: scrollShot.screenshot.id }),
    /screenshot is stale/,
  );
  assert.deepEqual(hits, ['/hit-yes']);
  const afterScroll = await run('screenshot');
  await run('click_at', {
    x: 328,
    y: 230,
    screenshotId: afterScroll.screenshot.id,
  });
  assert.deepEqual(hits, ['/hit-yes', '/hit-b']);
  console.log(
    'PASS native nested scroll invalidates old capture, fresh capture clicks the shown target',
  );
} finally {
  if (app) await app.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
