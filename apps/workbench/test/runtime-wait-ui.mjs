import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

// A command the runtime has kept must be said while it lasts, and one it never
// answered must leave a card the person can retry, or stop waiting on. (#216)
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE || '/tmp/circle-runtime-wait-ui';
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
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(
          `${server.resolvedUrls.local[0]}test/runtime-wait-ui.html?language=${language}&theme=${theme}`,
        );
        const word = (en, zh) => (language === 'en' ? en : zh);
        const waitRow = page.locator('[data-testid="runtime-wait"]');
        await waitRow.waitFor();
        const row = (await waitRow.textContent()) ?? '';
        assert.match(
          row,
          word(
            /Circle is still working on custom-command/,
            /Circle 仍在处理 custom-command/,
          ),
          'the wait says what the runtime holds',
        );
        assert.match(row, word(/9s/, /9 秒/), 'and how long it has held it');
        const alert = page.getByRole('alert', {
          name: word('action failed', '操作失败'),
          exact: true,
        });
        assert.equal(await alert.count(), 1, 'the card is one alert');
        assert.match(
          (await alert.locator('> strong').textContent()) ?? '',
          word(/Circle did not answer/, /Circle 没有应答/),
        );
        assert.equal(
          (await alert.locator('p.runtime-failure-cause').textContent()) ?? '',
          await page.evaluate(() => window.waitFixture.failure.message),
        );
        await alert.locator('summary').click();
        assert.equal(
          (await alert.locator('pre').textContent()) ?? '',
          await page.evaluate(() => window.waitFixture.failure.detail),
          'the runtime words stay for a diagnosis',
        );
        await page.screenshot({
          path: `${output}/${language}-${theme}-${width}-card.png`,
        });
        await alert
          .getByRole('button', { name: word('retry', '重试'), exact: true })
          .click();
        await alert
          .getByRole('button', {
            name: word('stop waiting', '停止等待'),
            exact: true,
          })
          .click();
        await alert
          .getByRole('button', {
            name: word('copy error details', '复制错误详情'),
            exact: true,
          })
          .click();
        assert.deepEqual(await page.evaluate(() => window.waitFixture.copied), [
          await page.evaluate(() => window.waitFixture.failure.detail),
        ]);
        await alert
          .getByRole('button', { name: word('dismiss', '关闭'), exact: true })
          .click();
        assert.deepEqual(await page.evaluate(() => window.waitFixture.calls), [
          'retry session1',
          'stop session1',
          'dismiss session1',
        ]);
        assert.equal(
          await page.locator('[data-testid="command-failure"]').count(),
          0,
          'dismissing takes the card away',
        );
        await waitRow
          .getByRole('button', {
            name: word('stop waiting', '停止等待'),
            exact: true,
          })
          .click();
        const calls = await page.evaluate(() => window.waitFixture.calls);
        assert.equal(
          calls.filter((call) => call === 'stop session1').length,
          2,
          'the wait row is its own escape hatch',
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          'nothing runs past the window',
        );
        await page.screenshot({
          path: `${output}/${language}-${theme}-${width}.png`,
        });
        assert.deepEqual(errors, []);
        cases.push({ language, theme, width, passed: true });
        await page.close();
      }
} finally {
  await browser?.close();
  await server.close();
}
console.log(JSON.stringify({ passed: true, cases, output }));
