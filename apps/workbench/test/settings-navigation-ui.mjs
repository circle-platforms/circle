import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
const output = process.env.CIRCLE_SETTINGS_UI_EVIDENCE_DIR;
if (output) await mkdir(output, { recursive: true });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const theme of ['light', 'dark'])
    for (const language of ['en', 'zh-CN'])
      for (const width of [1440, 760]) {
        const page = await browser.newPage({
          viewport: { width, height: 700 },
        });
        await page.goto(
          `${server.resolvedUrls.local[0]}test/settings-navigation-ui.html?theme=${theme}&language=${language}`,
        );
        const search = page.locator('.settings-index input');
        await page.locator('.settings-index-list button').nth(2).waitFor();
        const draft = page.locator('#settings-local-draft');
        await draft.fill('retained edited settings draft');
        await search.fill(language === 'en' ? 'theme' : '主题');
        assert.equal(
          await page.locator('.settings-index-list button').count(),
          1,
        );
        await search.press('Enter');
        assert.equal(
          await page
            .locator('.settings-sections h2')
            .first()
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await search.fill('secret-token-must-not-be-indexed');
        assert.equal(
          await page.locator('.settings-index-list button').count(),
          0,
          'credential values are not in the index',
        );
        assert.equal(
          await draft.inputValue(),
          'retained edited settings draft',
        );
        await search.press('Escape');
        assert.equal(await search.inputValue(), '');
        assert.equal(
          await page.locator('.settings-index-list button').count(),
          3,
        );
        assert.equal(
          await page.evaluate(() => window.settingsEffects.escaped),
          0,
          'local Escape does not close the outer workbench',
        );
        await page.locator('.settings-index-list button').nth(1).click();
        assert.equal(
          await draft.inputValue(),
          'retained edited settings draft',
        );
        assert.deepEqual(await page.evaluate(() => window.settingsEffects), {
          mounts: 1,
          unmounts: 0,
          changes: 1,
          escaped: 0,
        });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        if (output)
          await page.screenshot({
            path: join(output, `${theme}-${language}-${width}.png`),
            fullPage: true,
          });
        await page.close();
      }
  console.log(
    'settings navigation: 8 light/dark, English/Chinese, wide/narrow scenarios passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
