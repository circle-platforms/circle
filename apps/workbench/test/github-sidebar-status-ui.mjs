import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_GITHUB_SIDEBAR_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-github-sidebar-')));
await mkdir(output, { recursive: true });
let browser;
const cases = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      for (const width of [375, 1280]) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(
          `${server.resolvedUrls.local[0]}test/github-sidebar-status-ui.html?language=${language}&theme=${theme}`,
        );
        const labels = page.locator('.extension-status > span');
        await labels.first().waitFor();
        const unchanged = [
          'disconnected',
          'disconnected',
          'custom operation 中文',
          'future-state',
        ];
        const expected = {
          disconnected:
            language === 'en' ? 'GitHub login required' : '需要登录 GitHub',
          connected: language === 'en' ? 'GitHub connected' : '已连接 GitHub',
          authorizing:
            language === 'en'
              ? 'waiting for GitHub authorization'
              : '等待 GitHub 授权',
          error:
            language === 'en' ? 'GitHub connection error' : 'GitHub 连接出错',
        };
        for (const [state, text] of Object.entries(expected)) {
          await page.evaluate(
            (value) => window.sidebarStatusFixture.state(value),
            state,
          );
          await page.waitForFunction(
            (value) =>
              document.querySelector('.extension-status > span')
                ?.textContent === value,
            text,
          );
          assert.deepEqual(
            (await labels.allTextContents()).slice(1),
            unchanged,
          );
          assert.equal(
            (await page.evaluate(() => window.sidebarStatusFixture.snapshot()))
              .extensions[0].status.text,
            state,
          );
        }
        await page.evaluate(() =>
          window.sidebarStatusFixture.state('disconnected'),
        );
        await page.waitForFunction(
          (value) =>
            document.querySelector('.extension-status > span')?.textContent ===
            value,
          expected.disconnected,
        );
        const before = await labels.first().evaluate((el) => {
          window.__statusNode = el;
          return el.getBoundingClientRect().toJSON();
        });
        await page.evaluate(
          (value) => window.sidebarStatusFixture.language(value),
          language === 'en' ? 'zh-CN' : 'en',
        );
        await page.waitForFunction(
          (value) =>
            document.querySelector('.extension-status > span')?.textContent ===
            value,
          language === 'en' ? '需要登录 GitHub' : 'GitHub login required',
        );
        assert.equal(
          await labels.first().evaluate((el) => el === window.__statusNode),
          true,
        );
        await page.evaluate(
          (value) => window.sidebarStatusFixture.language(value),
          language,
        );
        await page.waitForFunction(
          (value) =>
            document.querySelector('.extension-status > span')?.textContent ===
            value,
          expected.disconnected,
        );
        assert.ok(before.left >= 0 && before.right <= width);
        const background = await page
          .locator('.sidebar')
          .evaluate((el) => getComputedStyle(el).backgroundColor);
        await page.screenshot({
          path: `${output}/${language}-${theme}-${width}.png`,
        });
        assert.deepEqual(errors, []);
        cases.push({
          language,
          theme,
          width,
          background,
          labels: await labels.allTextContents(),
        });
        await page.close();
      }
  assert.notEqual(
    cases.find((value) => value.theme === 'light').background,
    cases.find((value) => value.theme === 'dark').background,
  );
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify(
      {
        scope:
          'actual original Sidebar with runtime snapshots, no native desktop or OAuth',
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
