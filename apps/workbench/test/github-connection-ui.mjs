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
const out =
  process.env.CIRCLE_GITHUB_UI_EVIDENCE ??
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-github-ui-')));
await mkdir(out, { recursive: true });
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
        const button = (en, zh) =>
          card.getByRole('button', { name: label(en, zh), exact: true });
        const connect = button(
          'start GitHub authorization',
          '开始 GitHub 授权',
        );
        assert.equal(await card.locator('select').inputValue(), 'encrypted');
        assert.deepEqual(
          await page.evaluate(() => window.githubFixture.calls),
          [],
        );
        await connect.click();
        const alert = card.getByRole('alert');
        await alert.waitFor();
        assert.match(
          await alert.innerText(),
          language === 'en'
            ? /Secure credential storage is unavailable\./
            : /安全凭据存储暂不可用。/,
        );
        assert.doesNotMatch(
          await alert.innerText(),
          /Error: secure credential/,
          'raw exception is folded',
        );
        assert.equal(
          await alert.locator('details').evaluate((el) => el.open),
          false,
        );
        assert.equal(
          await card.locator('select').inputValue(),
          'encrypted',
          'no automatic session downgrade',
        );
        await page.screenshot({
          path: `${out}/${language}-${theme}-${width}-storage-error.png`,
        });
        await alert.locator('summary').click();
        assert.equal(
          await alert.locator('pre').textContent(),
          'Error: secure credential storage is unavailable\noriginal detail retained',
        );
        await button('copy error details', '复制错误详情').click();
        assert.equal(
          (await page.evaluate(() => window.githubFixture.copies))[0],
          'Error: secure credential storage is unavailable\noriginal detail retained',
        );
        await card.locator('select').selectOption('session');
        await connect.click();
        await card.getByText('CODE-TEST', { exact: true }).waitFor();
        assert.equal(
          await card.getByRole('alert').count(),
          0,
          'new successful command clears old local error',
        );
        assert.match(await card.innerText(), /GitHub CLI/);
        const code = card.locator('code').filter({ hasText: 'CODE-TEST' });
        assert.equal(
          await code.evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getClientRects().length;
          }),
          1,
          'authorization code stays on one line',
        );
        await button('copy authorization code', '复制授权码').click();
        await button('open GitHub authorization', '打开 GitHub 授权页').click();
        assert.deepEqual(
          await page.evaluate(() => window.githubFixture.opened),
          ['https://github.com/login/device'],
        );
        assert.equal(
          (await page.evaluate(() => window.githubFixture.copies)).at(-1),
          'CODE-TEST',
        );
        await page.screenshot({
          path: `${out}/${language}-${theme}-${width}-authorization.png`,
        });
        const cancelEpoch = await page.evaluate(
          () => window.githubFixture.state().epoch,
        );
        await button('cancel login', '取消登录').click();
        await connect.waitFor();
        assert.equal(
          (await page.evaluate(() => window.githubFixture.calls)).at(-1).args,
          `cancel {"epoch":${cancelEpoch}}`,
        );
        assert.equal(
          await card.getByText('CODE-TEST', { exact: true }).count(),
          0,
        );
        await connect.click();
        await card.getByText('CODE-TEST', { exact: true }).waitFor();
        // Controlled provider notification in a component contract, never real OAuth.
        await page.evaluate(() => window.githubFixture.completeAuthorization());
        await card
          .getByText(
            label('connected as fixture-account', '已连接账户 fixture-account'),
            { exact: true },
          )
          .waitFor();
        await card
          .getByText(
            label(
              'No repositories selected; repository actions are unavailable.',
              '尚未选择仓库，暂不能执行仓库操作。',
            ),
            { exact: true },
          )
          .waitFor();
        assert.equal(await card.getByRole('alert').count(), 0);
        const save = button('save allowed repositories', '保存允许访问的仓库');
        await card.locator('textarea').fill('circle-platforms/circle');
        await page.evaluate(() => window.githubFixture.failNextConfigure());
        await save.click();
        await alert.waitFor();
        assert.equal(
          await card.locator('textarea').inputValue(),
          'circle-platforms/circle',
        );
        assert.match(
          await alert.innerText(),
          language === 'en'
            ? /GitHub action could not be completed\./
            : /未能完成 GitHub 操作。/,
        );
        assert.doesNotMatch(
          await alert.innerText(),
          /configuration write failed/,
        );
        await save.click();
        await page.waitForFunction(
          () =>
            window.githubFixture.state().repositories[0] ===
            'circle-platforms/circle',
        );
        await page.waitForFunction(
          () =>
            document.querySelector('#github-connection textarea').value ===
            'circle-platforms/circle',
        );
        assert.equal(await card.getByRole('alert').count(), 0);
        assert.equal(
          await save.isDisabled(),
          true,
          'actual successful epoch clears dirty form',
        );
        await page.screenshot({
          path: `${out}/${language}-${theme}-${width}-connected.png`,
        });
        const editEpoch = await page.evaluate(
          () => window.githubFixture.state().epoch,
        );
        await card.locator('textarea').fill('circle-platforms/other');
        await page.evaluate(() => window.githubFixture.advanceEpoch());
        await save.click();
        await alert.waitFor();
        assert.equal(
          (await page.evaluate(() => window.githubFixture.calls)).at(-1).args,
          `configure {"epoch":${editEpoch},"repositories":["circle-platforms/other"]}`,
        );
        assert.equal(
          await card.locator('textarea').inputValue(),
          'circle-platforms/other',
        );
        await button('reset repository edits', '还原仓库编辑').click();
        assert.equal(
          await card.locator('textarea').inputValue(),
          'circle-platforms/circle',
        );
        const disconnectEpoch = await page.evaluate(
          () => window.githubFixture.state().epoch,
        );
        await button('disconnect GitHub', '断开 GitHub 连接').click();
        await connect.waitFor();
        assert.equal(
          (await page.evaluate(() => window.githubFixture.calls)).at(-1).args,
          `disconnect {"epoch":${disconnectEpoch}}`,
        );
        assert.equal(await card.getByRole('alert').count(), 0);
        assert.match(
          await card.innerText(),
          language === 'en'
            ? /revocation is not confirmed/
            : /尚未确认 GitHub 授权已撤销/,
        );
        const delivery = page.locator('.native-delivery');
        await delivery.locator(':scope > summary').click();
        assert.equal(
          await delivery.locator('a').getAttribute('href'),
          '/page/settings',
        );
        assert.equal(
          await delivery
            .getByRole('button', {
              name: label('start GitHub authorization', '开始 GitHub 授权'),
              exact: true,
            })
            .count(),
          0,
        );
        await page.evaluate(() => window.githubFixture.unavailable());
        await card.getByRole('link').waitFor();
        assert.equal(await card.getByRole('button').count(), 0);
        assert.deepEqual(errors, []);
        cases.push({ language, theme, width, passed: true });
        await page.close();
      }
  await writeFile(
    `${out}/receipt.json`,
    JSON.stringify(
      {
        scope:
          'stateful headless component command contract; synthetic account/provider notification, no real OAuth or credential storage',
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
