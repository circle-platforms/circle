// Serialized native-driver regression, synthetic loopback page and isolated profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'circle-diagnostics-'));
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<!doctype html><meta name="viewport" content="width=device-width"><script>localStorage.setItem('fixture','before');console.error('fixture console');fetch('/request');function breakpointFixture(){const count=3;return count+1;}window.breakpointFixture=breakpointFixture;</script><button>local fixture</button>`,
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
  await app.evaluate(() =>
    globalThis.fixture.browser.diagnostics('test', { action: 'viewport' }),
  );
  await app.evaluate(() =>
    globalThis.fixture.browser.diagnostics('test', { action: 'devtools' }),
  );
  result = await app.evaluate(() =>
    globalThis.fixture.browser.diagnostics('test', { action: 'read' }),
  );
  assert.equal(result.state.owner, 'devtools');
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
  await app.evaluate(() =>
    globalThis.fixture.window.contentView.children[0].webContents.executeJavaScript(
      `console.log('after reconnect')`,
    ),
  );
  result = await app.evaluate(() =>
    globalThis.fixture.browser.diagnostics('test', { action: 'read' }),
  );
  assert(result.state.console.some((e) => e.text === 'after reconnect'));
  console.log(
    'PASS native diagnostics: actual console/network, storage mutation,375×812 viewport,DevTools handoff and reconnect',
  );
} finally {
  if (app) await app.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
