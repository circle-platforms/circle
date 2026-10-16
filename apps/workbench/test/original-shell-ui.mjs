import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output =
  process.env.CIRCLE_UI_EVIDENCE || '/tmp/circle-original-shell-ui';
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
const receipts = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const width of [1280, 500])
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.addInitScript(() =>
        localStorage.setItem('circle.workbench.language', 'en'),
      );
      await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
      await page
        .getByRole('textbox', { name: 'message', exact: true })
        .waitFor();
      await page.evaluate(async (theme) => {
        const { PreviewRuntime } = await import('/src/model/state.ts');
        const runtime = new PreviewRuntime(localStorage);
        runtime.change((snapshot) => {
          snapshot.settings.theme = theme;
        });
      }, theme);
      await page.reload();
      await page
        .getByRole('textbox', { name: 'message', exact: true })
        .waitFor();
      const paletteBefore = await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--bg')
          .trim(),
      );
      assert.equal(
        await page
          .locator(
            '.developer-workbench,.layout-toggle,.developer-dock,.workbench-mobile-tabs',
          )
          .count(),
        0,
      );
      const composer = page.locator('textarea[aria-label="message"]');
      const composerOwner = await composer.elementHandle();
      await composer.fill('Original shell preserved draft');
      await composer.evaluate((el) => el.setSelectionRange(4, 12));
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      await page
        .locator('#inspector-terminal-terminal')
        .waitFor({ state: 'visible' });
      await page.getByRole('tab', { name: 'history', exact: true }).click();
      assert.equal(
        await page.locator('#inspector-terminal-terminal').count(),
        1,
        'terminal resource remains mounted',
      );
      await page
        .getByRole('button', { name: 'close inspector', exact: true })
        .click();
      assert.equal(
        await page.locator('.inspector').isVisible(),
        false,
        'closed inspector is actually hidden',
      );
      assert.equal(
        await page.locator('#inspector-terminal-terminal').count(),
        1,
        'closing inspector preserves terminal',
      );
      await page
        .getByRole('button', { name: 'terminal panel', exact: true })
        .click();
      await page.getByRole('tab', { name: 'terminal', exact: true }).click();
      await page
        .getByRole('button', { name: 'close inspector', exact: true })
        .click();
      assert.equal(
        await page.locator('.inspector').isVisible(),
        false,
        'closed inspector is actually hidden',
      );
      await composer.focus();
      await page.keyboard.press('Control+p');
      const search = page.getByRole('textbox', {
        name: 'global search',
        exact: true,
      });
      await search.fill('README.md');
      await search.press('Enter');
      await page.locator('.file-view').waitFor({ state: 'visible' });
      assert.equal(
        await composer.isVisible(),
        false,
        'file replaces conversation in original main region',
      );
      assert.equal(await composer.count(), 1, 'draft owner remains mounted');
      await page
        .getByRole('button', { name: 'close file', exact: true })
        .click();
      assert.equal(
        await composer.inputValue(),
        'Original shell preserved draft',
      );
      assert.deepEqual(
        await composer.evaluate((el) => [el.selectionStart, el.selectionEnd]),
        [4, 12],
      );
      await page
        .getByRole('button', { name: 'changes panel', exact: true })
        .click();
      await page
        .getByRole('tab', { name: 'git workspace', exact: true })
        .click();
      await page
        .locator('#inspector-changes-git')
        .waitFor({ state: 'visible' });
      const geometry = await page
        .locator('.inspector-column')
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, width: r.width, right: r.right };
        });
      assert.ok(
        geometry.width > 250 && geometry.right <= width + 1,
        JSON.stringify(geometry),
      );
      if (width === 500)
        assert.equal(await page.locator('.inspector-overlay').count(), 1);
      assert.equal(
        await composer.inputValue(),
        'Original shell preserved draft',
      );
      await page.screenshot({ path: `${output}/${theme}-${width}.png` });
      await page.evaluate(async () => {
        const { setLanguage } = await import('/src/i18n/index.ts');
        setLanguage('zh-CN');
      });
      await page
        .locator('#inspector-changes-git')
        .waitFor({ state: 'visible' });
      assert.equal(
        await page.locator('.composer textarea').inputValue(),
        'Original shell preserved draft',
      );
      const paletteAfter = await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--bg')
          .trim(),
      );
      assert.equal(
        await composerOwner.evaluate((el) => el.isConnected),
        true,
        'locale change retains composer identity',
      );
      assert.equal(
        paletteAfter,
        paletteBefore,
        'locale change preserves the actual configured palette',
      );
      await page.screenshot({ path: `${output}/zh-${theme}-${width}.png` });
      const noOverflow = await page
        .locator('.inspector')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      assert.equal(
        noOverflow,
        true,
        'Chinese original inspector does not overflow',
      );
      assert.deepEqual(errors, []);
      receipts.push({
        theme,
        width,
        geometry,
        paletteBefore,
        paletteAfter,
        native: false,
        passed: true,
      });
      await page.close();
    }
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify({ native: false, receipts }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, receipts, output }));
} finally {
  await browser?.close();
  await server.close();
}
