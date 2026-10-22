import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { listenForBrowser } from '../../../tests/browser-port.mjs';

// Use the production adapter on exactly the standalone raw probe's main/iframe scene.
// Every mode starts a new process and profile; no input is retried or set through DOM.
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-native-input-'));
const output = join(root, '../../outputs/browser-regressions');
await mkdir(output, { recursive: true });
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(
    request.url === '/frame'
      ? '<!doctype html><input id="frame-username" value="frame fixture">'
      : '<!doctype html><title>circle input focus fixture</title><label>username<input id="username" value="old username"></label><label>number<input id="number" type="number" value="12"></label><iframe src="/frame"></iframe>',
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

// Runs in Electron's main process. Lifecycle listeners precede every load, including
// the real child WebContentsView created by BrowserSessions during navigation.
function bootstrap(paths) {
  const { app, BrowserWindow } = require('electron');
  const started = Date.now();
  globalThis.fixtureTimings = [];
  globalThis.fixtureBeforeInput = [];
  globalThis.fixtureNativeRequests = [];
  const record = (kind, contents) =>
    fixtureTimings.push({
      kind,
      at: Date.now() - started,
      contentsId: contents.id,
      contentsType: contents.isDestroyed() ? 'destroyed' : contents.getType(),
    });
  app.setPath('userData', paths.data);
  app.on('web-contents-created', (_, contents) => {
    record('created', contents);
    for (const kind of [
      'did-start-loading',
      'dom-ready',
      'did-finish-load',
      'did-stop-loading',
    ])
      contents.on(kind, () => record(kind, contents));
  });
  globalThis.fixtureFrames = () => {
    const contents = globalThis.fixtureContents;
    if (!contents || contents.isDestroyed()) return { unavailable: true };
    const main = contents.mainFrame;
    const describe = (frame) =>
      frame
        ? {
            processId: frame.processId,
            routingId: frame.routingId,
            frameTreeNodeId: frame.frameTreeNodeId,
            parentFrameTreeNodeId: frame.parent?.frameTreeNodeId ?? null,
            isMain: frame.frameTreeNodeId === main.frameTreeNodeId,
          }
        : null;
    return {
      contentsId: contents.id,
      contentsType: contents.getType(),
      frameCount: main.framesInSubtree.length,
      mainFrame: describe(main),
      focusedFrame: describe(contents.focusedFrame),
      frames: main.framesInSubtree.map(describe),
      visible: fixtureWindow.isVisible(),
      windowFocused: fixtureWindow.isFocused(),
      contentsFocused: contents.isFocused(),
    };
  };
  globalThis.ready = app.whenReady().then(async () => {
    const window = new BrowserWindow({
      show: false,
      width: 1100,
      height: 850,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    globalThis.fixtureWindow = window;
    window.on('ready-to-show', () =>
      record('ready-to-show', window.webContents),
    );
    await window.loadURL('about:blank');
    const { BrowserSessions } = require(paths.bundle);
    globalThis.browser = new BrowserSessions(
      window,
      () => {},
      () => 'en',
      undefined,
      new Map(),
      paths.downloads,
    );
  });
  app.on('window-all-closed', () => app.quit());
}

// Only metadata is retained: known synthetic field IDs, lengths, event codes, and
// frame IDs. No values, key characters, text, expressions, titles, or URLs are logged.
const installEvents = () => {
  window.inputEvents = [];
  const install = (document, frame) => {
    for (const type of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input'])
      document.addEventListener(
        type,
        (event) => {
          const target = event.target;
          const known = ['username', 'number', 'frame-username'].includes(
            target.id,
          );
          window.inputEvents.push({
            frame,
            type,
            code: event.code,
            inputType: event.inputType,
            trusted: event.isTrusted,
            prevented: event.defaultPrevented,
            tag: target.tagName,
            field: known ? target.id : null,
            length: known ? target.value.length : undefined,
          });
        },
        true,
      );
  };
  install(document, 'main');
  for (const frame of document.querySelectorAll('iframe')) {
    if (!frame.contentDocument)
      throw Error('matched iframe was not accessible');
    install(frame.contentDocument, 'iframe');
  }
  return { iframeCount: document.querySelectorAll('iframe').length };
};
const inspect = ({ field, expected, since }) => {
  const target = document.getElementById(field);
  const events = window.inputEvents.slice(since);
  return {
    length: target.value.length,
    matches: target.value === expected,
    active: document.activeElement === target,
    focused: document.hasFocus(),
    selectionStart: target.selectionStart,
    selectionEnd: target.selectionEnd,
    eventCount: window.inputEvents.length,
    inputObserved: events.some(
      (event) =>
        event.frame === 'main' &&
        event.field === field &&
        event.type === 'input' &&
        event.trusted &&
        event.inputType ===
          (expected === '' ? 'deleteContentBackward' : 'insertText'),
    ),
    backspaceObserved: ['keydown', 'keyup'].every((type) =>
      events.some(
        (event) =>
          event.frame === 'main' &&
          event.field === field &&
          event.type === type &&
          event.code === 'Backspace' &&
          event.trusted,
      ),
    ),
    events,
  };
};
const cases = [];
const inFlight = new Set();
let app;
const bounded = async (operation, deadline) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Error('fixture action exceeded its total budget');
  const pending = Promise.resolve().then(operation);
  inFlight.add(pending);
  pending.then(
    () => inFlight.delete(pending),
    () => inFlight.delete(pending),
  );
  let timer;
  try {
    const value = await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error('fixture action exceeded its total budget')),
          remaining,
        );
      }),
    ]);
    if (Date.now() > deadline)
      throw Error('fixture action exceeded its total budget');
    return value;
  } finally {
    clearTimeout(timer);
  }
};
try {
  for (const mode of ['hidden', 'hidden-focused', 'visible-focused']) {
    const result = { mode, steps: [], phase: 'launch', passed: false };
    cases.push(result);
    const data = join(temp, mode, 'data');
    await mkdir(data, { recursive: true });
    const main = join(temp, mode, 'main.cjs');
    await writeFile(
      main,
      `(${bootstrap.toString()})(${JSON.stringify({
        data,
        bundle,
        downloads: join(temp, mode, 'downloads'),
      })});`,
    );
    const env = {
      ...process.env,
      CIRCLE_HOME: join(temp, mode, 'home'),
      CIRCLE_WORKBENCH_DATA_DIR: data,
    };
    delete env.ELECTRON_RUN_AS_NODE;
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
      const run = (action, args, budget = 30_000) =>
        app.evaluate(
          async (_, { action, args, budget }) => {
            const controller = new AbortController();
            const timer = setTimeout(
              () =>
                controller.abort(
                  Error('fixture action exceeded its total budget'),
                ),
              budget,
            );
            try {
              return await browser.agent(
                { id: 'input-check', sessionId: 'fixture', action, args },
                controller.signal,
              );
            } finally {
              clearTimeout(timer);
            }
          },
          { action, args, budget },
        );
      result.phase = 'navigate';
      const opened = await bounded(
        () => run('navigate', { url }),
        Date.now() + 30_000,
      );
      const ref = (name) => {
        const line = opened.text
          .split('\n')
          .find(
            (line) => line.includes(`"${name}"`) && /\[(e\d+)\]/.test(line),
          );
        assert.ok(line, `missing ${name} ref`);
        return /\[(e\d+)\]/.exec(line)[1];
      };
      result.phase = 'instrument';
      result.target = await app.evaluate(async () => {
        const contents = fixtureWindow.contentView.children.find(
          (view) =>
            view.webContents?.getTitle() === 'circle input focus fixture',
        )?.webContents;
        if (!contents) throw Error('matched adapter tab was not created');
        globalThis.fixtureContents = contents;
        contents.on('before-input-event', (event, input) => {
          fixtureBeforeInput.push({
            type: input.type,
            code: input.code,
            prevented: !!event.defaultPrevented,
          });
        });
        const originalSend = contents.debugger.sendCommand.bind(
          contents.debugger,
        );
        contents.debugger.sendCommand = (method, args, ...rest) => {
          if (!method.startsWith('Input.'))
            return originalSend(method, args, ...rest);
          const entry = {
            method,
            type: args.type,
            code: args.code,
            before: fixtureFrames(),
          };
          const started = Date.now();
          fixtureNativeRequests.push(entry);
          return originalSend(method, args, ...rest).then(
            (value) => {
              entry.ack = true;
              entry.elapsed = Date.now() - started;
              entry.after = fixtureFrames();
              return value;
            },
            (error) => {
              entry.ack = false;
              entry.elapsed = Date.now() - started;
              entry.errorType = error.name;
              throw error;
            },
          );
        };
        const { targetInfo } = await originalSend('Target.getTargetInfo');
        return { targetType: targetInfo.type, ...fixtureFrames() };
      });
      const installed = await app.evaluate(
        (_, code) => fixtureContents.executeJavaScript(code),
        `(${installEvents.toString()})()`,
      );
      assert.equal(
        installed.iframeCount,
        1,
        'matched scene must keep its iframe',
      );
      result.phase = 'focus';
      await app.evaluate((_, mode) => {
        browser.bounds(
          'fixture',
          { x: 0, y: 0, width: 1000, height: 700 },
          mode === 'visible-focused',
        );
        if (mode === 'visible-focused') {
          fixtureWindow.show();
          fixtureWindow.focus();
        } else fixtureWindow.hide();
        if (mode !== 'hidden') fixtureContents.focus();
      }, mode);
      const read = (field, expected, since) =>
        app.evaluate(
          async (_, { code }) => ({
            native: fixtureFrames(),
            dom: await fixtureContents.executeJavaScript(code),
          }),
          {
            code: `(${inspect.toString()})(${JSON.stringify({ field, expected, since })})`,
          },
        );
      for (const [field, replacement] of [
        ['username', 'replacement username'],
        ['number', '34'],
      ])
        for (const [operation, text] of [
          ['insert', replacement],
          ['clear', ''],
        ]) {
          const started = Date.now();
          const deadline = started + 10_000;
          const step = { field, operation, passed: false };
          result.steps.push(step);
          result.phase = `${field}:${operation}`;
          const before = await bounded(() => read(field, text, 0), deadline);
          step.before = {
            native: before.native,
            eventCount: before.dom.eventCount,
          };
          await bounded(
            () =>
              run(
                'type',
                { ref: ref(field), element: field, text },
                deadline - Date.now(),
              ),
            deadline,
          );
          const observed = await bounded(
            () => read(field, text, before.dom.eventCount),
            deadline,
          );
          step.observed = observed;
          step.elapsed = Date.now() - started;
          assert.equal(
            observed.dom.matches,
            true,
            'actual field value did not match',
          );
          assert.equal(
            observed.dom.inputObserved,
            true,
            'trusted input effect missing',
          );
          if (operation === 'clear')
            assert.equal(
              observed.dom.backspaceObserved,
              true,
              'trusted Backspace down/up missing',
            );
          assert.ok(step.elapsed <= 10_000, 'real input exceeded 10000ms');
          step.passed = true;
        }
      result.passed =
        result.steps.length === 4 && result.steps.every((step) => step.passed);
    } catch (error) {
      result.error = { type: error.name, code: error.code };
    } finally {
      const settleDeadline = Date.now() + 2000;
      await bounded(
        () => Promise.allSettled([...inFlight]),
        settleDeadline,
      ).catch(() => {});
      result.metadata = await bounded(
        () =>
          app?.evaluate(() => ({
            native: fixtureFrames(),
            timings: fixtureTimings,
            beforeInput: fixtureBeforeInput,
            requests: fixtureNativeRequests,
            versions: {
              electron: process.versions.electron,
              chromium: process.versions.chrome,
            },
          })),
        Date.now() + 2000,
      ).catch(() => ({ unavailable: true }));
      await bounded(
        () => app?.evaluate(() => browser.close()),
        Date.now() + 2000,
      ).catch(() => {});
      await app?.close();
      app = undefined;
    }
  }
  const report = {
    platform: process.platform,
    arch: process.arch,
    actionBudgetMs: 10_000,
    scene: 'main text and number fields with the raw probe same-origin iframe',
    cases,
  };
  await writeFile(
    join(output, 'browser-input-native-metadata.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      cases: cases.map(({ mode, passed, phase, steps, target }) => ({
        mode,
        passed,
        phase,
        targetType: target?.targetType,
        steps: steps.map(({ field, operation, passed, elapsed, observed }) => ({
          field,
          operation,
          passed,
          elapsed,
          actualLength: observed?.dom.length,
        })),
      })),
    }),
  );
  process.exitCode =
    cases.length === 3 && cases.every((result) => result.passed) ? 0 : 1;
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
