import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

// One diagnostic experiment, not a substitute for the production adapter's tests.
// Every combination uses identical real CDP arguments, with both clients attached.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, '../../outputs/browser-regressions');
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-input-focus-'));
const bundle = await build({
  entryPoints: [join(root, '../../src/browser/page.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'CirclePage',
  target: 'chrome144',
});
const pageScript = bundle.outputFiles[0].text;
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
globalThis.newInputWindow=async()=>{const window=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});globalThis.inputWindow=window;const contents=window.webContents;globalThis.inputNativeEvents=[];globalThis.inputNativeState=()=>{const main=contents.mainFrame;const frame=f=>f?{process:f.processId,routing:f.routingId,tree:f.frameTreeNodeId,main:f===main,detached:f.detached}:null;return {type:contents.getType(),mainFrame:frame(main),focusedFrame:frame(contents.focusedFrame),frames:main.framesInSubtree.map(frame)}};const record=(kind,extra={})=>inputNativeEvents.push({at:Date.now(),kind,...extra,state:inputNativeState()});window.on('ready-to-show',()=>record('ready-to-show'));for(const event of ['dom-ready','did-finish-load','did-stop-loading','focus','blur'])contents.on(event,()=>record(event));contents.on('before-input-event',(event,input)=>record('before-input-event',{type:input.type,code:input.code,prevented:event.defaultPrevented}));await window.loadURL(${JSON.stringify(url)});};
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
let versions;
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
          event.trusted &&
          event.inputType ===
            (expected === '' ? 'deleteContentBackward' : 'insertText'),
      ),
    backspaceObserved: ['keydown', 'keyup'].every((type) =>
      events
        .slice(since)
        .some(
          (event) =>
            event.frame === 'main' &&
            event.field === id &&
            event.type === type &&
            event.code === 'Backspace' &&
            event.trusted,
        ),
    ),
  };
};
try {
  for (const mode of modes)
    for (const transport of transports) {
      const row = {
        mode,
        transport,
        fields: [],
        requests: [],
        contexts: [],
        events: [],
        protocol: [],
      };
      results.push(row);
      let cdp;
      try {
        // Each transport/focus combination starts cold. Otherwise a failed first
        // field's wait could make a later focused combination look like a fix.
        app = await electron.launch({
          executablePath: require('electron'),
          args: [main],
          cwd: root,
          env,
          chromiumSandbox: true,
        });
        const page = await app.firstWindow();
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
        const limited = async (operation, maximum = 10_000) => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw Error('input scenario budget expired');
          let timer;
          try {
            return await Promise.race([
              operation(),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(Error('input scenario did not complete in budget')),
                  Math.min(maximum, remaining),
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        const shared = async (command, args = {}) => {
          const at = Date.now();
          const entry = { command, at };
          row.protocol.push(entry);
          const result = await limited(() =>
            app.evaluate(
              async (_, { pageScript, command, args }) =>
                inputWindow.webContents.executeJavaScriptInIsolatedWorld(999, [
                  {
                    code:
                      pageScript +
                      '\n(async()=>{try{return {ok:true,value:await CirclePage.browserPage(' +
                      JSON.stringify(command) +
                      ',' +
                      JSON.stringify(args) +
                      ')}}catch(error){return {ok:false,error:error.message}}})()',
                  },
                ]),
              { pageScript, command, args },
            ),
          );
          entry.elapsed = Date.now() - at;
          entry.ok = result.ok;
          if (!result.ok) throw Error(result.error);
          return result.value;
        };
        let refs;
        const positive = !(
          mode === 'hidden' && transport === 'electron-debugger'
        );
        if (positive) {
          const snapshot = await shared('snapshot');
          refs = Object.fromEntries(
            ['username', 'number'].map((id) => {
              const line = snapshot
                .split('\n')
                .find((line) => line.includes(JSON.stringify(id)));
              assert(line, 'shared snapshot must expose fixture field');
              return [id, /\[(e\d+)\]/.exec(line)[1]];
            }),
          );
        }
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
          try {
            request.native = await limited(() =>
              app.evaluate(() => inputNativeState()),
            );
            // A stuck transport must not prevent the other diagnostic combinations.
            await limited(
              () =>
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
              3000,
            );
            request.ack = true;
          } catch (error) {
            request.ack = false;
            request.errorType = error.name;
            throw error;
          } finally {
            request.elapsed = Date.now() - start;
            if (Date.now() < deadline)
              request.state = await limited(() =>
                page.evaluate(inspect, {
                  id,
                  expected,
                  since,
                }),
              );
          }
        };
        const attempt = async (
          id,
          operation,
          expected,
          requireKeyboard = false,
        ) => {
          const check = { passed: false };
          const start = Date.now();
          const since = await limited(() =>
            page.evaluate(() => window.circleInputFocusEvents.length),
          );
          const requestStart = row.requests.length;
          try {
            if (positive) {
              const target = await shared('prepare', {
                ref: refs[id],
                typing: true,
              });
              await shared('overlay', {
                ...target,
                typing: true,
                click: false,
                label: 'fixture input',
                color: 'CanvasText',
                background: 'Canvas',
                foreground: 'CanvasText',
                tint: 'transparent',
              });
              await shared('prepare', { ref: refs[id], typing: true });
              await shared('focus', { ref: refs[id] });
              await shared('guard-key');
            } else {
              // The cold negative control retains its original bare input path.
              await limited(() =>
                app.evaluate(
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
                ),
              );
              if (requireKeyboard)
                check.nativeFocusAfterDom = await limited(() =>
                  app.evaluate(() => {
                    inputWindow.webContents.focus();
                    return {
                      visible: inputWindow.isVisible(),
                      windowFocused: inputWindow.isFocused(),
                      contentsFocused: inputWindow.webContents.isFocused(),
                    };
                  }),
                );
            }
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
            if (positive) await shared('guard-type', { ref: refs[id] });
            if (operation === 'replace')
              await send(
                'Input.insertText',
                { text: expected },
                id,
                expected,
                since,
              );
            else {
              if (positive) await shared('guard-key', { key: 'Backspace' });
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
              check.observed = await limited(() =>
                page.evaluate(inspect, {
                  id,
                  expected,
                  since,
                }),
              );
              if (
                check.observed.matches &&
                check.observed.inputObserved &&
                (!requireKeyboard || check.observed.backspaceObserved)
              )
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
            if (requireKeyboard)
              assert.equal(
                check.observed.backspaceObserved,
                true,
                'the same field must receive trusted Backspace down/up',
              );
            check.passed = true;
          } catch (error) {
            check.errorType = error.name;
          }
          check.elapsed = Date.now() - start;
          check.events =
            Date.now() < deadline
              ? await limited(() =>
                  page.evaluate(
                    (since) => window.circleInputFocusEvents.slice(since),
                    since,
                  ),
                )
              : [];
          check.requests = row.requests.slice(requestStart);
          return check;
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
          field.replace = await attempt(id, 'replace', replacement);
          field.clear = await attempt(
            id,
            'clear',
            '',
            !(mode === 'hidden' && transport === 'electron-debugger'),
          );
          const failed = field.clear;
          // A no-focus baseline is an explicit negative control, not a product
          // acceptance path. Only this previously observed signature can recover:
          // all native keys acknowledged, exact selection/value retained, and no
          // key reached any main/BODY/iframe target. Unknown failures remain red.
          const knownUndeliveredKeys =
            mode === 'hidden' &&
            transport === 'electron-debugger' &&
            id === 'username' &&
            field.replace.passed &&
            !failed.passed &&
            failed.errorType === 'AssertionError' &&
            failed.observed?.active &&
            failed.observed.focused &&
            failed.observed.length === replacement.length &&
            failed.observed.selectionStart === 0 &&
            failed.observed.selectionEnd === replacement.length &&
            !failed.observed.inputObserved &&
            failed.requests.length === 4 &&
            failed.requests.every((request) => request.ack) &&
            failed.events.length === 0;
          if (knownUndeliveredKeys) {
            row.negativeControl = 'acknowledged keys not delivered';
            // Use the very same window and field. Focus must preserve the exact
            // selected replacement; clearing still uses the original real CDP keys.
            await limited(() =>
              app.evaluate(() => inputWindow.webContents.focus()),
            );
            const preserved = await limited(() =>
              page.evaluate(inspect, {
                id,
                expected: replacement,
                since: 0,
              }),
            );
            assert(
              preserved.matches &&
                preserved.active &&
                preserved.selectionStart === 0 &&
                preserved.selectionEnd === replacement.length,
              'native focus must preserve the selected field/value',
            );
            row.focusRecovery = await attempt(id, 'clear', '', true);
          }
        }
        row.elapsed = Date.now() - scenarioStart;
        row.events = await limited(() =>
          page.evaluate(() => window.circleInputFocusEvents),
        );
        row.nativeEvents = await app.evaluate(() => inputNativeEvents);
        row.preparation = positive
          ? 'shared prepare/overlay/prepare/focus/guards'
          : 'bare cold input';
        row.passed =
          row.elapsed <= 10_000 &&
          (mode !== 'visible-focused' || row.visibleFocusEstablished) &&
          row.fields.length === 2 &&
          row.fields.every(
            (field) => field.replace.passed && field.clear.passed,
          );
        row.expectationPassed =
          row.passed ||
          (row.elapsed <= 10_000 &&
            row.negativeControl === 'acknowledged keys not delivered' &&
            row.focusRecovery?.passed === true &&
            row.fields[0].replace.passed &&
            row.fields[1].replace.passed &&
            row.fields[1].clear.passed);
        versions = await app.evaluate(() => process.versions);
      } catch (error) {
        row.passed = false;
        row.expectationPassed = false;
        row.errorType = error.name;
      } finally {
        await cdp?.detach().catch(() => {});
        await app
          ?.evaluate(() => {
            if (globalThis.inputWindow && !inputWindow.isDestroyed())
              inputWindow.destroy();
          })
          .catch(() => {});
        await app?.close();
        app = undefined;
      }
    }
  const report = {
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
    versions: {
      driverNode: process.version,
      electron: versions?.electron,
      chromium: versions?.chrome,
    },
    expectation:
      'all positive paths deliver real input; a precisely classified no-focus negative must recover on the same selected field after native focus',
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
    expectationPassed: row.expectationPassed,
    negativeControl: row.negativeControl,
    focusRecovery: row.focusRecovery?.passed,
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
    results.length === 6 && results.every((row) => row.expectationPassed)
      ? 0
      : 1;
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
