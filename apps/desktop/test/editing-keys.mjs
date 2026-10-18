// Issue #155 in the real sandboxed window: the system's editing keys in the
// conversation's input box, and the window's right-click menu. The keys go in as
// trusted key events (Playwright adds macOS's editing commands for ⌘C and ⌘V, as
// the system does for a person); the clipboard is the system's and is put back.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { patience } from './helpers/patience.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const mac = process.platform === 'darwin';
const temp = await mkdtemp(join(tmpdir(), 'circle-editing-keys-'));
const workspace = join(temp, 'project');
await mkdir(workspace);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_MODE: 'preview',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({ workspace }),
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.platform === 'linux' && !env.DISPLAY) env.DISPLAY = ':1';
const checks = [];
let app;
let clipboardBefore = false;
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(patience(10000));
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.focus();
  });
  // The person's clipboard, every item Electron reads, stays in the main process
  // and is written back when the test ends.
  clipboardBefore = await app.evaluate(async ({ clipboard }) => {
    globalThis.savedClipboard = await clipboard.read().catch(() => undefined);
    globalThis.savedClipboardText = await clipboard.readText();
    return true;
  });
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const box = page.getByRole('textbox', { name: 'message', exact: true });
  const command = mac ? 'Meta' : 'Control';
  const dialogOpen = () =>
    page.evaluate(() => !!document.querySelector('[role="dialog"]'));

  // Copy: the selection goes to the system clipboard and the draft stays.
  await app.evaluate(({ clipboard }) => clipboard.writeText('old clipboard'));
  await box.fill('alpha bravo');
  await box.evaluate((node) => node.setSelectionRange(0, 11));
  await box.press(command + '+c');
  const until = async (check, label) => {
    const end = Date.now() + patience(10000);
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) throw Error('timed out: ' + label);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await until(
    async () => (await clipboard()) === 'alpha bravo',
    'the copied draft on the clipboard',
  );
  assert.equal(await box.inputValue(), 'alpha bravo');
  checks.push(`${command}+C copies the selected draft and keeps it`);

  // Paste: the clipboard's text goes into the box.
  await app.evaluate(({ clipboard }) => clipboard.writeText(' charlie'));
  await box.evaluate((node) => node.setSelectionRange(11, 11));
  await box.press(command + '+v');
  await until(
    async () => (await box.inputValue()) === 'alpha bravo charlie',
    'the pasted text in the box',
  );
  checks.push(`${command}+V pastes the clipboard's text`);

  // Cut, select all and undo are the field's own.
  await box.press(command + '+a');
  assert.deepEqual(
    await box.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [0, 19],
  );
  await box.press(command + '+x');
  await until(
    async () => (await box.inputValue()) === '',
    'the cut draft gone from the box',
  );
  assert.equal(await clipboard(), 'alpha bravo charlie');
  await box.press(command + '+z');
  await until(
    async () => (await box.inputValue()) === 'alpha bravo charlie',
    'undo puts the cut draft back',
  );
  checks.push(`${command}+A, ${command}+X and ${command}+Z edit the draft`);

  if (mac) {
    // ⌘D is no longer ctrl+d: it does not ask to close the session, with or
    // without a draft. ⌘T and ⌘O change nothing either.
    await box.press('Meta+d');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    assert.equal(await dialogOpen(), false, '⌘D over a draft');
    assert.equal(await box.inputValue(), 'alpha bravo charlie');
    await box.fill('');
    await box.press('Meta+d');
    await box.press('Meta+t');
    await box.press('Meta+o');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    assert.equal(await dialogOpen(), false, '⌘D on an empty box');
    // A barrier: ⌃D on the empty box asks, so the ⌘ keys before it were handled.
    await box.press('Control+d');
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await dialogOpen(), false);
    checks.push('⌘D, ⌘T and ⌘O leave the box; ⌃D on an empty box still asks');
  }

  // The window's right-click menu. A popup would hold the main process: the menu
  // is kept to be read and chosen from.
  await app.evaluate(({ Menu }) => {
    globalThis.circleMenus = [];
    Menu.prototype.popup = function () {
      globalThis.circleMenus.push(this);
    };
  });
  const rightClick = async (locator) => {
    const box = await locator.boundingBox();
    const point = {
      x: Math.round(box.x + Math.min(box.width / 2, 20)),
      y: Math.round(box.y + box.height / 2),
    };
    await app.evaluate(({ BrowserWindow }, point) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      for (const event of [
        { type: 'mouseMove', ...point },
        { type: 'mouseDown', ...point, button: 'right', clickCount: 1 },
        { type: 'mouseUp', ...point, button: 'right', clickCount: 1 },
      ])
        contents.sendInputEvent(event);
    }, point);
  };
  const menus = () =>
    app.evaluate(() =>
      globalThis.circleMenus.map((menu) =>
        menu.items.map((item) =>
          item.type === 'separator'
            ? '-'
            : item.label + (item.enabled ? '' : ' (disabled)'),
        ),
      ),
    );
  // Chosen as a click would: the role acts on the window the menu belongs to.
  const choose = (label) =>
    app.evaluate(({ BrowserWindow }, label) => {
      const window = BrowserWindow.getAllWindows()[0];
      globalThis.circleMenus[0].items
        .find((item) => item.label === label)
        .click(undefined, window, window.webContents);
    }, label);
  const fieldMenu = async () => {
    await app.evaluate(() => globalThis.circleMenus.splice(0));
    await rightClick(box);
    await until(async () => (await menus()).length > 0, 'the field menu');
    return (await menus())[0];
  };
  await app.evaluate(({ clipboard }) => clipboard.writeText('menu paste'));
  await box.fill('');
  assert.deepEqual(await fieldMenu(), [
    'Cut (disabled)',
    'Copy (disabled)',
    'Paste',
    '-',
    'Select All (disabled)',
  ]);
  // Paste from the menu puts the clipboard's text in the box.
  await choose('Paste');
  await until(
    async () => (await box.inputValue()) === 'menu paste',
    'the menu paste in the box',
  );
  await box.evaluate((node) => node.setSelectionRange(0, 4));
  const selected = await fieldMenu();
  assert.deepEqual(selected, ['Cut', 'Copy', 'Paste', '-', 'Select All']);
  // Select All from the menu selects the whole draft.
  await choose('Select All');
  await until(
    () =>
      box.evaluate(
        (node) => node.selectionStart === 0 && node.selectionEnd === 10,
      ),
    'select all from the menu',
  );
  checks.push(
    'the input box has a right-click menu: cut, copy, paste and select all',
  );

  // Selected text in the conversation gets Copy; a click on nothing gets no menu.
  const heading = page.getByRole('heading', {
    name: 'Fix the reconnect race',
    exact: true,
  });
  await app.evaluate(() => globalThis.circleMenus.splice(0));
  await page.evaluate(() => document.activeElement?.blur());
  // An empty spot: no text under the pointer, so macOS selects no word there.
  await page.evaluate(() => {
    const spot = document.createElement('div');
    spot.id = 'empty-spot';
    spot.style.cssText =
      'position:fixed;left:200px;bottom:0;width:40px;height:40px;z-index:99999';
    document.body.append(spot);
  });
  await rightClick(page.locator('#empty-spot'));
  await heading.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await rightClick(heading);
  await until(async () => (await menus()).length > 0, 'the selection menu');
  // The empty spot came first and gave none: the selection's is the only menu.
  assert.deepEqual(await menus(), [['Copy']]);
  await page.evaluate(() => document.getElementById('empty-spot').remove());
  checks.push('selected text has Copy; elsewhere the window shows no menu');

  // The menu follows the window's language.
  await page.evaluate(() => window.circleDesktop.setLanguage('zh-CN'));
  await box.fill('');
  assert.deepEqual(await fieldMenu(), [
    '剪切 (disabled)',
    '拷贝 (disabled)',
    '粘贴',
    '-',
    '全选 (disabled)',
  ]);
  await page.evaluate(() => window.circleDesktop.setLanguage('en'));
  checks.push('the menu speaks Chinese when the window does');
  console.log(JSON.stringify({ platform: process.platform, checks }, null, 2));
} finally {
  if (app) {
    if (clipboardBefore)
      await app
        .evaluate(async ({ clipboard }) => {
          if (globalThis.savedClipboard?.length)
            await clipboard
              .write(globalThis.savedClipboard)
              .catch(() => clipboard.writeText(globalThis.savedClipboardText));
          else await clipboard.writeText(globalThis.savedClipboardText);
        })
        .catch(() => {});
    await app.close().catch(() => {});
  }
  await rm(temp, { recursive: true, force: true });
}
