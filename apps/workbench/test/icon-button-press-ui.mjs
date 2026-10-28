import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage();
  const count = () => page.locator('output').getAttribute('data-count');
  for (const theme of ['dark', 'light'])
    for (const language of ['en', 'zh-CN']) {
      const url =
        server.resolvedUrls.local[0] +
        `test/icon-button-press-ui.html?theme=${theme}&language=${language}`;
      const button = page.getByRole('button', {
        name: language === 'en' ? 'open in a window' : '在单独窗口打开',
      });
      const firstPressHides = async () => {
        await page.goto(url);
        await button.hover();
        await page.mouse.down();
        await button.waitFor({ state: 'hidden' });
        await page.mouse.up();
        assert.equal(await count(), '1', 'the first press opens once');
        await page.getByRole('button', { name: 'show drawer' }).click();
        await button.waitFor({ state: 'visible' });
      };

      await page.goto(url + '&keep');
      assert.equal(
        await page.locator('html').getAttribute('data-theme'),
        theme,
      );
      await button.click();
      assert.equal(await count(), '1', 'a press and its click open only once');

      await firstPressHides();
      await button.click();
      assert.equal(await count(), '2', 'a new pointer click opens again');

      await firstPressHides();
      await button.focus();
      await page.keyboard.press('Enter');
      assert.equal(await count(), '2', 'keyboard activation opens again');
    }
} finally {
  await browser?.close();
  await server.close();
}
