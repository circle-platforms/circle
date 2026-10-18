import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { testBrowserOptions } from './helpers/test-browser.ts';
import { previewPort } from './preview-port.ts';

const browserOptions = testBrowserOptions(chromium.executablePath());

test(
  'new session takes keyboard focus in the home composer',
  { skip: browserOptions ? false : 'no supported test browser is installed' },
  async (t) => {
    // Each concurrent Vite server owns its optimizer cache. Sharing node_modules/.vite
    // lets another test replace optimized modules while this page imports them.
    const scratch = await mkdtemp(join(tmpdir(), 'circle-composer-focus-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const root = fileURLToPath(new URL('..', import.meta.url));
    // Do not share CIRCLE_WORKBENCH_TEST_PORT with the pin test: both can run at once.
    const port = await previewPort(process.env.CIRCLE_WORKBENCH_FOCUS_PORT);
    const server: ChildProcess = spawn(
      // Node runs Vite itself: Windows has no `npx` file to spawn, only npx.cmd.
      process.execPath,
      [
        join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      {
        cwd: root,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CIRCLE_COMPONENT_UI_EVIDENCE: scratch,
          CIRCLE_HOME: join(scratch, 'home'),
          CIRCLE_WORKBENCH_DATA_DIR: join(scratch, 'desktop'),
        },
      },
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
    const browser = await chromium.launch({
      ...browserOptions,
      headless: true,
      args: ['--no-sandbox'],
    });
    const diagnostics: string[] = [];
    try {
      await ready;
      const page = await browser.newPage({
        locale: 'en-US',
        viewport: { width: 1000, height: 520 },
      });
      page.on('pageerror', (error) =>
        diagnostics.push(error.stack ?? error.message),
      );
      page.on('requestfailed', (request) =>
        diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`),
      );
      page.on('response', (response) => {
        if (response.status() >= 400)
          diagnostics.push(`${response.status()} ${response.url()}`);
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

      // The first slash command uses the same route as a session command. It
      // must not become a synthetic user turn or start a model response.
      await composer.fill('/help');
      await page.getByRole('option', { name: /\/help/ }).waitFor();
      await composer.press('Enter');
      await page.waitForURL('**/page/help');
      const commandPrompts = await page.evaluate(() => {
        const saved = JSON.parse(
          localStorage.getItem('circle.workbench.preview.v1') ?? '{}',
        );
        return (saved.sessions ?? []).flatMap(
          (session: { messages: { role: string; text: string }[] }) =>
            session.messages.filter(
              (item) => item.role === 'user' && item.text.trim() === '/help',
            ),
        );
      });
      assert.deepEqual(commandPrompts, []);

      await page.locator('.session-link').first().click();
      await page.waitForTimeout(320);
      assert.equal(await focused(), false);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nBrowser diagnostics:\n${diagnostics.join('\n')}\nVite output:\n${logs}`,
        { cause: error },
      );
    } finally {
      await browser.close();
      await stop();
    }
  },
);
