import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const out =
  process.env.CIRCLE_GITHUB_UI_EVIDENCE || '/tmp/circle-github-connection-ui';
await mkdir(out, { recursive: true });
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL || 'chrome',
  });
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({
        viewport: { width: 375, height: 900 },
      });
      page.on('pageerror', (e) => {
        throw e;
      });
      await page.goto(
        `${server.resolvedUrls.local[0]}test/github-connection-ui.html?language=${language}&theme=${theme}`,
      );
      const card = page.locator('#github-connection');
      await card.waitFor({ state: 'visible' });
      const connect = card.getByRole('button', {
        name: language === 'en' ? 'sign in with browser' : '使用浏览器登录',
        exact: true,
      });
      await card.locator('textarea').fill('circle-platforms/circle');
      assert.equal(await card.locator('select').inputValue(), 'encrypted');
      assert.deepEqual(
        await page.evaluate(() => window.githubFixture.calls),
        [],
        'render must not authenticate',
      );
      await connect.click();
      await card.getByRole('alert').waitFor();
      assert.match(
        await card.getByRole('alert').textContent(),
        /secure credential storage is unavailable/,
      );
      assert.deepEqual(await page.evaluate(() => window.githubFixture.calls), [
        {
          name: 'github',
          args: 'connect {"storage":"encrypted","repositories":["circle-platforms/circle"]}',
        },
      ]);
      await card.locator('select').selectOption('session');
      await connect.click();
      await page.waitForFunction(() => window.githubFixture.calls.length === 2);
      assert.match(
        (await page.evaluate(() => window.githubFixture.calls))[1].args,
        /"storage":"session"/,
      );
      await page.evaluate(() => window.githubFixture.setView('authorizing'));
      await card.getByText('CODE-TEST').waitFor();
      await card
        .getByRole('button', {
          name: language === 'en' ? 'cancel login' : '取消登录',
          exact: true,
        })
        .click();
      await page.waitForFunction(() => window.githubFixture.calls.length === 3);
      assert.equal(
        (await page.evaluate(() => window.githubFixture.calls))[2].args,
        'cancel {"epoch":7}',
      );
      assert.equal(
        await page
          .locator('.native-delivery')
          .getByRole('button', {
            name: language === 'en' ? 'sign in with browser' : '使用浏览器登录',
            exact: true,
          })
          .count(),
        0,
        'no second authentication UI',
      );
      assert.equal(
        await page.locator('.native-delivery a').getAttribute('href'),
        '/page/settings',
      );
      await page.screenshot({
        path: `${out}/${language}-${theme}-authorization.png`,
      });
      await page.evaluate(() => window.githubFixture.unavailable());
      await card.getByRole('link').waitFor();
      assert.equal(await card.getByRole('button').count(), 0);
      await page.screenshot({ path: `${out}/${language}-${theme}.png` });
      await page.close();
    }
  await writeFile(
    `${out}/receipt.json`,
    JSON.stringify(
      {
        scope:
          'headless component contract; no real GitHub authentication or connected success simulated',
        passed: true,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
