import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

// Diagnose real adapter effects separately from the standalone page-script shell.
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-native-input-'));
const output = join(root, '../../outputs/browser-regressions');
await mkdir(output, { recursive: true });
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><title>input adapter fixture</title>
    <label>username<input id="username" value="initial"></label>
    <label>amount<input id="amount" type="number" value="12"></label>
    <script>window.inputEvents=[];for(const type of ['keydown','keyup','beforeinput','input'])document.addEventListener(type,event=>{const target=event.target;window.inputEvents.push({type,code:event.code,inputType:event.inputType,trusted:event.isTrusted,target:target.tagName,known:['username','amount'].includes(target.id)?target.id:undefined,length:['username','amount'].includes(target.id)?target.value.length:undefined})},true)</script>`);
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
globalThis.ready=app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await window.loadURL('about:blank');const {BrowserSessions}=require(${JSON.stringify(bundle)});globalThis.browser=new BrowserSessions(window,()=>{},()=> 'en',undefined,new Map(),${JSON.stringify(join(temp, 'downloads'))});});
app.on('window-all-closed',()=>app.quit());`,
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
};
delete env.ELECTRON_RUN_AS_NODE;
const cases = [];
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
  await app.evaluate(async () => {
    await globalThis.ready;
  });
  const run = (action, args = {}) =>
    app.evaluate(
      async (_, { action, args }) =>
        browser.agent(
          { id: 'input-check', sessionId: 'fixture', action, args },
          new AbortController().signal,
        ),
      { action, args },
    );
  const read = () =>
    app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const contents = window.contentView.children.find(
        (view) => view.webContents?.getTitle() === 'input adapter fixture',
      ).webContents;
      return {
        visible: window.isVisible(),
        windowFocused: window.isFocused(),
        contentsFocused: contents.isFocused(),
        ...(await contents.executeJavaScript(
          `({username:document.querySelector('#username').value,amount:document.querySelector('#amount').value,focused:document.hasFocus(),events:window.inputEvents})`,
        )),
      };
    });
  for (const mode of ['hidden', 'hidden-focused', 'visible-focused']) {
    const result = { mode, steps: [], phase: 'navigate' };
    cases.push(result);
    try {
      const opened = await run('navigate', { url: `${url}?mode=${mode}` });
      const ref = (name) => {
        const line = opened.text
          .split('\n')
          .find(
            (line) => line.includes(`"${name}"`) && /\[(e\d+)\]/.test(line),
          );
        assert.ok(line, `missing ${name} ref`);
        return /\[(e\d+)\]/.exec(line)[1];
      };
      result.phase = 'focus';
      await app.evaluate(({ BrowserWindow }, mode) => {
        const window = BrowserWindow.getAllWindows()[0];
        browser.bounds(
          'fixture',
          { x: 0, y: 0, width: 1000, height: 700 },
          mode === 'visible-focused',
        );
        const contents = window.contentView.children.find(
          (view) => view.webContents?.getTitle() === 'input adapter fixture',
        ).webContents;
        if (mode === 'visible-focused') {
          window.show();
          window.focus();
        } else window.hide();
        if (mode !== 'hidden') contents.focus();
      }, mode);
      for (const [name, field, text] of [
        ['username', 'username', 'replacement'],
        ['amount', 'amount', '34'],
      ]) {
        result.phase = field + ':insert';
        await run('type', { ref: ref(name), element: name, text });
        const inserted = await read();
        result.steps.push({
          field,
          operation: 'insert',
          actualLength: inserted[field].length,
          effect: inserted[field] === text,
        });
        assert.equal(inserted[field], text, `${mode} ${field} insert`);
        result.phase = field + ':clear';
        await run('type', { ref: ref(name), element: name, text: '' });
        const cleared = await read();
        result.steps.push({
          field,
          operation: 'clear',
          actualLength: cleared[field].length,
          effect: cleared[field] === '',
        });
        assert.equal(cleared[field], '', `${mode} ${field} clear`);
      }
      result.passed = true;
    } catch (error) {
      result.passed = false;
      result.error = { type: error.name, code: error.code }; // No input values or URLs.
    } finally {
      const state = await read().catch(() => ({ unavailable: true }));
      result.state = {
        ...state,
        usernameLength: state.username?.length,
        amountLength: state.amount?.length,
      };
      delete result.state.username;
      delete result.state.amount;
    }
  }
  await writeFile(
    join(output, 'browser-input-native-metadata.json'),
    JSON.stringify(
      { platform: process.platform, arch: process.arch, cases },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ platform: process.platform, arch: process.arch, cases }),
  );
  assert.ok(
    cases.every((result) => result.passed),
    'real native input effects failed; see browser-input-native-metadata.json',
  );
} finally {
  await app?.evaluate(() => browser.close()).catch(() => {});
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
