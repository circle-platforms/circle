// Serialized native-driver regression, synthetic loopback page and isolated profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'circle-diagnostics-'));
const output = process.env.CIRCLE_BROWSER_DIAGNOSTICS_EVIDENCE;
if (output) await mkdir(output, { recursive: true });
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(
      'window.breakpointFixture=function fixture(){\n  const count=3;\n  const next=count+1;\n  return next;\n};',
    );
    return;
  }

  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<!doctype html><meta name="viewport" content="width=device-width"><script>localStorage.setItem('fixture','before');console.error('fixture console');fetch('/request');function breakpointFixture(){const count=3;return count+1;}window.breakpointFixture=breakpointFixture;</script><script src="/fixture.js"></script><button>local fixture</button>`,
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const entry = join(temp, 'main.ts');
const bundled = join(temp, 'main.cjs');
await writeFile(
  entry,
  `import {app,BrowserWindow} from 'electron';import {BrowserSessions} from ${JSON.stringify(join(root, 'src/browser.ts'))};app.setPath('userData',${JSON.stringify(join(temp, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false});globalThis.fixture={browser:new BrowserSessions(w),window:w};});`,
);
await build({
  entryPoints: [entry],
  outfile: bundled,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  target: 'node24',
});
let app;
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [bundled],
    env: {
      ...process.env,
      CIRCLE_HOME: join(temp, 'home'),
      CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
    },
  });
  await app.evaluate(async () => {
    while (!globalThis.fixture) await new Promise((r) => setTimeout(r, 20));
  });
  await app.evaluate(
    async (_, { origin }) => {
      await globalThis.fixture.browser.navigate('test', origin);
    },
    { origin },
  );
  await new Promise((r) => setTimeout(r, 400));
  let result = await app.evaluate(() =>
    globalThis.fixture.browser.diagnostics('test', { action: 'read' }),
  );
  assert(result.state.console.some((e) => e.text === 'fixture console'));
  assert(
    result.state.network.some(
      (e) => e.url.endsWith('/request') && e.status === 200,
    ),
  );
  result = await app.evaluate(
    (_, origin) =>
      globalThis.fixture.browser.diagnostics('test', {
        action: 'storage',
        kind: 'local',
        origin,
        operation: 'set',
        key: 'fixture',
        value: 'after',
      }),
    origin,
  );
  assert(result.storage.some(([k, v]) => k === 'fixture' && v === 'after'));
  await app.evaluate(() =>
    globalThis.fixture.browser.diagnostics('test', {
      action: 'viewport',
      width: 375,
      height: 812,
      mobile: true,
    }),
  );
  const dimensions = await app.evaluate(() =>
    globalThis.fixture.window.contentView.children[0].webContents.executeJavaScript(
      '[innerWidth,innerHeight]',
    ),
  );
  assert.deepEqual(dimensions, [375, 812]);
  if (output) {
    const png = await app.evaluate(async () =>
      (
        await globalThis.fixture.window.contentView.children[0].webContents.capturePage()
      )
        .toPNG()
        .toString('base64'),
    );
    await writeFile(
      join(output, 'native-375x812.png'),
      Buffer.from(png, 'base64'),
    );
  }
  await app.evaluate(
    (_, origin) =>
      globalThis.fixture.browser.diagnostics('test', {
        action: 'debug',
        command: 'breakpoints',
        url: origin + '/fixture.js',
        line: 3,
      }),
    origin,
  );
  await app.evaluate(() => {
    globalThis.fixture.evaluation =
      globalThis.fixture.window.contentView.children[0].webContents.executeJavaScript(
        'breakpointFixture()',
      );
  });
  for (let i = 0; i < 50; i++) {
    result = await app.evaluate(() =>
      globalThis.fixture.browser.diagnostics('test', { action: 'read' }),
    );
    if (result.state.debugger.paused) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(result.state.debugger.paused, true);
  assert.equal(result.state.debugger.stackFrames[0].line, 3);
  const reference = result.state.debugger.stackFrames[0].scopes.find(
    (s) => s.name === 'local',
  ).variablesReference;
  const variables = await app.evaluate(
    (_, reference) =>
      globalThis.fixture.browser.diagnostics('test', {
        action: 'debug',
        command: 'variables',
        reference,
      }),
    reference,
  );
  assert(
    variables.variables.some((v) => v.name === 'count' && v.value === '3'),
  );
  await app.evaluate(() =>
    globalThis.fixture.browser.diagnostics('test', {
      action: 'debug',
      command: 'stepOver',
    }),
  );
  for (let i = 0; i < 50; i++) {
    result = await app.evaluate(() =>
      globalThis.fixture.browser.diagnostics('test', { action: 'read' }),
    );
    if (
      result.state.debugger.paused &&
      result.state.debugger.stackFrames[0]?.line === 4
    )
      break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(result.state.debugger.stackFrames[0].line, 4);
  await app.evaluate(() =>
    globalThis.fixture.browser.diagnostics('test', {
      action: 'debug',
      command: 'resume',
    }),
  );
  assert.equal(await app.evaluate(() => globalThis.fixture.evaluation), 4);
  // Pause again, then let the actual DevTools frontend own and resume it.
  await app.evaluate(() => {
    globalThis.fixture.gapResult = undefined;
    void globalThis.fixture.window.contentView.children[0].webContents
      .executeJavaScript('breakpointFixture()')
      .then((value) => {
        globalThis.fixture.gapResult = value;
      });
  });
  for (let i = 0; i < 50; i++) {
    result = await app.evaluate(() =>
      globalThis.fixture.browser.diagnostics('test', { action: 'read' }),
    );
    if (result.state.debugger.paused) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(result.state.debugger.paused, true);
  const gapReference = result.state.debugger.stackFrames[0].scopes.find(
    (scope) => scope.name === 'local',
  ).variablesReference;
  await app.evaluate(() =>
    globalThis.fixture.browser.diagnostics('test', { action: 'devtools' }),
  );
  result = await app.evaluate(() =>
    globalThis.fixture.browser.diagnostics('test', { action: 'read' }),
  );
  assert.equal(result.state.owner, 'devtools');
  // The new DevTools client may resume on initialization. Otherwise use its
  // real frontend shortcut, never a second CDP connection to the guest.
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (await app.evaluate(() => globalThis.fixture.gapResult === undefined)) {
    await app.evaluate(() => {
      const guest =
        globalThis.fixture.window.contentView.children[0].webContents;
      const frontend = guest.devToolsWebContents;
      if (!frontend) throw Error('owned DevTools frontend missing');
      frontend.focus();
      frontend.sendInputEvent({ type: 'keyDown', keyCode: 'F8' });
      frontend.sendInputEvent({ type: 'keyUp', keyCode: 'F8' });
    });
  }
  for (let i = 0; i < 50; i++) {
    if (await app.evaluate(() => globalThis.fixture.gapResult === 4)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    await app.evaluate(() => globalThis.fixture.gapResult),
    4,
    'actual page resumed during DevTools ownership gap',
  );
  await app.evaluate(() =>
    globalThis.fixture.window.contentView.children[0].webContents.closeDevTools(),
  );
  for (let i = 0; i < 50; i++) {
    result = await app.evaluate(() =>
      globalThis.fixture.browser.diagnostics('test', { action: 'read' }),
    );
    if (result.state.owner === 'circle') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(result.state.owner, 'circle');
  assert.equal(
    result.state.debugger.paused,
    false,
    'reconnect must not restore stale paused state',
  );
  assert.deepEqual(result.state.debugger.stackFrames, []);
  const stale = await app.evaluate(async (_, reference) => {
    try {
      await globalThis.fixture.browser.diagnostics('test', {
        action: 'debug',
        command: 'variables',
        reference,
      });
      return null;
    } catch (error) {
      return String(error);
    }
  }, gapReference);
  assert.match(stale, /stale variable reference/);
  await app.evaluate(() =>
    globalThis.fixture.window.contentView.children[0].webContents.executeJavaScript(
      `console.log('after reconnect')`,
    ),
  );
  result = await app.evaluate(() =>
    globalThis.fixture.browser.diagnostics('test', { action: 'read' }),
  );
  assert(result.state.console.some((e) => e.text === 'after reconnect'));
  if (output)
    await writeFile(
      join(output, 'native-final-state.json'),
      JSON.stringify(result, null, 2),
    );
  console.log(
    'PASS native diagnostics: actual console/network, storage mutation,375×812 viewport,actual breakpoint/variables/step/resume,DevTools handoff and reconnect',
  );
} finally {
  if (app) await app.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
