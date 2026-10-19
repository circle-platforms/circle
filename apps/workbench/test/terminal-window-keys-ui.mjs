// Keys typed in a terminal belong to the terminal (#155). On Windows and Linux the
// window's Ctrl chords (Ctrl+K search, Ctrl+P quick open, Ctrl+B the sidebar) are the
// shell's control keys there: the terminal gets each once and the window does nothing.
// On macOS ⌘K is no terminal key and still opens search from the terminal. Real key
// presses in Chromium, the platform set as the desktop sets it on the page.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
    ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
    : {}),
});
const checks = [];
try {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(
      server.resolvedUrls.local[0] +
        'test/terminal-window-keys-ui.html?platform=' +
        platform +
        '#/session/A',
    );
    await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
    const searchOpen = () =>
      page.evaluate(() => !!document.querySelector('[role="dialog"]'));
    const sent = () => page.evaluate(() => window.__terminalKeys);
    // Let a key's effects, on the window and through the bridge, land before reading.
    const settle = () =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => setTimeout(resolve, 0)),
          ),
      );
    const sidebarState = () =>
      page.evaluate(
        () => document.querySelector('.workbench')?.className ?? '',
      );

    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    const panel = page.locator('[data-inspector-resource="terminal"]');
    const input = panel
      .locator('.native-terminal-surfaces .xterm-helper-textarea')
      .first();
    await input.waitFor({ state: 'attached' });
    await input.focus();
    if (platform === 'darwin') {
      // ⌘K from the terminal opens search; Control+K is the shell's ^K.
      await page.keyboard.press('Control+k');
      await page.waitForFunction(() =>
        window.__terminalKeys.written.includes('\x0b'),
      );
      await settle();
      assert.equal(await searchOpen(), false, 'Control+K opened search');
      await input.focus();
      await page.keyboard.press('Meta+k');
      await page.getByRole('dialog').waitFor();
      assert.equal(
        (await sent()).written.filter((data) => data === '\x0b').length,
        1,
      );
      checks.push(
        'darwin: Control+K in the terminal is ^K for the shell, ⌘K opens search',
      );
    } else {
      const before = await sidebarState();
      for (const [key, byte] of [
        ['k', '\x0b'],
        ['p', '\x10'],
        ['b', '\x02'],
      ]) {
        await page.keyboard.press('Control+' + key);
        await page.waitForFunction(
          (byte) => window.__terminalKeys.written.includes(byte),
          byte,
        );
        await settle();
        assert.equal(await searchOpen(), false, `Control+${key} opened search`);
        assert.equal(
          (await sent()).written.filter((data) => data === byte).length,
          1,
          `Control+${key} reached the terminal once`,
        );
        assert.equal(
          await page.evaluate(() =>
            document.activeElement?.classList.contains('xterm-helper-textarea'),
          ),
          true,
          'the terminal keeps the keyboard',
        );
      }
      assert.equal(await sidebarState(), before, 'Control+B moved the sidebar');
      // Outside the terminal the same chord is still the window's search.
      await page.getByRole('textbox', { name: 'message', exact: true }).focus();
      await page.keyboard.press('Control+k');
      await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => !document.querySelector('[role="dialog"]'),
      );

      // A device console the person holds, a tab of the same row: its keys go to the device.
      await page.getByRole('tab', { name: 'lab switch · Telnet' }).click();
      const consoleInput = panel.locator(
        '.device-screen:not([hidden]) .xterm-helper-textarea',
      );
      await consoleInput.waitFor({ state: 'attached' });
      await page.waitForFunction(
        () =>
          !document.querySelector(
            '.device-screen:not([hidden]) textarea[disabled]',
          ),
      );
      await consoleInput.focus();
      await page.keyboard.press('Control+k');
      await page.waitForFunction(() =>
        window.__terminalKeys.typed.includes('\x0b'),
      );
      await settle();
      assert.equal(await searchOpen(), false, 'Control+K opened search');
      assert.equal(
        (await sent()).typed.filter((data) => data === '\x0b').length,
        1,
      );
      checks.push(
        `${platform}: Control+K, P and B in a terminal tab and a device console go to the shell once and open nothing; outside, Control+K opens search`,
      );
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
