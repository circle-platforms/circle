import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const chrome = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/local/bin/google-chrome',
].find((path) => existsSync(path));

test(
  'new session takes keyboard focus in the home composer',
  { skip: chrome ? false : 'chrome is not installed' },
  async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const port = 4219;
    const server: ChildProcess = spawn(
      'npx',
      ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let logs = '';
    const take = (chunk: unknown) => {
      logs += String(chunk);
    };
    server.stdout?.on('data', take);
    server.stderr?.on('data', take);
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('vite did not start\n' + logs)),
        20_000,
      );
      const watch = () => {
        // CI colours vite's output, so the word is not followed by ':' there.
        if (!logs.replace(/\x1b\[[0-9;]*m/g, '').includes('Local:')) return;
        clearTimeout(timer);
        resolve();
      };
      server.stdout?.on('data', watch);
      server.stderr?.on('data', watch);
      server.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`vite exited ${code}\n` + logs));
      });
    });
    const stop = async () => {
      const pid = server.pid;
      if (pid === undefined || server.exitCode !== null) return;
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        server.kill('SIGTERM');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
          resolve();
        }, 2_000);
        server.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    };
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox'],
    });
    try {
      await ready;
      const page = await browser.newPage({
        viewport: { width: 1000, height: 520 },
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      const composer = page.locator('.composer textarea');
      await composer.waitFor();
      const send = async (text: string) => {
        await composer.fill(text);
        await composer.press('Enter');
        await page.getByText(text, { exact: true }).first().waitFor();
      };
      const focused = () =>
        page.evaluate(
          () => document.activeElement?.matches('.composer textarea') ?? false,
        );
      // Keys typed while the composer is opening are held until it is there.
      const settled = () =>
        page.waitForFunction(
          () => !document.documentElement.dataset.composerFocus,
        );
      const focusRow = () =>
        page.evaluate(() => {
          const link = document.querySelector('.session-link');
          if (link instanceof HTMLElement) link.focus({ preventScroll: true });
        });
      // A listed row has the keyboard. Ctrl+N must move it before any typing.
      // The fixture session is idle; a waiting turn refuses the command.
      await focusRow();
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'n',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      assert.equal(await focused(), true);
      await page.keyboard.type('focus test');
      await settled();
      assert.equal(await composer.inputValue(), 'focus test');
      assert.equal(await focused(), true);

      // Keys in the same turn as Ctrl+N, while a row is focused, are kept.
      await composer.fill('');
      await focusRow();
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'n',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        const field = document.activeElement;
        if (
          !(field instanceof HTMLTextAreaElement) ||
          !field.matches('.composer textarea')
        )
          throw new Error('composer was not focused before typing');
        for (const key of 'fast') {
          field.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      });
      await page.waitForFunction(() => {
        const node = document.querySelector('.composer textarea');
        return node instanceof HTMLTextAreaElement && node.value === 'fast';
      });
      await settled();
      assert.equal(await composer.inputValue(), 'fast');

      // Home keeps its draft. New session puts the caret after it.
      await composer.fill('leftover');
      await page
        .locator('nav.sidebar-primary')
        .getByRole('button', { name: 'new session', exact: true })
        .click();
      await page.waitForFunction(() => {
        const node = document.querySelector('.composer textarea');
        return (
          node instanceof HTMLTextAreaElement &&
          node.value === 'leftover' &&
          document.activeElement === node &&
          node.selectionStart === node.value.length
        );
      });
      await settled();
      await page.keyboard.type(' fresh');
      assert.equal(await composer.inputValue(), 'leftover fresh');
      assert.equal(await focused(), true);
      await composer.fill('');

      await send('second note about focusing the composer');
      await page.getByRole('link', { name: 'all sessions' }).click();
      await composer.waitFor({ state: 'detached' });
      await page
        .locator('.page-heading')
        .getByRole('button', { name: 'new session', exact: true })
        .click();
      await page.waitForFunction(() =>
        document.activeElement?.matches('.composer textarea'),
      );
      await settled();
      await page.keyboard.type('from the list');
      assert.equal(await composer.inputValue(), 'from the list');

      await page.locator('.session-link').first().click();
      await page.waitForTimeout(320);
      assert.equal(await focused(), false);
    } finally {
      await browser.close();
      await stop();
    }
  },
);
