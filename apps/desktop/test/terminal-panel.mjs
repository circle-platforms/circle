// The terminal panel in the running window: the preload bridge, the main-process host and
// the xterm.js panel against a real Telnet console on 127.0.0.1, in the development app.
// The packaged application is covered by the live checks, as the browser's are.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
// This harness boots the real window: it needs a display and a sandbox-capable user.
// Where Electron cannot start (root without a setuid sandbox, as in CI containers) the
// headless terminal-host and terminal-runtime tests cover the same host and bridge.
if (
  process.env.CIRCLE_DESKTOP_EXECUTABLE ||
  (process.getuid?.() === 0 && !process.env.DISPLAY_WRAPPER)
) {
  console.log('SKIP terminal panel harness: needs a desktop-capable session');
  process.exit(0);
}
if (false) {
  console.log(
    'SKIP terminal panel harness: packaged application uses terminal-live',
  );
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-terminal-panel-'));
const dataDir = join(temp, 'data');
await mkdir(join(dataDir, 'runtime-home'), { recursive: true });

// One console server: greets and records the lines it is given.
const typed = [];
const sockets = new Set();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  let input = '';
  socket.on('data', (raw) => {
    // Telnet negotiation goes whole, including the IAC SB ... IAC SE payload:
    // dropping only the IAC bytes would leave the window size in the line, as
    // characters - an 80-column NAWS arrives with a stray P.
    let text = '';
    for (let at = 0; at < raw.length; at++) {
      const byte = raw[at];
      if (byte === 255) {
        const verb = raw[at + 1];
        if (verb === 250) {
          while (at < raw.length && !(raw[at] === 255 && raw[at + 1] === 240))
            at++;
          at++;
        } else if (verb >= 236 && verb <= 254) at += 2;
        continue;
      }
      if (byte === 10 || byte === 13 || (byte >= 32 && byte < 127))
        text += String.fromCharCode(byte);
    }
    input += text;
    let cut = input.search(/[\r\n]/);
    while (cut !== -1) {
      typed.push(input.slice(0, cut).trim());
      input = input.slice(cut + 1);
      cut = input.search(/[\r\n]/);
    }
  });
  socket.write(Buffer.from('TELNET panel fixture\r\ncon> ', 'utf8'));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const devicePort = server.address().port;

// The saved profile the panel lists and connects.
await writeFile(
  join(dataDir, 'runtime-home', 'terminal-sessions.json'),
  JSON.stringify({
    sessions: [
      {
        name: 'rack',
        transport: 'telnet',
        host: '127.0.0.1',
        port: devicePort,
      },
    ],
  }),
);

const workspace = join(temp, 'project');
await mkdir(workspace, { recursive: true });
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
const until = async (check, what, ms = 15000) => {
  const stop = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= stop) throw Error(`timed out: ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
};
let app;
const failures = [];
try {
  app = await electron.launch({
    executablePath: require('electron'),
    chromiumSandbox: true,
    args: [join(root, 'dist', 'main.cjs')],
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.circleDesktop, null, {
    timeout: 30000,
  });
  // the application routes by hash: circle://workbench/index.html#/session/<id>
  await page.waitForFunction(() => location.hash.includes('#/session/'), null, {
    timeout: 30000,
  });
  const session = new URL(page.url()).hash.split('/session/')[1];
  // The panel lists the saved profile before anyone connects
  const listed = await page.evaluate(() =>
    window.circleDesktop.terminalProfiles(),
  );
  assert.equal(listed[0].name, 'rack');
  // A panel connect reaches the device through the main-process host
  const state = await page.evaluate(
    ({ id, profile }) => window.circleDesktop.terminalConnect(id, profile),
    { id: session, profile: 'rack' },
  );
  assert.equal(state.sessions[0].state, 'ready');
  // The panel opens from the top bar and paints the device screen
  await page
    .getByRole('button', { name: 'device terminals panel', exact: true })
    .click();
  const screen = page.locator('.device-terminal .terminal-screen .xterm');
  await screen.waitFor({ state: 'visible', timeout: 15000 });
  const shown = await page.evaluate(
    ({ id, one }) =>
      window.circleDesktop.terminalSnapshot(id, one).then((raw) => atob(raw)),
    { id: session, one: 't1' },
  );
  if (!shown.includes('TELNET panel fixture'))
    failures.push(`the screen snapshot missed the banner: ${shown}`);
  // The person takes the console: their keys reach the device
  const held = await page.evaluate(
    ({ id, one }) => window.circleDesktop.terminalAttach(id, one),
    { id: session, one: 't1' },
  );
  assert.equal(held.sessions[0].held, 'attach');
  await page.evaluate(
    ({ id, one }) => window.circleDesktop.terminalInput(id, one, 'show ver\r'),
    { id: session, one: 't1' },
  );
  await until(() => typed.includes('show ver'), 'the panel keystroke');
  // Give it back: the model's actions may run again
  const free = await page.evaluate(
    ({ id, one }) => window.circleDesktop.terminalDetach(id, one),
    { id: session, one: 't1' },
  );
  assert.equal(free.sessions[0].held, '');
  // A disconnect closes the console; its last screen stays readable
  await page.evaluate(
    ({ id, one }) => window.circleDesktop.terminalDisconnect(id, one),
    { id: session, one: 't1' },
  );
  const closed = await page.evaluate(
    (id) => window.circleDesktop.terminalState(id),
    session,
  );
  assert.equal(closed.sessions[0].state, 'closed');
  // Strangers are gated at the bridge: an id that is not an id is refused
  const gated = await page
    .evaluate(() => window.circleDesktop.terminalState('../etc'))
    .then(
      () => '',
      (error) => String(error),
    );
  if (!/invalid conversation/.test(gated))
    failures.push(`a bad conversation id was not gated: ${gated}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  for (const socket of sockets) socket.destroy();
  server.close();
  await app?.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
if (failures.length) {
  console.error('terminal panel harness failed:');
  for (const failure of failures) console.error('  ' + failure);
  process.exit(1);
}
console.log('terminal panel harness ok');
