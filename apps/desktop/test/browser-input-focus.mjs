import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// One diagnostic experiment, not a substitute for the production adapter's tests.
// Every combination uses identical real CDP arguments, with both clients attached.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, '../../outputs/browser-regressions');
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-input-focus-'));
await mkdir(output, { recursive: true });
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(
    request.url === '/frame'
      ? '<!doctype html><input id="frame-username" value="frame fixture">'
      : '<!doctype html><title>circle input focus fixture</title><label>username<input id="username" value="old username"></label><label>number<input id="number" type="number" value="12"></label><iframe src="/frame"></iframe>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const main = join(temp, 'main.cjs');
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(temp, 'data'))});
globalThis.newInputWindow=async()=>{const window=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});globalThis.inputWindow=window;await window.loadURL(${JSON.stringify(url)});};
app.whenReady().then(()=>newInputWindow());
app.on('window-all-closed',()=>{});`,
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const results = [];
const modes = ['hidden', 'hidden-contents-focus', 'visible-focused'];
const transports = ['electron-debugger', 'playwright-cdp'];

// Never serialize field contents or key characters. Unknown/BODY/frame targets are
// retained as tags, so a dropped or redirected key cannot disappear from the trace.
const installEvents = () => {
  window.circleInputFocusEvents = [];
  const install = (document, frame) => {
    for (const type of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input'])
      document.addEventListener(
        type,
        (event) => {
          const target = event.target;
          const known = ['username', 'number', 'frame-username'].includes(
            target.id,
          );
          window.circleInputFocusEvents.push({
            at: Date.now(),
            frame,
            type,
            tag: target.tagName,
            field: known ? target.id : null,
            activeTag: document.activeElement?.tagName,
            activeField: ['username', 'number', 'frame-username'].includes(
              document.activeElement?.id,
            )
              ? document.activeElement.id
              : null,
            code: event.code,
            inputType: event.inputType,
            trusted: event.isTrusted,
            prevented: event.defaultPrevented,
            length: known ? target.value.length : undefined,
            selectionStart: known ? target.selectionStart : undefined,
            selectionEnd: known ? target.selectionEnd : undefined,
          });
        },
        true,
      );
  };
  install(document, 'main');
  for (const frame of document.querySelectorAll('iframe'))
    if (frame.contentDocument) install(frame.contentDocument, 'iframe');
};
const inspect = ({ id, expected, since }) => {
  const field = document.getElementById(id);
  const events = window.circleInputFocusEvents;
  return {
    tag: field.tagName,
    type: field.type,
    length: field.value.length,
    matches: field.value === expected,
    selectionStart: field.selectionStart,
    selectionEnd: field.selectionEnd,
    active: document.activeElement === field,
    activeTag: document.activeElement?.tagName,
    focused: document.hasFocus(),
    visibility: document.visibilityState,
    inputObserved: events
      .slice(since)
      .some(
        (event) =>
          event.frame === 'main' &&
          event.field === id &&
          event.type === 'input' &&
          event.trusted,
      ),
  };
};
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [main],
    cwd: root,
    env,
    chromiumSandbox: true,
  });
  let page = await app.firstWindow();
  let first = true;
  for (const mode of modes)
    for (const transport of transports) {
      const row = {
        mode,
        transport,
        fields: [],
        requests: [],
        contexts: [],
        events: [],
      };
      results.push(row);
      let cdp;
      try {
        if (!first) {
          const appeared = app.waitForEvent('window');
          await app.evaluate(async () => newInputWindow());
          page = await appeared;
        }
        first = false;
        await page.waitForLoadState('load');
        cdp = await page.context().newCDPSession(page);
        for (const method of [
          'Runtime.executionContextsCleared',
          'Page.loadEventFired',
        ])
          cdp.on(method, () => row.contexts.push({ method, at: Date.now() }));
        cdp.on('Runtime.executionContextCreated', ({ context }) =>
          row.contexts.push({
            method: 'Runtime.executionContextCreated',
            at: Date.now(),
            context: context.id,
            frame: context.auxData?.frameId,
            isDefault: context.auxData?.isDefault,
          }),
        );
        cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) =>
          row.contexts.push({
            method: 'Runtime.executionContextDestroyed',
            at: Date.now(),
            context: executionContextId,
          }),
        );
        cdp.on('Page.frameNavigated', ({ frame }) =>
          row.contexts.push({
            method: 'Page.frameNavigated',
            at: Date.now(),
            frame: frame.id,
            main: !frame.parentId,
          }),
        );
        await Promise.all(
          ['Runtime.enable', 'Page.enable'].map((method) => cdp.send(method)),
        );
        await app.evaluate(() =>
          inputWindow.webContents.debugger.attach('1.3'),
        );
        await page.evaluate(installEvents);
        await app.evaluate(({ app }, mode) => {
          if (mode === 'visible-focused') {
            inputWindow.show();
            inputWindow.focus();
            if (process.platform === 'darwin') app.focus({ steal: true });
          }
          if (mode !== 'hidden') inputWindow.webContents.focus();
        }, mode);
        const windowState = () =>
          app.evaluate(() => ({
            visible: inputWindow.isVisible(),
            windowFocused: inputWindow.isFocused(),
            contentsFocused: inputWindow.webContents.isFocused(),
          }));
        row.window = await windowState();
        const focusDeadline = Date.now() + 1000;
        while (
          mode === 'visible-focused' &&
          !(
            row.window.visible &&
            row.window.windowFocused &&
            row.window.contentsFocused
          ) &&
          Date.now() < focusDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          row.window = await windowState();
        }
        row.visibleFocusEstablished =
          mode === 'visible-focused'
            ? row.window.visible &&
              row.window.windowFocused &&
              row.window.contentsFocused
            : undefined;
        const scenarioStart = Date.now();
        const deadline = scenarioStart + 10_000;
        const send = async (method, args, id, expected, since) => {
          const start = Date.now();
          const request = {
            method,
            type: args.type,
            code: args.code,
            commands: args.commands,
            textLength: args.text?.length,
            at: start,
          };
          row.requests.push(request);
          let timer;
          try {
            // A stuck transport must not prevent the other diagnostic combinations.
            await Promise.race([
              transport === 'electron-debugger'
                ? app.evaluate(
                    async (_, { method, args }) =>
                      inputWindow.webContents.debugger.sendCommand(
                        method,
                        args,
                      ),
                    { method, args },
                  )
                : cdp.send(method, args),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(Error('native input transport did not acknowledge')),
                  Math.max(100, Math.min(3000, deadline - Date.now())),
                );
              }),
            ]);
            request.ack = true;
          } catch (error) {
            request.ack = false;
            request.errorType = error.name;
            throw error;
          } finally {
            clearTimeout(timer);
            request.elapsed = Date.now() - start;
            request.state = await page.evaluate(inspect, {
              id,
              expected,
              since,
            });
          }
        };
        for (const [id, replacement] of [
          ['username', 'replacement username'],
          ['number', '34'],
        ]) {
          const field = {
            id,
            replace: { passed: false },
            clear: { passed: false },
          };
          row.fields.push(field);
          for (const [operation, expected] of [
            ['replace', replacement],
            ['clear', ''],
          ]) {
            const check = field[operation];
            const start = Date.now();
            const since = await page.evaluate(
              () => window.circleInputFocusEvents.length,
            );
            try {
              // Match browserPage's isolated-world focus/select behavior without changing a value.
              await app.evaluate(
                async (_, id) =>
                  inputWindow.webContents.executeJavaScriptInIsolatedWorld(
                    999,
                    [
                      {
                        code: `(()=>{const field=document.getElementById(${JSON.stringify(id)});field.focus();if(field.type!=='number')field.select();return document.activeElement===field})()`,
                      },
                    ],
                  ),
                id,
              );
              const select = {
                key: 'a',
                code: 'KeyA',
                windowsVirtualKeyCode: 65,
                modifiers: process.platform === 'darwin' ? 4 : 2,
              };
              await send(
                'Input.dispatchKeyEvent',
                { type: 'rawKeyDown', ...select, commands: ['selectAll'] },
                id,
                expected,
                since,
              );
              await send(
                'Input.dispatchKeyEvent',
                { type: 'keyUp', ...select },
                id,
                expected,
                since,
              );
              if (operation === 'replace')
                await send(
                  'Input.insertText',
                  { text: expected },
                  id,
                  expected,
                  since,
                );
              else {
                const backspace = {
                  key: 'Backspace',
                  code: 'Backspace',
                  windowsVirtualKeyCode: 8,
                };
                await send(
                  'Input.dispatchKeyEvent',
                  { type: 'rawKeyDown', ...backspace },
                  id,
                  expected,
                  since,
                );
                await send(
                  'Input.dispatchKeyEvent',
                  { type: 'keyUp', ...backspace },
                  id,
                  expected,
                  since,
                );
              }
              // Share a 10 s scenario budget while allowing both fields to run after a failure.
              const until = Math.min(deadline, Date.now() + 2500);
              do {
                check.observed = await page.evaluate(inspect, {
                  id,
                  expected,
                  since,
                });
                if (check.observed.matches && check.observed.inputObserved)
                  break;
                if (Date.now() >= until) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
              } while (true);
              assert.equal(
                check.observed.matches,
                true,
                'actual field value did not match',
              );
              assert.equal(
                check.observed.inputObserved,
                true,
                'the field did not receive a trusted input event',
              );
              check.passed = true;
            } catch (error) {
              check.errorType = error.name;
            }
            check.elapsed = Date.now() - start;
          }
        }
        row.elapsed = Date.now() - scenarioStart;
        row.events = await page.evaluate(() => window.circleInputFocusEvents);
        row.passed =
          (mode !== 'visible-focused' || row.visibleFocusEstablished) &&
          row.fields.length === 2 &&
          row.fields.every(
            (field) => field.replace.passed && field.clear.passed,
          );
      } catch (error) {
        row.passed = false;
        row.errorType = error.name;
      } finally {
        await cdp?.detach().catch(() => {});
        await app
          .evaluate(() => {
            if (globalThis.inputWindow && !inputWindow.isDestroyed())
              inputWindow.destroy();
          })
          .catch(() => {});
      }
    }
  const versions = await app.evaluate(() => process.versions);
  const report = {
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
    versions: {
      driverNode: process.version,
      electron: versions.electron,
      chromium: versions.chrome,
    },
    scenarioBudgetMs: 10_000,
    effectSliceMs: 2500,
    results,
  };
  await writeFile(
    join(output, 'browser-input-focus-metadata.json'),
    JSON.stringify(report, null, 2),
  );
  const matrix = results.map((row) => ({
    mode: row.mode,
    transport: row.transport,
    passed: row.passed,
    fields: row.fields.map((field) => ({
      id: field.id,
      replace: field.replace.passed,
      clear: field.clear.passed,
    })),
    keyTargets: [
      ...new Set(
        row.events
          .filter((event) =>
            ['keydown', 'keypress', 'keyup'].includes(event.type),
          )
          .map((event) => `${event.frame}:${event.field ?? event.tag}`),
      ),
    ],
  }));
  console.log(
    JSON.stringify({ platform: process.platform, arch: process.arch, matrix }),
  );
  process.exitCode =
    results.length === 6 && results.every((row) => row.passed) ? 0 : 1;
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
