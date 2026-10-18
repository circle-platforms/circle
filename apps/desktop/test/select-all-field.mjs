// A real Electron window: the Edit menu's selectAll role takes Ctrl+A before
// the field's keydown. The production menu item has no accelerator.
// Linux CI starts Xvfb with no window manager (workbench.yml, and xvfb-run in
// the release job). xdotool windowactivate needs _NET_ACTIVE_WINDOW and fails
// there. webContents.sendInputEvent reaches before-input-event, which is
// where Electron matches a menu accelerator on Linux, without that focus.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-select-all-'));
const pageFile = join(temp, 'field.html');
const mainFile = join(temp, 'main.cjs');
await writeFile(
  pageFile,
  `<!doctype html><meta charset="utf-8"><title>select all</title>
<input id="program" value="src/stats.js" />
<script>
  window.sawSelectAll = false;
  document.getElementById('program').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
      window.sawSelectAll = true;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.select();
    }
  }, true);
</script>`,
);
await writeFile(
  mainFile,
  `const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
app.setPath('userData', ${JSON.stringify(join(temp, 'data'))});
let window;
function selectField() {
  return window.webContents.executeJavaScript(${JSON.stringify(`(() => {
    const node = document.activeElement;
    if (
      (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) &&
      !node.disabled &&
      !node.readOnly
    ) {
      node.select();
      return 'field';
    }
    document.execCommand('selectAll');
    return 'page';
  })()`)}, true);
}
function setMenu(mode) {
  const selectAll = mode === 'role'
    ? { role: 'selectAll', label: 'Select All' }
    : { label: 'Select All', click: () => { void selectField(); } };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Edit', submenu: [selectAll] },
  ]));
}
globalThis.setMenu = setMenu;
app.whenReady().then(async () => {
  window = new BrowserWindow({
    show: true,
    title: 'circle-select-all',
    width: 800,
    height: 600,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setMenu('role');
  const seen = [];
  window.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'a' || input.key === 'A' || input.code === 'KeyA')
      seen.push({ type: input.type, control: input.control, meta: input.meta, prevented: event.defaultPrevented });
  });
  globalThis.inputSeen = () => seen.splice(0);
  await window.loadFile(${JSON.stringify(pageFile)});
  window.focus();
  window.webContents.focus();
});
app.on('window-all-closed', () => app.quit());
`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (!env.DISPLAY) env.DISPLAY = ':1';
let app;
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [mainFile],
    env,
  });
  const page = await app.firstWindow();
  await page.locator('#program').waitFor();
  const read = () =>
    page.locator('#program').evaluate((input) => ({
      start: input.selectionStart,
      end: input.selectionEnd,
      length: input.value.length,
      saw: window.sawSelectAll,
    }));
  const nativeChord = async () => {
    await page.locator('#program').evaluate((input) => input.focus());
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      for (const type of ['keyDown', 'char', 'keyUp'])
        contents.sendInputEvent({
          type,
          keyCode: 'A',
          modifiers: ['control'],
        });
    });
  };
  const press = async (mode) => {
    await app.evaluate((_, mode) => globalThis.setMenu(mode), mode);
    await page.locator('#program').click();
    await page.locator('#program').press('End');
    await page.evaluate(() => {
      window.sawSelectAll = false;
    });
    await nativeChord();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const selection = await read();
    const seen = await app.evaluate(() => globalThis.inputSeen());
    return { ...selection, seen };
  };
  // Linux Electron 44 still delivers Ctrl+A through the selectAll role. macOS
  // handles that role in the menu before the page, so production registers none.
  const role = await press('role');
  const field = await press('field');
  const clicked = await (async () => {
    await page.locator('#program').click();
    await page.locator('#program').press('End');
    await page.evaluate(() => {
      window.sawSelectAll = false;
    });
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().items[0].submenu.items[0];
      item.click();
    });
    await page.waitForFunction(
      () => {
        const input = document.getElementById('program');
        return (
          input.selectionStart === 0 &&
          input.selectionEnd === input.value.length
        );
      },
      undefined,
      { timeout: 2000 },
    );
    return read();
  })();
  assert.deepEqual(
    [field.start, field.end],
    [0, field.length],
    'Ctrl+A with the production menu selects the field: ' +
      JSON.stringify({ role, field }),
  );
  assert.equal(field.saw, true, JSON.stringify(field));
  assert.ok(
    field.seen.some((input) => input.type === 'keyDown' && input.control),
    JSON.stringify(field),
  );
  assert.deepEqual([clicked.start, clicked.end], [0, clicked.length]);
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
