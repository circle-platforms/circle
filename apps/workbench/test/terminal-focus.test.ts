// Clicking the terminal screen takes the keyboard, and a later frame does not
// give it back to the composer. The preview has no xterm; this fixture does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { workbenchCleanup } from './helpers/workbench-server.ts';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { testBrowserOptions } from './helpers/test-browser.ts';

const browserOptions = testBrowserOptions(chromium.executablePath());
test(
  'clicking the terminal focuses it and the composer does not take the keyboard back',
  { skip: browserOptions ? false : 'no supported test browser is installed' },
  async (t) => {
    const cleanup = workbenchCleanup(t);
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
      logLevel: 'error',
    });
    cleanup(() => server.close());
    await server.listen();
    const browser = await chromium.launch({
      ...browserOptions,
      headless: true,
    });
    cleanup(() => browser.close());
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
    await page
      .getByRole('button', { name: 'take over', exact: true })
      .waitFor();
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
    await page.waitForFunction(() => {
      const letters = window.__terminalKeys.written.join('');
      return (
        letters.split('a').length - 1 === 1 &&
        letters.split('b').length - 1 === 1 &&
        letters.split('c').length - 1 === 1 &&
        window.__terminalKeys.taken.includes('local:A-terminal')
      );
    });
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
  },
);

test(
  'during the claim, keys meant for another field stay in that field',
  { skip: browserOptions ? false : 'no supported test browser is installed' },
  async (t) => {
    const cleanup = workbenchCleanup(t);
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
      logLevel: 'error',
    });
    cleanup(() => server.close());
    await server.listen();
    const browser = await chromium.launch({
      ...browserOptions,
      headless: true,
    });
    cleanup(() => browser.close());
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
    await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
    await page
      .getByRole('button', { name: 'terminal panel', exact: true })
      .click();
    const screen = page.locator('.native-terminal-screen').first();
    await screen.locator('.xterm-screen').waitFor();
    const written = () =>
      page.evaluate(() => window.__terminalKeys.written.join(''));
    // Find opens from the terminal within the claim, and its words are typed there.
    await screen.click({ delay: 0 });
    await page.keyboard.press('Control+f');
    const find = page.getByRole('textbox', {
      name: 'find in terminal',
      exact: true,
    });
    await find.waitFor();
    await page.keyboard.type('make', { delay: 90 });
    await page.keyboard.press('Enter');
    assert.equal(await find.inputValue(), 'make');
    assert.equal((await written()).includes('m'), false);
    await page.keyboard.press('Escape');
    // A field that opens over the window in that time, as a secret's does.
    await screen.click({ delay: 0 });
    await page.evaluate(() => {
      const field = document.createElement('input');
      field.setAttribute('aria-label', 'opened field');
      document.body.append(field);
      field.focus();
    });
    await page.keyboard.type('secret', { delay: 40 });
    assert.equal(
      await page
        .getByRole('textbox', { name: 'opened field', exact: true })
        .inputValue(),
      'secret',
    );
    assert.equal((await written()).includes('s'), false);
    assert.deepEqual(errors, []);
  },
);

declare global {
  interface Window {
    __terminalKeys: { written: string[]; typed: string[]; taken: string[] };
  }
}
