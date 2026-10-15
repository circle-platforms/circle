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
  'a new session takes keyboard focus in the composer',
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
        if (!logs.includes('Local:')) return;
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
      const blur = async () => {
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement)
            document.activeElement.blur();
        });
        await page.waitForFunction(
          () => !document.activeElement?.matches('.composer textarea'),
        );
      };
      const focused = () =>
        page.evaluate(
          () => document.activeElement?.matches('.composer textarea') ?? false,
        );
      await send('first note about focusing the composer');
      await blur();
      await page
        .locator('nav.sidebar-primary')
        .getByRole('button', { name: 'new session', exact: true })
        .click();
      await page.keyboard.type('typed from the keyboard');
      assert.equal(await composer.inputValue(), 'typed from the keyboard');
      await page.waitForTimeout(300);
      assert.equal(await focused(), true);

      await blur();
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
      await page.keyboard.type(' again');
      assert.equal(
        await composer.inputValue(),
        'typed from the keyboard again',
      );
      assert.equal(await focused(), true);

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
