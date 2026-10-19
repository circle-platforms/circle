// The browser and the terminal in windows of their own, in the running window: the
// pop-out and put-back buttons, the page that moves with its window and back, the button
// that brings a window forward, and the windows that close when another conversation is
// shown. In such a window: its notices, the theme and text size it follows, a screenshot
// or a terminal selection that goes to the main window's message box, browser keys that
// stay with the window whose panel has the keyboard, and an address an extension opens.
// The development app; the packaged one is covered by the live checks.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { readModelRequests } from './helpers/model-requests.mjs';
import { patience } from './helpers/patience.mjs';
if (
  process.env.CIRCLE_DESKTOP_EXECUTABLE ||
  (process.getuid?.() === 0 && !process.env.DISPLAY_WRAPPER)
) {
  console.log('SKIP popout harness: needs a desktop-capable session');
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-popout-'));
const dataDir = join(temp, 'data');
await mkdir(join(dataDir, 'runtime-home'), { recursive: true });
const workspace = join(temp, 'project');
await mkdir(workspace, { recursive: true });
// Pages to show: the browser only reaches http and https.
const site = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(
    request.url.startsWith('/live')
      ? '<!doctype html><title>extension link fixture</title><h1>opened by an extension</h1>'
      : '<!doctype html><title>pop</title><h1 id="mark">popped page</h1>',
  );
});
await new Promise((done) => site.listen(0, '127.0.0.1', done));
const address = `127.0.0.1:${site.address().port}`;
const pageUrl = `http://${address}/`;
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
const until = async (check, what, ms = 20000) => {
  const stop = Date.now() + patience(ms);
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= stop) throw Error(`timed out: ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
};
const mac = process.platform === 'darwin';
// The browser's command key: ⌘ on macOS, Ctrl elsewhere.
const commandKey = mac ? 'meta' : 'control';
let app;
let liveApp;
try {
  app = await electron.launch({
    executablePath: require('electron'),
    chromiumSandbox: true,
    args: [join(root, 'dist', 'main.cjs')],
    env,
    timeout: 60000,
  });
  // Whatever a window sends, nothing may throw in the main process.
  await app.evaluate(() => {
    globalThis.mainProcessErrors = [];
    process.on('uncaughtException', (error) =>
      globalThis.mainProcessErrors.push(String(error)),
    );
  });
  const main = await app.firstWindow();
  await main.waitForFunction(() => !!window.circleDesktop, null, {
    timeout: 30000,
  });
  await main.locator('.topbar').waitFor({ timeout: 30000 });
  await main.setViewportSize?.({ width: 1500, height: 900 });
  const titles = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((one) => !one.isDestroyed() && !one.webContents.isDestroyed())
        .map((one) => one.getTitle()),
    );
  // The application's windows by what they show: the main one, or a mode's route. A window
  // that is closing stays listed for a moment after its page is gone, so only live ones count.
  const views = () =>
    app.evaluate(({ BrowserWindow }) => {
      const count = { main: 0, browser: 0, terminal: 0 };
      for (const one of BrowserWindow.getAllWindows().filter(
        (one) => !one.isDestroyed() && !one.webContents.isDestroyed(),
      )) {
        const url = one.webContents.getURL();
        const which = url.includes('#/popout/browser/')
          ? 'browser'
          : url.includes('#/popout/terminal/')
            ? 'terminal'
            : 'main';
        count[which] += one.contentView.children.length;
      }
      return count;
    });
  const windowsOf = async (hash) =>
    app.windows().filter((one) => one.url().includes(hash));
  // A key pressed in one window, as the system hands it to that window's page.
  const press = (which, keyCode, modifiers = []) =>
    app.evaluate(
      ({ BrowserWindow }, { which, keyCode, modifiers }) => {
        const target = BrowserWindow.getAllWindows()
          .filter((one) => !one.isDestroyed() && !one.webContents.isDestroyed())
          .find((one) => {
            const url = one.webContents.getURL();
            return which === 'main'
              ? !url.includes('#/popout/')
              : url.includes(which);
          });
        for (const type of ['keyDown', 'keyUp'])
          target.webContents.sendInputEvent({ type, keyCode, modifiers });
      },
      { which, keyCode, modifiers },
    );

  // ---- a conversation whose title is too long for a window's title still pops out
  await main.getByRole('textbox', { name: 'message', exact: true }).click();
  await main.keyboard.press('F2');
  const rename = main.locator('.session-rename');
  await rename.waitFor();
  const longTitle = 'a conversation whose title runs on and on '
    .repeat(7)
    .trim();
  assert.ok(longTitle.length > 200);
  await rename.fill(longTitle);
  await rename.press('Enter');
  await rename.waitFor({ state: 'detached' });

  // ---- the browser leaves the drawer
  await main
    .getByRole('button', { name: 'browser panel', exact: true })
    .click();
  await main.locator('.native-browser').waitFor();
  await main
    .locator('.inspector .browser-address')
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  let popped = await until(
    async () => (await windowsOf('#/popout/browser/'))[0],
    'the browser window',
  );
  const sessionId = popped.url().split('/').at(-1);
  await popped.locator('.native-browser').waitFor();
  assert.equal(
    await popped
      .getByRole('button', { name: 'put back in the drawer' })
      .count(),
    1,
  );
  assert.equal(
    await popped.getByRole('button', { name: 'full view' }).count(),
    0,
    'a window of its own has no full view',
  );
  const title = (await titles()).find((one) => one.startsWith('browser · '));
  assert.ok(title, 'the window is titled for the mode and the conversation');
  assert.ok(title.length <= 200, 'and the title is cut short to fit');
  assert.ok(title.startsWith('browser · a conversation whose title runs on'));
  assert.ok(title.endsWith('…'));
  // The drawer let go of the mode, and its button is marked.
  await main.locator('.work-drawer').waitFor({ state: 'hidden' });
  await main.locator('.drawer-mode-button.popped').waitFor();

  // A page opened in the window is in that window.
  const field = () => popped.getByRole('textbox', { name: 'browser address' });
  const browserState = () =>
    popped.evaluate((id) => window.circleDesktop.browserState(id), sessionId);
  await field().fill(pageUrl);
  await field().press('Enter');
  await until(
    async () => (await views()).browser >= 1,
    'the page in the popout',
  );
  assert.equal(
    (await views()).main,
    0,
    'the page left the main window with the browser',
  );
  await until(async () => {
    const state = await browserState();
    return state.title === 'pop' && !state.loading;
  }, 'the page loaded');

  // ---- the window shows its notices, on its bar where the page cannot cover them
  await field().fill('http://exa mple');
  await field().press('Enter');
  const notice = popped.locator('.toast');
  await notice.getByText('invalid address', { exact: true }).waitFor();
  const page = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()
      .filter((one) => !one.isDestroyed() && !one.webContents.isDestroyed())
      .find((one) => one.webContents.getURL().includes('#/popout/browser/'));
    return window.contentView.children
      .find((view) => view.getVisible())
      ?.getBounds();
  });
  const box = await notice.boundingBox();
  assert.ok(page && box, 'the page and the notice are both shown');
  assert.ok(
    box.y + box.height <= page.y,
    `the notice (${box.y}+${box.height}) is above the page (${page.y})`,
  );

  // ---- a screenshot taken in the window goes into the main window's message box
  await popped
    .getByRole('button', { name: 'browser menu', exact: true })
    .click();
  await popped
    .getByRole('menuitem', { name: 'take page screenshot', exact: true })
    .click();
  await notice.getByText('added to the message box', { exact: true }).waitFor();
  const chips = main.locator('.attachment-strip .file-chip');
  await chips.filter({ hasText: /^127\.0\.0\.1 \d\d:\d\d\.png$/ }).waitFor();
  const kept = await main.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem('circle.workbench.preview.v1'))
        .sessions.find((session) => session.id === id)
        .attachments.map(({ kind, mime, name, size, content }) => ({
          kind,
          mime,
          name,
          size,
          png: content.startsWith('data:image/png;base64,'),
        })),
    sessionId,
  );
  assert.equal(
    kept.length,
    1,
    'kept with the conversation, where its draft is',
  );
  assert.deepEqual(
    [kept[0].kind, kept[0].mime, kept[0].png],
    ['image', 'image/png', true],
  );
  assert.ok(kept[0].size > 0);
  // Only a window of its own adds to a message box this way, only to its own
  // conversation's, and only what its mode makes.
  const attach = (from, id, value) =>
    from.evaluate(
      async ({ id, value }) => {
        try {
          return { saved: await window.circleDesktop.popoutAttach(id, value) };
        } catch (error) {
          return { error: String(error.message) };
        }
      },
      { id, value },
    );
  const text = 'CIRCLE_POPOUT_SELECTION';
  const selection = {
    id: 'terminal-selection:' + randomUUID(),
    name: 'zsh · selection',
    kind: 'file',
    mime: 'text/plain',
    size: text.length,
    content: text,
  };
  assert.match(
    (await attach(main, sessionId, selection)).error,
    /untrusted IPC sender/,
  );
  assert.match(
    (await attach(popped, 'another-conversation', selection)).error,
    /invalid conversation/,
  );
  assert.match(
    (await attach(popped, sessionId, selection)).error,
    /invalid attachment/,
  );
  assert.equal(await chips.count(), 1);

  // ---- browser keys belong to the window whose panel has the keyboard
  const tabs = async () => (await browserState()).tabs?.length ?? 0;
  await field().fill(pageUrl);
  await field().press('Enter');
  await until(async () => {
    const state = await browserState();
    return state.url === pageUrl && !state.failure && !state.loading;
  }, 'the page again');
  await field().click();
  const before = await tabs();
  // In the main window the same keys are its own, as if there were no browser: they
  // reach its page, and the window's page is left alone.
  await main.evaluate(() => {
    document.activeElement?.blur();
    window.keysSeen = [];
    addEventListener(
      'keydown',
      (event) => window.keysSeen.push(event.key.toLowerCase()),
      true,
    );
  });
  for (const [keyCode, modifiers] of [
    ['T', [commandKey]],
    ['L', [commandKey]],
    ['F5', []],
    ['F12', []],
  ])
    await press('main', keyCode, modifiers);
  await main.waitForFunction(() =>
    ['t', 'l', 'f5', 'f12'].every((key) => window.keysSeen.includes(key)),
  );
  assert.equal(await tabs(), before, 'no tab opened in the window');
  assert.equal((await browserState()).devTools ?? false, false);
  // In the window that has the page, they are the browser's: a new tab, closed again.
  await press('#/popout/browser/', 'T', [commandKey]);
  await until(async () => (await tabs()) === before + 1, 'a new tab');
  await press('#/popout/browser/', 'W', [commandKey]);
  await until(async () => (await tabs()) === before, 'the new tab closed');
  assert.equal((await windowsOf('#/popout/browser/')).length, 1);

  // ---- a bad id from a window never throws in the main process
  await main.evaluate(() =>
    window.circleDesktop.browserKeys('../not a conversation', true),
  );
  await popped.evaluate(() => window.circleDesktop.browserKeys('', false));
  assert.equal((await browserState()).sessionId, 'browser:' + sessionId);
  assert.deepEqual(await app.evaluate(() => globalThis.mainProcessErrors), []);

  // ---- the window follows the theme and the text size, and in auto the system
  const look = (target) =>
    target.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      size: document.documentElement.style.getPropertyValue('--ui-size'),
    }));
  await main.evaluate(() => {
    location.hash = '#/page/settings';
  });
  const themes = main.getByRole('group', { name: 'theme', exact: true });
  const sizes = main.getByRole('group', { name: 'text size', exact: true });
  for (const theme of ['dark', 'light']) {
    await themes.getByRole('button', { name: theme, exact: true }).click();
    await until(
      async () => (await look(popped)).theme === theme,
      `the window turns ${theme}`,
    );
  }
  await sizes.getByRole('button', { name: 'larger', exact: true }).click();
  await until(
    async () => (await look(popped)).size === '17px',
    'the window takes the larger text',
  );
  await sizes.getByRole('button', { name: 'default', exact: true }).click();
  await until(
    async () => (await look(popped)).size === '14px',
    'and the default text again',
  );
  await themes.getByRole('button', { name: 'auto', exact: true }).click();
  for (const scheme of ['dark', 'light']) {
    await popped.emulateMedia({ colorScheme: scheme });
    await until(
      async () => (await look(popped)).theme === scheme,
      `the window follows the system to ${scheme}`,
    );
  }
  await main.evaluate((id) => {
    location.hash = '#/session/' + id;
  }, sessionId);
  await main.locator('.drawer-mode-button.popped').waitFor();

  // The button of a popped mode brings its window forward instead of opening the drawer.
  await main.getByRole('button', { name: /browser panel/ }).click();
  assert.equal(await main.locator('.work-drawer').isVisible(), false);
  assert.equal(
    (await windowsOf('#/popout/browser/')).length,
    1,
    'no second window',
  );

  // ---- pressing the mode again while its window closes opens a window, not the closing one
  await main.evaluate(
    async ({ id, title }) =>
      Promise.all([
        window.circleDesktop.popoutDock('browser', id),
        window.circleDesktop.popoutOpen('browser', id, title),
      ]),
    { id: sessionId, title },
  );
  const closing = popped;
  popped = await until(async () => {
    const open = await windowsOf('#/popout/browser/');
    return closing.isClosed() && open.length === 1 && open[0];
  }, 'the closing window gone and a new one open');
  await popped.locator('.native-browser').waitFor();
  assert.deepEqual(await main.evaluate(() => window.circleDesktop.popouts()), [
    { kind: 'browser', sessionId },
  ]);
  await main.locator('.drawer-mode-button.popped').waitFor();
  await until(async () => (await views()).browser >= 1, 'the page moved along');
  assert.equal((await views()).main, 0);

  // Back into the drawer: the window goes, the page comes along. Its panel had the
  // keyboard, and the main window's keys are its own again.
  await popped.getByRole('button', { name: 'put back in the drawer' }).click();
  await until(
    async () => (await windowsOf('#/popout/browser/')).length === 0,
    'the window closes',
  );
  await until(async () => (await views()).main >= 1, 'the page is back');
  await main
    .locator('.drawer-mode-button.popped')
    .waitFor({ state: 'detached' });
  const tabsBack = (
    await main.evaluate(
      (id) => window.circleDesktop.browserState(id),
      sessionId,
    )
  ).tabs.length;
  await main.evaluate(() => {
    document.activeElement?.blur();
    window.keysSeen = [];
  });
  await press('main', 'T', [commandKey]);
  await main.waitForFunction(() => window.keysSeen.includes('t'));
  assert.equal(
    (
      await main.evaluate(
        (id) => window.circleDesktop.browserState(id),
        sessionId,
      )
    ).tabs.length,
    tabsBack,
  );

  // ---- the terminal, and a conversation switch that brings it back
  await main
    .getByRole('button', { name: 'terminal panel', exact: true })
    .click();
  await main.locator('.term-tabbar').waitFor();
  await main
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  const terminal = await until(
    async () => (await windowsOf('#/popout/terminal/'))[0],
    'the terminal window',
  );
  await terminal.locator('.term-tabbar').waitFor();
  await main.locator('.drawer-mode-button.popped').waitFor();
  // A terminal's window passes a selection to the main window's message box.
  assert.deepEqual(await attach(terminal, sessionId, selection), {
    saved: true,
  });
  await chips.filter({ hasText: 'zsh · selection' }).waitFor();
  assert.match(
    (await attach(terminal, sessionId, { ...selection, kind: 'image' })).error,
    /invalid attachment/,
  );
  const rows = main.locator('.sidebar .session-row');
  const at = await rows.count();
  assert.ok(at > 1, 'a second conversation to switch to');
  // Show another conversation: its windows are not shown, they come back.
  const here = await main.evaluate(() => location.hash);
  for (let index = 0; index < at; index++) {
    await rows.nth(index).click();
    if ((await main.evaluate(() => location.hash)) !== here) break;
  }
  await until(
    async () => (await windowsOf('#/popout/terminal/')).length === 0,
    'the terminal window closes with the conversation',
  );
  assert.deepEqual(await app.evaluate(() => globalThis.mainProcessErrors), []);
  await app.close();
  app = undefined;

  // ---- live: an extension's address, and a selection that reaches the model
  const liveData = join(temp, 'live');
  const home = join(liveData, 'runtime-home');
  const extension = join(home, 'extensions', 'linker');
  await mkdir(extension, { recursive: true });
  const link = `http://${address}/live`;
  await writeFile(
    join(extension, 'extension.mjs'),
    `export function register(api){api.registerCommand('openlab','open the lab page',async()=>{await api.openUrl(${JSON.stringify(link)})})}`,
  );
  const requestsPath = join(temp, 'model-requests.jsonl');
  const fixturePath = join(temp, 'model.json');
  await writeFile(
    fixturePath,
    JSON.stringify({
      requestsPath,
      replies: [
        { message: { id: 'seen', role: 'assistant', content: 'seen' } },
      ],
    }),
  );
  liveApp = await electron.launch({
    executablePath: require('electron'),
    chromiumSandbox: true,
    args: [join(root, 'dist', 'main.cjs')],
    env: {
      ...env,
      CIRCLE_HOME: join(temp, 'live-home'),
      CIRCLE_WORKBENCH_DATA_DIR: liveData,
      CIRCLE_WORKBENCH_MODE: 'live',
      CIRCLE_WORKBENCH_LANGUAGE: 'en',
      CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
      // A scripted model is accepted only in an explicit test profile.
      CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
    },
    timeout: 60000,
  });
  await liveApp.evaluate(({ app }) => {
    // UI Automation and screen readers can enable this on Windows. Exercise the
    // same input path rather than depending on the person's accessibility state.
    app.setAccessibilitySupportEnabled(true);
    globalThis.mainProcessErrors = [];
    process.on('uncaughtException', (error) =>
      globalThis.mainProcessErrors.push(String(error)),
    );
  });
  const live = await liveApp.firstWindow();
  const message = live.getByRole('textbox', { name: 'message', exact: true });
  await message.waitFor({ timeout: patience(30000) });
  const state = () =>
    live
      .evaluate(() => window.circleDesktop.runtimeState())
      .then((update) => update.snapshot);
  await until(
    async () =>
      (await state()).extensions.some((item) => item.name === 'linker'),
    'the extension loaded',
  );
  const liveSession = (await state()).activeSessionId;
  const openLab = () =>
    live.evaluate(
      (sessionId) =>
        window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name: 'custom-command',
          payload: { name: 'openlab' },
          sessionId,
        }),
      liveSession,
    );
  const liveWindows = (hash) =>
    liveApp.windows().filter((one) => one.url().includes(hash));
  // The conversation, with the mode buttons of its top bar
  await live.evaluate((id) => {
    location.hash = '#/session/' + id;
  }, liveSession);
  await live
    .getByRole('button', { name: 'browser panel', exact: true })
    .click();
  await live.locator('.native-browser').waitFor();
  await live
    .locator('.inspector .browser-address')
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  const liveBrowser = await until(
    async () => liveWindows('#/popout/browser/')[0],
    'the browser window',
  );
  await liveBrowser.locator('.native-browser').waitFor();
  await live.locator('.work-drawer').waitFor({ state: 'hidden' });
  const workspaceId = (await state()).sessions.find(
    (session) => session.id === liveSession,
  ).workspaceId;
  const listings = await Promise.all(
    [live, liveBrowser].map((page) =>
      page.evaluate(
        (id) => window.circleDesktop.listWorkspace(id),
        workspaceId,
      ),
    ),
  );
  assert.ok(
    listings.every((listing) => listing && Array.isArray(listing.files)),
    'main and pop-out can discover the workspace concurrently',
  );
  // An address an extension opens goes to the browser's window, as it would to the drawer.
  const liveAddress = liveBrowser.getByRole('textbox', {
    name: 'browser address',
  });
  const opened = async () => {
    const browser = await liveBrowser.evaluate(
      (id) => window.circleDesktop.browserState(id),
      liveSession,
    );
    return (
      browser.url === link &&
      !browser.loading &&
      browser.title === 'extension link fixture' &&
      (await liveAddress.inputValue()) === link
    );
  };
  assert.equal((await openLab()).ok, true);
  await until(opened, 'the address opened in the browser window');
  assert.equal(liveWindows('#/popout/browser/').length, 1, 'no second window');
  assert.equal(await live.locator('.work-drawer').isVisible(), false);
  // Asked again after the person went elsewhere, it opens again.
  await liveAddress.fill(`http://${address}/elsewhere`);
  await liveAddress.press('Enter');
  await until(
    async () =>
      (
        await liveBrowser.evaluate(
          (id) => window.circleDesktop.browserState(id),
          liveSession,
        )
      ).title === 'pop',
    'another page',
  );
  assert.equal((await openLab()).ok, true);
  await until(opened, 'the address opened again');

  // A selection in the terminal's window goes into the main window's message box, and
  // with the next message to the model.
  await live
    .getByRole('button', { name: 'terminal panel', exact: true })
    .click();
  await live.locator('.term-tabbar').waitFor();
  await live
    .locator('[data-inspector-resource="terminal"]')
    .getByRole('button', { name: 'open in a window', exact: true })
    .click();
  const liveTerminal = await until(
    async () => liveWindows('#/popout/terminal/')[0],
    'the terminal window',
  );
  await liveTerminal
    .getByRole('button', { name: 'new terminal', exact: true })
    .click();
  const input = liveTerminal.locator('.xterm-helper-textarea');
  await input.waitFor({ timeout: patience(20000) });
  await liveTerminal.locator('.xterm-accessibility').waitFor();
  const mark = `CIRCLE_POPOUT_MARK_${Date.now()}`;
  await input.focus();
  // xterm intentionally ignores insertText's input-only event in screen-reader
  // mode. Actual typing includes key events, as the person's keyboard does.
  await liveTerminal.keyboard.type(`echo ${mark}`);
  await liveTerminal.keyboard.press('Enter');
  // Find reads what the shell has printed when it is asked, so it waits for the mark's
  // own line of output, which a slow shell prints later.
  await until(
    () =>
      liveTerminal
        .locator('.native-terminal-surface:not([hidden]) .xterm-rows > div')
        .evaluateAll(
          (rows, mark) => rows.some((row) => row.textContent.trim() === mark),
          mark,
        ),
    'the shell printed the mark',
  );
  await liveTerminal
    .getByRole('button', { name: 'terminal menu', exact: true })
    .click();
  await liveTerminal
    .getByRole('menuitem', { name: 'find in terminal', exact: true })
    .click();
  const find = liveTerminal.getByRole('textbox', {
    name: 'find in terminal',
    exact: true,
  });
  await find.waitFor();
  await find.fill(mark);
  await find.press('Enter');
  await until(
    async () =>
      (await liveTerminal.locator('.xterm-selection div').count()) > 0,
    'the output selected',
  );
  await liveTerminal
    .getByRole('button', { name: 'terminal menu', exact: true })
    .click();
  await liveTerminal
    .getByRole('menuitem', { name: 'add selection to chat', exact: true })
    .click();
  await liveTerminal
    .locator('.toast')
    .getByText('terminal selection added to draft', { exact: true })
    .waitFor();
  await live
    .locator('.attachment-strip .file-chip')
    .filter({ hasText: / · selection$/ })
    .waitFor();
  await message.fill('what does the terminal say?');
  await message.press('Enter');
  await until(async () => {
    if (!existsSync(requestsPath)) return false;
    const requests = await readModelRequests(requestsPath);
    return requests.some((request) =>
      JSON.stringify(request.messages).includes(mark),
    );
  }, 'the selection in the next model request');
  // Live, the theme is the runtime's setting and the text size the main window's own:
  // the terminal's window follows both.
  await live.evaluate(() => {
    location.hash = '#/page/settings';
  });
  const shown = (await look(liveTerminal)).theme;
  const other = shown === 'dark' ? 'light' : 'dark';
  await live
    .getByRole('group', { name: 'theme', exact: true })
    .getByRole('button', { name: other, exact: true })
    .click();
  await until(
    async () => (await look(liveTerminal)).theme === other,
    'the terminal window follows the theme',
  );
  await live
    .getByRole('group', { name: 'text size', exact: true })
    .getByRole('button', { name: 'large', exact: true })
    .click();
  await until(
    async () => (await look(liveTerminal)).size === '15px',
    'and the text size',
  );
  assert.deepEqual(
    await liveApp.evaluate(() => globalThis.mainProcessErrors),
    [],
  );
  console.log('popout: ok');
} catch (error) {
  // What each window showed, and what its terminals held, for a run that fails on CI.
  const evidence = join(root, 'artifacts', 'popout');
  await mkdir(evidence, { recursive: true }).catch(() => {});
  const windows = [
    ...(app?.windows() ?? []).map((page) => ['development', page]),
    ...(liveApp?.windows() ?? []).map((page) => ['live', page]),
  ];
  const screens = [];
  for (const [index, [which, page]] of windows.entries()) {
    const name = `${which}-${index}`;
    await page
      .screenshot({ path: join(evidence, `${name}.png`) })
      .catch(() => {});
    screens.push({
      name,
      url: page.url(),
      terminals: await page
        .locator('.native-terminal-surface')
        .evaluateAll((surfaces) =>
          surfaces.map((surface) => ({
            hidden: surface.hidden,
            rows: [...surface.querySelectorAll('.xterm-rows > div')].map(
              (row) => row.textContent,
            ),
          })),
        )
        .catch((reason) => String(reason)),
    });
  }
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify({ error: String(error?.stack ?? error), screens }, null, 2),
  ).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await liveApp?.close().catch(() => {});
  site.close();
  await rm(temp, { recursive: true, force: true });
}
