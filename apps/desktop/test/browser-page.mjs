import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

// The check runs its own main script, which only the development Electron runs: a
// packaged application starts itself. The page script is the same in both.
if (process.env.CIRCLE_DESKTOP_EXECUTABLE) {
  console.log(
    'SKIP browser page: it runs with the development Electron; the packaged app runs browser-live',
  );
  process.exit(0);
}
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = join(root, '../../outputs/browser-regressions');
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-browser-page-'));
const source = await build({
  entryPoints: [join(root, '../../src/browser/page.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'CirclePage',
  target: 'chrome144',
});
const script = source.outputFiles[0].text;
const other = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<button>cross origin secret</button>');
});
await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/refs') {
    res.end(`<!doctype html><title>ref rules</title>
      <style>.card{cursor:pointer}</style>
      <p><a href="#a"><span>nested</span> <b>link</b></a></p>
      <div class="card" onclick="document.title='card'"><h3>card title</h3><p>card <span>body</span></p></div>
      <div tabindex="-1"><p>focus target only</p></div>
      <div tabindex="0">keyboard widget</div>
      <label>secret<input id="secret" type="password"></label>
      <button id="first">first</button>`);
    return;
  }
  if (req.url === '/frame') {
    res.end(
      '<!doctype html><label>frame username<input></label><button>frame submit</button>',
    );
    return;
  }
  res.end(`<!doctype html><title>browser page safety</title>
    <style>body{font:16px sans-serif} iframe{width:350px;height:110px} #blocked{position:relative;width:130px;height:40px} #cover{position:absolute;inset:0}</style>
    <h1>visible heading</h1>
    <div style="display:contents"><button>contents action</button></div>
    <div style="opacity:0"><button>opacity secret</button><input value="invisible value"></div>
    <div hidden><button>hidden secret</button></div>
    <input type="hidden" value="hidden input secret">
    <label>username<input id="username" value="old username"></label>
    <label>password<input id="password" type="password" value="password-value-must-never-appear"></label>
    <input id="number" type="number" aria-label="number field" value="12">
    <input readonly aria-label="read only field" value="fixed">
    <fieldset disabled><input aria-label="disabled field"></fieldset>
    <select aria-label="target"><option value="one">one</option><optgroup label="unavailable" disabled><option value="two">two</option></optgroup></select>
    <table><tr><th>name</th><th>state</th></tr><tr><td>alice</td><td><button>table action</button></td></tr></table>
    <div id="shadow"><span slot="label">assigned slot text</span><span slot="wrapped">wrapped child</span></div>
    <iframe src="/frame"></iframe>
    <iframe src="http://127.0.0.1:${other.address().port}/"></iframe>
    <div id="blocked"><button style="width:100%;height:100%">blocked action</button><div id="cover" aria-label="covering panel"></div></div>
    <script>
      const shadow = document.querySelector('#shadow').attachShadow({mode:'open'});
      shadow.innerHTML = 'direct shadow text<slot name="label"></slot><div role="button" aria-label="slotted action" onclick="window.slottedClicked=true"><slot name="wrapped"></slot></div><span id="label">shadow username</span><input aria-labelledby="label"><button>shadow action</button>';
      window.circleBrowser = {refs: new Map(), x: 9999, y: 9999};
    </script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const main = join(temp, 'main.cjs');
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');
  app.setPath('userData', ${JSON.stringify(join(temp, 'data'))});
  app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await window.loadURL(${JSON.stringify(url)});});
  app.on('window-all-closed',()=>app.quit());`,
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
let cdp;
let navigation = 0;
const started = Date.now();
const metadata = [];
const record = (value) => {
  metadata.push({ at: Date.now() - started, ...value });
  if (metadata.length > 200) metadata.shift();
};
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [main],
    env,
    cwd: root,
    chromiumSandbox: true,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('load');
  cdp = await page.context().newCDPSession(page);
  for (const method of [
    'Runtime.executionContextsCleared',
    'Page.loadEventFired',
  ])
    cdp.on(method, () => record({ kind: 'event', method }));
  cdp.on('Runtime.executionContextCreated', ({ context }) =>
    record({
      kind: 'event',
      method: 'Runtime.executionContextCreated',
      context: context.id,
      frame: context.auxData?.frameId,
      isDefault: context.auxData?.isDefault,
    }),
  );
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) =>
    record({
      kind: 'event',
      method: 'Runtime.executionContextDestroyed',
      context: executionContextId,
    }),
  );
  cdp.on('Page.frameNavigated', ({ frame }) => {
    if (!frame.parentId) navigation++;
    record({
      kind: 'event',
      method: 'Page.frameNavigated',
      frame: frame.id,
      loader: frame.loaderId,
      main: !frame.parentId,
    });
  });
  for (const method of ['Page.frameStartedLoading', 'Page.frameStoppedLoading'])
    cdp.on(method, ({ frameId }) =>
      record({ kind: 'event', method, frame: frameId }),
    );
  cdp.on('Animation.animationStarted', ({ animation }) =>
    record({
      kind: 'event',
      method: 'Animation.animationStarted',
      animation: animation.id,
      type: animation.type,
      duration: animation.source?.duration,
      delay: animation.source?.delay,
    }),
  );
  cdp.on('Animation.animationCanceled', ({ id }) =>
    record({
      kind: 'event',
      method: 'Animation.animationCanceled',
      animation: id,
    }),
  );
  await Promise.all(
    ['Runtime.enable', 'Page.enable', 'Animation.enable'].map((method) =>
      cdp.send(method),
    ),
  );
  const run = async (command, args = {}) => {
    // Only timing/context/animation metadata is retained: no page text, URLs,
    // expressions, argument values, input, screenshot pixels or returned values.
    const at = Date.now();
    const boundary = navigation;
    record({
      kind: 'command',
      method: 'executeJavaScriptInIsolatedWorld',
      world: 999,
      command,
    });
    let result;
    try {
      result = await app.evaluate(
        ({ BrowserWindow }, { script, command, args }) =>
          BrowserWindow.getAllWindows()[0].webContents.executeJavaScriptInIsolatedWorld(
            999,
            [
              {
                code:
                  script +
                  '\n(async()=>{try{return {ok:true,value:await CirclePage.browserPage(' +
                  JSON.stringify(command) +
                  ',' +
                  JSON.stringify(args) +
                  ')}}catch(error){return {ok:false,error:error.message}}})()',
              },
            ],
          ),
        { script, command, args },
      );
    } catch (error) {
      record({
        kind: 'command-error',
        command,
        elapsed: Date.now() - at,
        navigationChanged: boundary !== navigation,
      });
      throw error;
    }
    record({
      kind: 'response',
      command,
      elapsed: Date.now() - at,
      ok: result.ok,
      navigationChanged: boundary !== navigation,
    });
    if (!result.ok) throw Error(result.error);
    return result.value;
  };
  const snapshot = await run('snapshot');
  const ref = (name) => {
    const line = snapshot
      .split('\n')
      .find((line) => line.includes(JSON.stringify(name)));
    assert(line, `missing element ${name}`);
    const match = line.match(/\[(e\d+)\]/);
    assert(match, `missing ref for ${name}`);
    return match[1];
  };
  for (const text of [
    'visible heading',
    'contents action',
    'assigned slot text',
    'direct shadow text',
    'shadow username',
    'shadow action',
    'frame username',
    'frame submit',
    '| name | state |',
    'alice',
    'table action',
  ]) {
    assert(snapshot.includes(text), `missing snapshot content ${text}`);
  }
  for (const text of [
    'opacity secret',
    'invisible value',
    'hidden secret',
    'hidden input secret',
    'password-value-must-never-appear',
    'cross origin secret',
  ]) {
    assert(!snapshot.includes(text), `snapshot leaked ${text}`);
  }
  assert.match(snapshot, /frame \(cross-origin content unavailable\)/);
  assert.match(snapshot, /password "password"/);
  await assert.rejects(
    run('prepare', { ref: ref('password'), typing: true }),
    /a password field takes only a saved secret/,
  );
  await assert.rejects(
    run('focus', { ref: ref('password') }),
    /a password field takes only a saved secret/,
  );
  await assert.rejects(
    run('focus', { ref: ref('read only field') }),
    /not editable/,
  );
  await assert.rejects(
    run('prepare', { ref: ref('disabled field') }),
    /disabled/,
  );
  await assert.rejects(
    run('prepare', { ref: ref('blocked action') }),
    /covered by.*covering panel/,
  );
  await assert.rejects(
    run('select', { ref: ref('target'), values: ['two'] }),
    /option unavailable/,
  );
  assert.equal(
    await run('select', { ref: ref('target'), values: ['one'] }),
    true,
  );
  const frameTarget = await run('prepare', { ref: ref('frame submit') });
  assert(frameTarget.x > 0 && frameTarget.y > 0);
  const shadowTarget = await run('prepare', { ref: ref('shadow action') });
  assert(shadowTarget.x > 0 && shadowTarget.y > 0);
  const slottedTarget = await run('prepare', { ref: ref('slotted action') });
  assert(slottedTarget.x > 0 && slottedTarget.y > 0);
  await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.debugger.attach('1.3');
  });
  const write = async (name, text) => {
    await run('focus', { ref: ref(name) });
    await app.evaluate(async ({ BrowserWindow }, text) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const select = {
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: process.platform === 'darwin' ? 4 : 2,
      };
      await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        ...select,
        commands: ['selectAll'],
      });
      await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        ...select,
      });
      if (text)
        await contents.debugger.sendCommand('Input.insertText', { text });
      else {
        const backspace = {
          key: 'Backspace',
          code: 'Backspace',
          windowsVirtualKeyCode: 8,
        };
        await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          ...backspace,
        });
        await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...backspace,
        });
      }
    }, text);
  };
  await write('username', 'replacement username');
  assert.equal(
    await page.locator('#username').inputValue(),
    'replacement username',
  );
  await write('username', '');
  assert.equal(await page.locator('#username').inputValue(), '');
  await write('number field', '34');
  assert.equal(await page.locator('#number').inputValue(), '34');
  await write('number field', '');
  assert.equal(await page.locator('#number').inputValue(), '');
  await run('focus', { ref: ref('username') });
  assert.equal(await run('guard-type', { ref: ref('username') }), true);
  await page.locator('#password').focus();
  await assert.rejects(
    run('guard-type', { ref: ref('username') }),
    /a password field takes only a saved secret/,
  );
  await run('focus', { ref: ref('username') });
  await page.locator('#username').evaluate((node) => {
    node.readOnly = true;
  });
  await assert.rejects(
    run('guard-type', { ref: ref('username') }),
    /not editable/,
  );
  await page.locator('#username').evaluate((node) => {
    node.readOnly = false;
  });
  const overlay = {
    ...shadowTarget,
    color: 'CanvasText',
    background: 'Canvas',
    foreground: 'CanvasText',
    tint: 'transparent',
    label: 'overlay should be excluded',
    click: true,
  };
  const overlayNavigation = navigation;
  assert.equal(await run('overlay', overlay), true);
  assert.equal(
    navigation,
    overlayNavigation,
    'overlay acknowledgement must come from the same document',
  );
  assert.equal(await page.locator('[data-circle-browser-overlay]').count(), 1);
  assert.equal(
    await page
      .locator('[data-circle-browser-overlay]')
      .evaluate((node) => node.shadowRoot),
    null,
  );
  assert(!(await run('snapshot')).includes('overlay should be excluded'));
  await run('overlay-hidden', { hidden: true });
  assert.equal(
    await page
      .locator('[data-circle-browser-overlay]')
      .evaluate((node) => getComputedStyle(node).visibility),
    'hidden',
  );
  await run('overlay-hidden', { hidden: false });
  await page.locator('#password').focus();
  await assert.rejects(
    run('guard-key'),
    /a password field takes only a saved secret/,
  );
  // Coordinates use the same composed DOM hit-test as refs, with the captured layout.
  for (const name of ['frame submit', 'shadow action', 'slotted action']) {
    const point = await run('prepare', { ref: ref(name) });
    const capture = await run('capture-state');
    const target = await run('point', { x: point.x, y: point.y, capture });
    assert.equal(target.name, name);
    assert.equal(target.known, true);
  }
  const foreignFrame = page.locator('iframe').last();
  await foreignFrame.scrollIntoViewIfNeeded();
  const foreignRect = await foreignFrame.boundingBox();
  await assert.rejects(
    run('point', {
      x: foreignRect.x + 10,
      y: foreignRect.y + 10,
      capture: await run('capture-state'),
    }),
    /cross-origin frame/,
  );
  const shadowPoint = await run('prepare', { ref: ref('shadow action') });
  const oldShadow = await run('capture-state');
  await page
    .locator('#shadow')
    .evaluate(
      (node) =>
        (node.shadowRoot.querySelector('button').textContent =
          'changed action'),
    );
  await assert.rejects(
    run('point', { x: shadowPoint.x, y: shadowPoint.y, capture: oldShadow }),
    /screenshot is stale/,
  );
  await page.evaluate(() => {
    for (let index = 0; index < 400; index++) {
      const long = document.createElement('p');
      long.textContent = 'bounded snapshot content '.repeat(40);
      document.body.append(long);
    }
  });
  const bounded = await run('snapshot');
  assert(bounded.length < 30100);
  assert(bounded.endsWith('… snapshot truncated'));
  // Which elements get refs, and refs that stay with their elements
  await page.goto(url + 'refs');
  const refs = await run('snapshot');
  const lines = refs.split('\n').filter((line) => /^\s*\[e\d+\]/.test(line));
  const named = (text) => lines.filter((line) => line.includes(text));
  assert.equal(named('"nested link"').length, 1, refs);
  assert.equal(named('"nested"').length, 0, refs);
  assert.equal(named('"link"').length, 0, refs);
  assert.equal(named('"card title card body"').length, 1, refs);
  assert.equal(named('"card title"').length, 0, refs);
  assert.equal(named('"body"').length, 0, refs);
  assert.equal(named('focus target only').length, 0, refs);
  assert.equal(named('keyboard widget').length, 1, refs);
  assert.match(refs, /\[e\d+\] password "secret" empty/);
  assert.equal(lines.length, 5, refs);
  assert(!refs.includes('[new]'));
  const firstRef = lines
    .find((line) => line.includes('"first"'))
    .match(/e\d+/)[0];
  await page.evaluate(() => {
    document.querySelector('#secret').value = 'typed-by-the-person';
    const added = document.createElement('button');
    added.textContent = 'added later';
    document.querySelector('#first').before(added);
  });
  const again = await run('snapshot');
  assert(again.includes(`[${firstRef}] button "first"`), again);
  assert.match(again, /\[e\d+\] button "added later" \[new\]/);
  assert.match(again, /password "secret" filled/);
  assert(!again.includes('typed-by-the-person'));
  console.log(
    'PASS browser page: visible DOM, isolated refs, frames and shadow roots, password guards, obstruction, real input, closed overlay and bounded snapshots; refs only for own actions and stable across snapshots',
  );
  await writeFile(
    join(evidence, 'browser-page-metadata.json'),
    JSON.stringify(
      { platform: process.platform, success: true, metadata },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    join(evidence, 'browser-page-failure-metadata.json'),
    JSON.stringify(
      { platform: process.platform, success: false, metadata },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await cdp?.detach().catch(() => {});
  await app?.close();
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => other.close(resolve)),
  ]);
  await rm(temp, { recursive: true, force: true });
}
