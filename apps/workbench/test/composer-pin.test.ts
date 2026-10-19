import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { testBrowserOptions } from './helpers/test-browser.ts';
import { previewPort } from './preview-port.ts';
import { workbenchServer } from './helpers/workbench-server.ts';

const browserOptions = testBrowserOptions(chromium.executablePath());

test(
  'the composer stays inside the window after several new sessions',
  { skip: browserOptions ? false : 'no supported test browser is installed' },
  async (t) => {
    // Each concurrent Vite server owns its optimizer cache. Sharing node_modules/.vite
    // lets another test replace optimized modules while this page imports them.
    const scratch = await mkdtemp(join(tmpdir(), 'circle-composer-pin-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const port = await previewPort(process.env.CIRCLE_WORKBENCH_TEST_PORT);
    const server = await workbenchServer(scratch, port);
    const browser = await chromium.launch({
      ...browserOptions,
      headless: true,
      args: ['--no-sandbox'],
    });
    const diagnostics: string[] = [];
    try {
      // The preview follows the browser language. These steps use the English names.
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
      await page.locator('.composer textarea').waitFor();
      // A session's composer, or the home composer after new session.
      const inside = async (composerBox = '.composer-area') => {
        const box = await page.locator(composerBox).boundingBox();
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
        await inside();
        // New session opens home. Its message makes the next session.
        await page
          .locator('nav.sidebar-primary')
          .getByRole('button', { name: 'new session', exact: true })
          .click();
        await page.locator('.home-composer').waitFor();
        await inside('.home-composer');
      }
      const rows = await page.locator('.session-link').count();
      assert.ok(rows >= 6, `expected several sessions, saw ${rows}`);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nBrowser diagnostics:\n${diagnostics.join('\n')}`,
        { cause: error },
      );
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
