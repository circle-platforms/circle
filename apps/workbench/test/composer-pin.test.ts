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
  'the composer stays inside the window after several new sessions',
  { skip: chrome ? false : 'chrome is not installed' },
  async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const port = 4217;
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
      await page.locator('.composer textarea').waitFor();
      const inside = async () => {
        const box = await page.locator('.composer-area').boundingBox();
        assert.ok(box, 'composer is missing');
        assert.ok(box.y >= 0, `composer top ${box.y}`);
        assert.ok(
          box.y + box.height <= 521,
          `composer bottom ${box.y + box.height}`,
        );
        const shifted = await page.evaluate(() => ({
          scroll: document.scrollingElement?.scrollTop ?? 0,
          top: document.querySelector('.workbench')?.getBoundingClientRect()
            .top,
        }));
        assert.equal(shifted.scroll, 0);
        assert.ok(
          shifted.top !== undefined && shifted.top >= -1 && shifted.top <= 1,
          `workbench top ${shifted.top}`,
        );
      };
      await inside();
      for (let i = 0; i < 6; i++) {
        const note = `session ${i} note about the composer staying on screen`;
        const composer = page.locator('.composer textarea');
        await composer.fill(note);
        await composer.press('Enter');
        await page.getByText(note, { exact: true }).first().waitFor();
        await page
          .locator('nav.sidebar-primary')
          .getByRole('button', { name: 'new session', exact: true })
          .click();
        await inside();
      }
      const rows = await page.locator('.session-link').count();
      assert.ok(rows >= 6, `expected several sessions, saw ${rows}`);
    } finally {
      await browser.close();
      await stop();
    }
  },
);
