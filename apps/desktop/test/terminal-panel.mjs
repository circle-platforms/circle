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

// One console server: greets and records the lines it is given, and counts the ^K
// bytes (Ctrl+K) that reach it.
const typed = [];
const received = [];
let controlK = 0;
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
      if (byte === 11) controlK++;
      if (byte === 10 || byte === 13 || (byte >= 32 && byte < 127))
        text += String.fromCharCode(byte);
    }
    if (text) received.push(text);
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
const longProfile =
  'a synthetic console with a very long name for Windows ellipsis verification';
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
      {
        name: longProfile,
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
  // A console that appears opens the terminal mode on its own, except in a narrow window
  // (1050 px or less, as a Windows runner's screen gives), where it waits for the top-bar
  // button; the button toggles it either way.
  const narrow = await page.evaluate(
    () => matchMedia('(max-width: 1050px)').matches,
  );
  const button = page.getByRole('button', {
    name: 'terminal panel',
    exact: true,
  });
  if (narrow) {
    // Had it opened, this click would close it and the wait below would fail.
    assert.equal(
      await page.locator('.term-tabbar').isVisible(),
      false,
      'a console does not open the terminal over a narrow window',
    );
    await button.click();
  }
  await page.locator('.term-tabbar').waitFor({ timeout: 15000 });
  await button.click();
  await page.locator('.term-tabbar').waitFor({ state: 'hidden' });
  await button.click();
  // The console is a tab of the row, named by the device, and in front when no shell is.
  const rack = page
    .locator('.term-tab-main')
    .filter({ hasText: 'rack · Telnet' });
  await rack.waitFor();
  const screen = page.locator('.device-screen .xterm');
  await screen.waitFor({ state: 'visible', timeout: 15000 });
  const shown = await page.evaluate(
    ({ id, one }) =>
      window.circleDesktop.terminalSnapshot(id, one).then((raw) => atob(raw)),
    { id: session, one: 't1' },
  );
  if (!shown.includes('TELNET panel fixture'))
    failures.push(`the screen snapshot missed the banner: ${shown}`);
  // A console the person opened from the panel is theirs to type in from its
  // first line: the row already offers to give it back to Circle.
  await page.getByRole('button', { name: 'give back', exact: true }).waitFor();
  const held = await page.evaluate(
    (id) => window.circleDesktop.terminalState(id),
    session,
  );
  assert.equal(
    held.sessions[0].held,
    'attach',
    'a panel connect starts in the hands of the person who opened it',
  );
  // A key typed within about 50ms of a click in the screen, while a render
  // pulls focus back to the composer. Waiting for the xterm to be focused
  // first would miss that race. The character must not stay in the draft.
  const composer = page.getByRole('textbox', { name: 'message', exact: true });
  // Filled without a click: in a narrow window the terminal lies over the
  // conversation, and its screen is what a click there would hit.
  await composer.fill('stays in the composer');
  const deviceScreen = page.locator('.device-screen:not([hidden])');
  await deviceScreen.locator('.xterm-screen').click({ delay: 0 });
  const deviceTyping = page.keyboard.type('abc', { delay: 12 });
  await page.evaluate(() => {
    setTimeout(() => {
      document.querySelector('.composer textarea')?.focus();
    }, 25);
  });
  await deviceTyping;
  await until(
    () => received.join('').includes('abc'),
    'the keys after the click reached the device',
  );
  assert.equal(await composer.inputValue(), 'stays in the composer');
  // Those keys are sitting in the console's line. End it, or the next line joins them.
  await page.evaluate(
    ({ id, one }) => window.circleDesktop.terminalInput(id, one, '\r'),
    { id: session, one: 't1' },
  );
  await until(() => typed.includes('abc'), 'the click keys became a line');
  await page.evaluate(
    ({ id, one }) => window.circleDesktop.terminalInput(id, one, 'show ver\r'),
    { id: session, one: 't1' },
  );
  await until(() => typed.includes('show ver'), 'the panel keystroke');
  // A key typed into the console is the device's (#155): on Windows and Linux
  // Ctrl+K reaches it once as ^K and opens no search; on macOS ⌘K is no terminal
  // key and opens search from the console.
  const keys = page.locator(
    '.device-screen:not([hidden]) .xterm-helper-textarea',
  );
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '.device-screen:not([hidden]) textarea[disabled]',
      ),
  );
  await keys.focus();
  const searchOpen = () =>
    page.evaluate(() => !!document.querySelector('[role="dialog"]'));
  if (process.platform === 'darwin') {
    await page.keyboard.press('Meta+k');
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !document.querySelector('[role="dialog"]'),
    );
    assert.equal(controlK, 0, '⌘K reached the device');
  } else {
    await page.keyboard.press('Control+k');
    await until(() => controlK > 0, 'Ctrl+K at the device');
    // The device's echo of the key, at most, follows: the window stays as it was.
    await page.evaluate(
      () =>
        new Promise((done) => requestAnimationFrame(() => setTimeout(done))),
    );
    assert.equal(controlK, 1, 'Ctrl+K reached the device once');
    assert.equal(
      await searchOpen(),
      false,
      'Ctrl+K in the console opened search',
    );
  }
  // Take it back for Circle: the model's actions may run again, and the person's
  // keys stop reaching the device until they take it again.
  await page.getByRole('button', { name: 'give back', exact: true }).click();
  await page.getByRole('button', { name: 'take over', exact: true }).waitFor();
  const free = await page.evaluate(
    (id) => window.circleDesktop.terminalState(id),
    session,
  );
  assert.equal(free.sessions[0].held, '');
  // A person reaches a device by address, with no saved profile: quick connect.
  await page.getByRole('button', { name: 'new terminal or device' }).click();
  await page.getByRole('menuitem', { name: /connect new device/ }).click();
  const form = page.locator('.term-connect');
  await form.getByRole('button', { name: 'Telnet', exact: true }).click();
  await form.getByLabel('address').fill('127.0.0.1');
  await form.getByLabel('port').fill(String(devicePort));
  await form.getByRole('button', { name: 'connect', exact: true }).click();
  // The console the person connected gets its own tab, named by the device.
  const quick = page
    .locator('.term-tab')
    .filter({ hasText: `127.0.0.1` })
    .filter({ hasNotText: 'rack' });
  await quick.waitFor();
  // The tabs are the consoles: closing one disconnects only that device.
  await quick.getByRole('button', { name: /^disconnect / }).click();
  await quick.waitFor({ state: 'hidden' });
  const left = await page.evaluate(
    (id) => window.circleDesktop.terminalState(id),
    session,
  );
  assert.equal(
    left.sessions.filter((row) => row.state === 'ready').length,
    1,
    'closing a tab disconnects only that console',
  );
  // A console is worth the whole workspace, as the browser page is; a narrow window
  // offers no full view to any panel.
  if (narrow)
    assert.equal(
      await page
        .getByRole('button', { name: 'full view', exact: true })
        .count(),
      0,
      'no full view in a narrow window',
    );
  else {
    await page.getByRole('button', { name: 'full view', exact: true }).click();
    await page.locator('.workspace-content.whole').waitFor();
    await page
      .getByRole('button', { name: 'exit full view', exact: true })
      .click();
    await page.locator('.workspace-content.whole').waitFor({ state: 'hidden' });
  }
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
  // Saved display names are content, including spaces. The menu must connect the
  // actual profile, and its long tab keeps a close control beside the ellipsis.
  await page.getByRole('button', { name: 'new terminal or device' }).click();
  await page.getByRole('menuitem').filter({ hasText: longProfile }).click();
  const longTab = page.locator('.term-tab').filter({ hasText: longProfile });
  await longTab.waitFor();
  const connected = await page.evaluate(
    (id) => window.circleDesktop.terminalState(id),
    session,
  );
  assert.equal(connected.sessions.at(-1).name, longProfile);
  assert.equal(connected.sessions.at(-1).state, 'ready');
  const label = await longTab.locator('.term-tab-label').evaluate((node) => ({
    overflow: getComputedStyle(node).textOverflow,
    clipped: node.scrollWidth > node.clientWidth,
  }));
  assert.deepEqual(label, { overflow: 'ellipsis', clipped: true });
  await longTab.getByRole('button', { name: /^disconnect / }).click();
  await longTab.waitFor({ state: 'hidden' });
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
