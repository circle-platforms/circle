// Clicking the terminal screen takes the keyboard, and a later frame does not
// give it back to the composer. The preview has no xterm; this fixture does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { testBrowserOptions } from './helpers/test-browser.ts';

const browserOptions = testBrowserOptions(chromium.executablePath());
test(
  'clicking the terminal focuses it and the composer does not take the keyboard back',
  { skip: browserOptions ? false : 'no supported test browser is installed' },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
      logLevel: 'error',
    });
    await server.listen();
    const browser = await chromium.launch({
      ...browserOptions,
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1400, height: 900 },
      });
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(
        `${server.resolvedUrls!.local[0]}test/terminal-window-keys-ui.html#/session/A`,
        { timeout: 0 },
      );
      const composer = page.getByRole('textbox', {
        name: 'message',
        exact: true,
      });
      await composer.waitFor();
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      const screen = page.locator('.native-terminal-screen').first();
      await screen.locator('.xterm-screen').waitFor();
      await composer.focus();
      await composer.fill('stays in the composer');
      // A key within about 50ms of the click, and a composer focus forced just
      // after it. Waiting until xterm is focused first hides the race.
      await page.evaluate(() => {
        document.querySelector('.native-terminal-screen')?.addEventListener(
          'pointerdown',
          () => {
            setTimeout(() => {
              document
                .querySelector<HTMLTextAreaElement>('.composer textarea')
                ?.focus();
            }, 20);
          },
          { capture: true, once: true },
        );
      });
      await screen.click({ delay: 0 });
      const typing = page.keyboard.type('abc', { delay: 10 });
      await page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 40)),
      );
      await typing;
      assert.equal(await composer.inputValue(), 'stays in the composer');
      await page.waitForFunction(() =>
        ['a', 'b', 'c'].every((char) =>
          window.__terminalKeys.written.some((data: string) =>
            data.includes(char),
          ),
        ),
      );
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      assert.equal(
        await page.evaluate(
          () =>
            document.activeElement instanceof HTMLTextAreaElement &&
            !!document.activeElement.closest('.xterm'),
        ),
        true,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

declare global {
  interface Window {
    __terminalKeys: { written: string[]; typed: string[] };
  }
}
