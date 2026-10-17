import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out = process.env.CIRCLE_UI_EVIDENCE || '/tmp/circle-github-feedback-ui';
await mkdir(out, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
const receipt = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['dark', 'light'])
      for (const width of [375, 1280]) {
        const page = await browser.newPage({
          viewport: { width, height: 1000 },
        });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        const label = (a, b) => (language === 'en' ? a : b);
        await page.goto(
          `${server.resolvedUrls.local[0]}test/github-connection-ui.html?language=${language}&theme=${theme}`,
        );
        await page.locator('#github-connection').waitFor();
        await page.waitForFunction(
          (t) => document.documentElement.dataset.theme === t,
          theme,
        );
        for (const [raw, en, zh] of [
          [
            'GitHub authorization expired; reconnect in GitHub plugin',
            'GitHub authorization has expired.',
            'GitHub 授权已失效。',
          ],
          [
            'GitHub permission denied for this repository',
            'GitHub denied access to this repository.',
            'GitHub 拒绝访问此仓库。',
          ],
          [
            'GitHub request failed; check the connection and retry the read',
            'GitHub could not be reached or the request failed.',
            '无法连接 GitHub 或请求失败。',
          ],
        ]) {
          await page.evaluate(
            (raw) => window.githubFixture.viewError(raw),
            raw,
          );
          const alert = page.getByRole('alert');
          await alert.getByText(label(en, zh), { exact: true }).waitFor();
          const detail = alert.locator('details');
          assert.equal(await detail.evaluate((e) => e.open), false);
          await detail.locator('summary').click();
          assert.equal(await detail.locator('pre').innerText(), raw);
          await page.screenshot({
            path: `${out}/${language}-${theme}-${width}-${raw.includes('expired') ? 'expired' : raw.includes('denied') ? 'denied' : 'request'}.png`,
          });
          await detail.locator('summary').click();
        }
        assert.deepEqual(
          await page.evaluate(() => window.githubFixture.calls),
          [],
        );
        assert.deepEqual(errors, []);
        receipt.push({
          language,
          theme,
          width,
          palette: await page.evaluate(
            () => getComputedStyle(document.documentElement).backgroundColor,
          ),
          passed: true,
          kind: 'controlled metadata; no OAuth or network',
        });
        await page.close();
      }
} finally {
  await writeFile(`${out}/receipt.json`, JSON.stringify(receipt, null, 2));
  await browser?.close();
  await server.close();
}
