import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_TERMINAL_PREVIEW_EVIDENCE ||
  '/tmp/circle-terminal-preview';
await mkdir(output, { recursive: true });
let browser;
const cases = [];
try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL || 'chrome',
  });
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      for (const width of [1000, 375]) {
        const page = await browser.newPage({
          viewport: { width, height: 800 },
        });
        await page.goto(
          `${server.resolvedUrls.local[0]}test/terminal-selection-preview-ui.html?language=${language}&theme=${theme}`,
        );
        await page.locator('.terminal-selection-text').waitFor();
        const expected = await page.evaluate(() => window.previewFixture);
        assert.equal(
          await page.locator('.terminal-selection-text').textContent(),
          expected.text,
        );
        assert.equal(expected.text.split('\n').length, 600);
        assert.ok(expected.checks.every(Boolean));
        const raw = page.locator('.terminal-selection-original');
        assert.equal(await raw.evaluate((el) => el.open), false);
        assert.equal(await raw.locator('pre').isVisible(), false);
        await page
          .getByRole('button', {
            name: language === 'en' ? 'copy selected text' : '复制选中文字',
            exact: true,
          })
          .click();
        await raw.locator('summary').click();
        assert.equal(
          await raw.locator('pre').textContent(),
          expected.file.content,
        );
        await page
          .getByRole('button', {
            name: language === 'en' ? 'copy original attachment' : '复制原附件',
            exact: true,
          })
          .click();
        assert.deepEqual(
          await page.evaluate(() => window.previewFixture.copies),
          [expected.text, expected.file.content],
        );
        await raw.locator('summary').click();
        await page
          .locator('.terminal-selection-text')
          .evaluate((el) => (el.scrollTop = 0));
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: `${output}/${language}-${theme}-${width}.png`,
        });
        cases.push({
          language,
          theme,
          width,
          selectedLines: 600,
          metadataInitiallyFolded: true,
          exactCopies: true,
        });
        await page.close();
      }
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify(
      {
        scope:
          'headless original-theme component display; no terminal or model authority inferred',
        cases,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
