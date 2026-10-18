import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage();
  await page.goto(
    server.resolvedUrls.local[0] +
      'test/native-editable-shortcuts-ui.html#/session/session1',
  );
  const box = page.getByRole('textbox', { name: 'message', exact: true });
  await box.waitFor();
  await page.evaluate(() => {
    window.keyResults = [];
    window.copyResults = [];
    window.addEventListener(
      'keydown',
      (event) => {
        const record = {
          key: event.key,
          meta: event.metaKey,
          ctrl: event.ctrlKey,
          trusted: event.isTrusted,
        };
        setTimeout(
          () =>
            window.keyResults.push({
              ...record,
              prevented: event.defaultPrevented,
            }),
          0,
        );
      },
      true,
    );
    window.addEventListener(
      'copy',
      (event) => {
        const box = document.activeElement;
        window.copyResults.push({
          trusted: event.isTrusted,
          text: box.value.slice(box.selectionStart, box.selectionEnd),
        });
        event.preventDefault();
      },
      true,
    );
  });
  // Catch the real browser copy event before it writes the host clipboard.
  for (const chord of ['Meta+c', 'Control+c']) {
    await box.fill('keep complete draft');
    await box.evaluate((node) => node.setSelectionRange(5, 13));
    await box.press(chord);
    assert.equal(await box.inputValue(), 'keep complete draft');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    if (
      (process.platform === 'darwin' && chord === 'Meta+c') ||
      (process.platform !== 'darwin' && chord === 'Control+c')
    )
      await page.waitForFunction(() => window.copyResults.length >= 1);
    assert.equal(await box.inputValue(), 'keep complete draft');
    assert.equal(
      await box.evaluate((n) => n.selectionEnd - n.selectionStart),
      8,
    );
  }
  assert.ok(
    (await page.evaluate(() => window.copyResults)).some(
      (event) => event.trusted && event.text === 'complete',
    ),
  );
  await box.fill('base');
  await box.press('End');
  await box.press('x');
  assert.equal(await box.inputValue(), 'basex');
  // The platform's own undo: Chromium on Linux and Windows does not undo on Meta+z.
  await box.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label=message]').value === 'base',
  );
  assert.equal(
    (await page.evaluate(() => window.editRequests)).filter(
      (r) => r.kind === 'suspend',
    ).length,
    0,
  );
  // Terminal/editor helper textareas keep their owning control's handling even
  // without a selection. This is a real bubbling key from the focused textarea.
  for (const owner of ['monaco-editor', 'native-terminal']) {
    await page.evaluate((owner) => {
      const wrap = document.createElement('div');
      wrap.className = owner;
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', 'owned editor');
      wrap.append(input);
      document.body.append(wrap);
    }, owner);
    const input = page.getByRole('textbox', {
      name: 'owned editor',
      exact: true,
    });
    await input.fill('owned');
    await input.press('Control+c');
    await input.press('Meta+z');
    await input.evaluate((n) => n.parentElement.remove());
    assert.equal(
      (await page.evaluate(() => window.editRequests)).filter(
        (r) => r.kind === 'suspend',
      ).length,
      0,
    );
    assert.equal(await box.inputValue(), 'base');
  }
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'outside editable';
    document.body.append(button);
  });
  await page
    .getByRole('button', { name: 'outside editable', exact: true })
    .press('Control+z');
  await page.waitForFunction(() =>
    window.editRequests.some((r) => r.kind === 'suspend'),
  );
  await page.evaluate(() =>
    window.editRuntime.change((state) => {
      state.settings.keybindings = { suspend: 'ctrl+shift+y' };
    }),
  );
  const beforeCustom = await page.evaluate(
    () => window.editRequests.filter((r) => r.kind === 'suspend').length,
  );
  await box.focus();
  await box.press('Control+Shift+y');
  await page.waitForFunction(
    (n) =>
      window.editRequests.filter((r) => r.kind === 'suspend').length === n + 1,
    beforeCustom,
  );
  await page.evaluate(() =>
    window.editRuntime.change((state) => {
      state.settings.keybindings = { clear: 'ctrl+shift+y' };
    }),
  );
  await box.fill('explicit custom clear');
  await box.evaluate((node) => node.setSelectionRange(0, 8));
  await box.press('Control+Shift+y');
  assert.equal(
    await box.inputValue(),
    '',
    'explicit non-native custom clear binding still executes inside the composer',
  );
  // Issue #155. On macOS ⌘ is the system's: none of the terminal's Control keys
  // answers to it, so ⌘D does not ask to close and ⌘T, ⌘O, ⌘G, ⌘R, ⌘Q, ⌘J run
  // nothing. Elsewhere Meta reads as Ctrl, as before, and these are not checked.
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  const dialogOpen = () =>
    page.evaluate(() => !!document.querySelector('[role="dialog"]'));
  await page.evaluate(() =>
    window.editRuntime.change((state) => {
      state.settings.keybindings = {};
    }),
  );
  await box.focus();
  if (mac) {
    await box.fill('alpha bravo');
    for (const chord of [
      'Meta+d',
      'Meta+t',
      'Meta+o',
      'Meta+g',
      'Meta+r',
      'Meta+q',
      'Meta+j',
    ]) {
      const before = await page.evaluate(() => window.editCommands.length);
      await box.press(chord);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
      assert.equal(await dialogOpen(), false, chord + ' opened a dialog');
      assert.equal(
        await page.evaluate(() => window.editCommands.length),
        before,
        chord + ' ran a command',
      );
      assert.equal(await box.inputValue(), 'alpha bravo', chord);
    }
    await box.fill('');
    await box.press('Meta+d');
    assert.equal(await dialogOpen(), false, '⌘D on an empty box');
    // ⌘A selects the whole draft, as the system does.
    await box.fill('alpha bravo');
    await box.press('Meta+a');
    assert.deepEqual(
      await box.evaluate((n) => [n.selectionStart, n.selectionEnd]),
      [0, 11],
    );
    // The terminal's Control keys still work from the composer on macOS.
    const before = await page.evaluate(() => window.editCommands.length);
    await box.press('Control+t');
    await page.waitForFunction(
      (n) => window.editCommands.length === n + 1,
      before,
    );
    assert.equal(
      await page.evaluate(() => window.editCommands.at(-1)),
      'thinking',
    );
  }
  // ctrl+d over text is the field's (delete forward), as in the terminal; on an
  // empty box it asks to close the session.
  await box.fill('alpha bravo');
  await box.evaluate((n) => n.setSelectionRange(0, 0));
  await box.press('Control+d');
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  assert.equal(await dialogOpen(), false, 'ctrl+d over a draft');
  await box.fill('');
  await box.press('Control+d');
  await page.waitForFunction(() => !!document.querySelector('[role="dialog"]'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  // Another text field keeps all its keys: ctrl+c there does not clear the
  // composer's draft and ctrl+d does not ask to close.
  await box.fill('composer draft');
  await page.evaluate(() => {
    const field = document.createElement('input');
    field.setAttribute('aria-label', 'other field');
    document.body.append(field);
  });
  const other = page.getByRole('textbox', { name: 'other field', exact: true });
  await other.fill('');
  for (const chord of ['Control+c', 'Control+d', 'Control+t']) {
    const before = await page.evaluate(() => window.editCommands.length);
    await other.press(chord);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    assert.equal(await box.inputValue(), 'composer draft', chord);
    assert.equal(await dialogOpen(), false, chord + ' in another field');
    assert.equal(
      await page.evaluate(() => window.editCommands.length),
      before,
      chord + ' in another field ran a command',
    );
  }
  await other.evaluate((n) => n.remove());
  console.log(
    'actual full App trusted keyboard/copy event, selected draft and native Undo; editor ownership and noneditable suspend; ⌘ chords left to the system on macOS, ctrl+d over a draft and keys in other fields left to the field passed (host clipboard writes intercepted)',
  );
} finally {
  await browser?.close();
  await server.close();
}
