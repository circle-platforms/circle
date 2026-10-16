import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out =
  process.env.CIRCLE_UI_EVIDENCE || '/tmp/circle-github-permissions-ui';
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
        const label = (en, zh) => (language === 'en' ? en : zh);
        await page.goto(
          `${server.resolvedUrls.local[0]}test/github-connection-ui.html?language=${language}&theme=${theme}`,
        );
        const card = page.locator('#github-connection');
        await card.waitFor();
        await page.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme,
        );
        const palette = await page.evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        );
        const details = card.locator('.github-permissions');
        assert.equal(await details.evaluate((e) => e.open), false);
        await details.locator('summary').focus();
        await page.keyboard.press('Enter');
        await details
          .getByText(
            label(
              'GitHub has not reported granted permissions.',
              'GitHub 尚未回报已授予的权限。',
            ),
            { exact: false },
          )
          .waitFor();
        assert.doesNotMatch(
          await details.innerText(),
          /workflow/,
          'old metadata does not invent requested scope',
        );
        await page.evaluate(() =>
          window.githubFixture.scopeMetadata({
            requestedAdditionalScopes: ['workflow'],
            scopeVerification: 'reported',
            grantedScopes: ['repo', 'workflow'],
          }),
        );
        await details
          .getByText(
            label(
              'workflow allows creating or updating GitHub Actions workflow files.',
              'workflow 允许创建或更新 GitHub Actions 工作流文件。',
            ),
            { exact: true },
          )
          .waitFor();
        assert.match(await details.innerText(), /repo, workflow/);
        assert.match(await card.innerText(), /GitHub CLI/);
        await page.screenshot({
          path: `${out}/${language}-${theme}-${width}-reported.png`,
        });
        await page.evaluate(() =>
          window.githubFixture.scopeMetadata({
            requestedAdditionalScopes: ['workflow'],
            scopeVerification: 'reported',
            grantedScopes: [],
          }),
        );
        await details
          .getByText(
            label(
              'GitHub reported no OAuth scopes.',
              'GitHub 实际回报没有 OAuth 权限范围。',
            ),
            { exact: false },
          )
          .waitFor();
        await page.evaluate(() =>
          window.githubFixture.scopeMetadata({
            requestedAdditionalScopes: ['unexpected secret'],
            scopeVerification: 'reported',
            grantedScopes: ['invalid scope'],
          }),
        );
        assert.doesNotMatch(
          await details.innerText(),
          /unexpected secret|invalid scope/,
        );
        await details
          .getByText(
            label(
              'GitHub has not reported granted permissions.',
              'GitHub 尚未回报已授予的权限。',
            ),
            { exact: false },
          )
          .waitFor();
        await page.evaluate(() => window.githubFixture.disableWithStaleView());
        await details.waitFor({ state: 'detached' });
        assert.equal(
          await card.locator('.github-permissions').count(),
          0,
          'off never shows stale grant',
        );
        assert.deepEqual(
          await page.evaluate(() => window.githubFixture.calls),
          [],
          'view disclosure does not authorize or refresh remotely',
        );
        assert.deepEqual(errors, []);
        receipt.push({
          language,
          theme,
          width,
          palette,
          passed: true,
          evidence: 'controlled view metadata, no OAuth',
        });
        await page.close();
      }
} finally {
  await writeFile(`${out}/receipt.json`, JSON.stringify(receipt, null, 2));
  await browser?.close();
  await server.close();
}
