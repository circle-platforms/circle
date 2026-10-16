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
  process.env.CIRCLE_FAILURE_UI_EVIDENCE || '/tmp/circle-runtime-failure-ui';
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
    for (const theme of ['dark', 'light'])
      for (const width of [1000, 375]) {
        const page = await browser.newPage({
          viewport: { width, height: 800 },
        });
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        await page.goto(
          `${server.resolvedUrls.local[0]}test/runtime-failure-ui.html?language=${language}&theme=${theme}`,
        );
        const alert = page.getByRole('alert', {
          name: language === 'en' ? 'action failed' : '操作失败',
          exact: true,
        });
        await alert.waitFor();
        assert.equal(
          await alert.count(),
          1,
          'ordinary quoted errors must not create alerts',
        );
        assert.equal(
          await page
            .locator('[data-message-id="ordinary-notice"] [role="alert"]')
            .count(),
          0,
        );
        assert.equal(
          await page
            .locator('.runtime-failure details')
            .evaluate((el) => el.open),
          false,
        );
        await alert.locator('summary').click();
        assert.equal(
          await alert.locator('pre').textContent(),
          await page.evaluate(() => window.failureFixture.error),
        );
        await alert
          .getByRole('button', {
            name: language === 'en' ? 'copy error details' : '复制错误详情',
            exact: true,
          })
          .click();
        assert.deepEqual(
          await page.evaluate(() => window.failureFixture.copied),
          [await page.evaluate(() => window.failureFixture.error)],
        );
        await alert
          .getByRole('button', {
            name: language === 'en' ? 'review connection' : '检查连接配置',
            exact: true,
          })
          .click();
        await page
          .getByRole('dialog', {
            name: language === 'en' ? 'connection' : '连接',
            exact: true,
          })
          .waitFor();
        await page.keyboard.press('Escape');
        await alert
          .getByRole('button', {
            name: language === 'en' ? 'return to message' : '返回输入框',
            exact: true,
          })
          .click();
        assert.equal(
          await page
            .locator('.composer textarea')
            .evaluate((el) => el === document.activeElement),
          true,
        );
        assert.equal(
          await page.locator('.composer textarea').inputValue(),
          'preserve draft and never automatically resend',
        );
        const snapshot = await page.evaluate(() =>
          window.failureFixture.runtime.getSnapshot(),
        );
        assert.equal(snapshot.sessions[0].messages.length, 3);
        assert.equal(snapshot.sessions[0].state, 'idle');
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await page.screenshot({
          path: `${output}/${language}-${theme}-${width}.png`,
        });
        assert.deepEqual(pageErrors, []);
        cases.push({ language, theme, width, native: false, passed: true });
        await page.close();
      }
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify(
      {
        native: false,
        scope:
          'Full original CircleWorkbench renderer; controlled runtime failure notices and isolated clipboard-port spy; no model or OS clipboard',
        cases,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, cases, output }));
} finally {
  await browser?.close();
  await server.close();
}
