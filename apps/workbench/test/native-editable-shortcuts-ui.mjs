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
  await box.press('Meta+z');
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
  console.log(
    'actual full App trusted keyboard/copy event, selected draft and native Undo; editor ownership and noneditable suspend passed (host clipboard writes intercepted)',
  );
} finally {
  await browser?.close();
  await server.close();
}
