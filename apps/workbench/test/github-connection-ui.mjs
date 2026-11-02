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
        const connect = button('connect GitHub', '连接 GitHub');
        const stay = card.getByRole('radio', {
          name: label(
            'stay signed in on this computer',
            '在这台电脑上保持登录',
          ),
          exact: true,
        });
        const sessionOnly = card.getByRole('radio', {
          name: label('sign out when Circle closes', 'Circle 关闭时退出登录'),
          exact: true,
        });
        const addField = card.getByRole('textbox', {
          name: label('add repository', '添加仓库'),
          exact: true,
        });
        const listed = () =>
          card.locator('.github-repositories li > span').allInnerTexts();
        const primaries = () =>
          card
            .locator('.github-summary button.primary')
            .evaluateAll((nodes) => nodes.map((node) => node.textContent));
        const overflow = () =>
          page.evaluate(() => {
            const card = document.querySelector('#github-connection');
            return {
              page: document.documentElement.scrollWidth - innerWidth,
              card: card.scrollWidth - card.clientWidth,
            };
          });
        assert.equal(await stay.isChecked(), true);
        assert.equal(await sessionOnly.isChecked(), false);
        // One primary action per state: connect while signed out.
        assert.deepEqual(await primaries(), [
          label('connect GitHub', '连接 GitHub'),
        ]);
        assert.deepEqual(await overflow(), { page: 0, card: 0 });
        // A repository that is not owner/repository blocks both adding and connecting.
        await addField.fill('not a repository');
        assert.equal(await button('add', '添加').isDisabled(), true);
        assert.equal(await connect.isDisabled(), true);
        await card.locator('.github-field-error').waitFor();
        await addField.fill('');
        assert.equal(await connect.isEnabled(), true);
        assert.equal(await card.locator('.github-field-error').count(), 0);
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
          await stay.isChecked(),
          true,
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
        await sessionOnly.check();
        assert.equal(await stay.isChecked(), false);
        await connect.click();
        await card.getByText('CODE-TEST', { exact: true }).waitFor();
        assert.equal(
          await card.getByRole('alert').count(),
          0,
          'new successful command clears old local error',
        );
        // Which program signs in is an internal detail and stays off the card.
        assert.doesNotMatch(await card.innerText(), /GitHub CLI/);
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
        assert.deepEqual(await primaries(), [
          label('open GitHub', '打开 GitHub'),
        ]);
        assert.deepEqual(await overflow(), { page: 0, card: 0 });
        await button('copy code', '复制代码').click();
        await button('open GitHub', '打开 GitHub').click();
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
        await button('cancel', '取消').click();
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
            label('connected as fixture-account', '已连接：fixture-account'),
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
        // Connected: no primary in the summary, disconnect is the danger action.
        assert.deepEqual(await primaries(), []);
        assert.equal(
          await button('disconnect', '断开连接').evaluate((node) =>
            node.classList.contains('danger'),
          ),
          true,
        );
        const save = button('save', '保存');
        assert.equal(await save.isDisabled(), true);
        await addField.fill('circle-platforms/circle');
        await addField.press('Enter');
        assert.deepEqual(await listed(), ['circle-platforms/circle']);
        assert.equal(await addField.inputValue(), '');
        await page.evaluate(() => window.githubFixture.failNextConfigure());
        await save.click();
        await alert.waitFor();
        assert.deepEqual(await listed(), ['circle-platforms/circle']);
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
            [
              ...document.querySelectorAll(
                '#github-connection .github-repositories li > span',
              ),
            ]
              .map((node) => node.textContent)
              .join() === 'circle-platforms/circle',
        );
        assert.equal(await card.getByRole('alert').count(), 0);
        assert.equal(
          await save.isDisabled(),
          true,
          'actual successful epoch clears dirty form',
        );
        assert.deepEqual(await overflow(), { page: 0, card: 0 });
        await page.screenshot({
          path: `${out}/${language}-${theme}-${width}-connected.png`,
        });
        const editEpoch = await page.evaluate(
          () => window.githubFixture.state().epoch,
        );
        await card
          .getByRole('button', {
            name: label(
              'remove circle-platforms/circle',
              '移除 circle-platforms/circle',
            ),
            exact: true,
          })
          .click();
        await addField.fill('circle-platforms/other');
        await button('add', '添加').click();
        await page.evaluate(() => window.githubFixture.advanceEpoch());
        await save.click();
        await alert.waitFor();
        assert.equal(
          (await page.evaluate(() => window.githubFixture.calls)).at(-1).args,
          `configure {"epoch":${editEpoch},"repositories":["circle-platforms/other"]}`,
        );
        assert.deepEqual(await listed(), ['circle-platforms/other']);
        await button('reset', '重置').click();
        assert.deepEqual(await listed(), ['circle-platforms/circle']);
        const disconnectEpoch = await page.evaluate(
          () => window.githubFixture.state().epoch,
        );
        await button('disconnect', '断开连接').click();
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
        await page.evaluate(() => window.githubFixture.integrationLoading());
        await card
          .getByText(
            label('loading GitHub integration', '正在加载 GitHub 集成…'),
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await card.getByRole('link').count(),
          0,
          'register pending must not tell the user to enable again',
        );
        assert.equal(
          await card.getByRole('button').count(),
          0,
          'register pending cannot start OAuth',
        );
        await page.evaluate(() => window.githubFixture.integrationFailure());
        await card
          .getByText(
            label(
              'GitHub integration could not be loaded.',
              '无法加载 GitHub 集成。',
            ),
            { exact: true },
          )
          .waitFor();
        assert.doesNotMatch(
          await card.innerText(),
          /synthetic GitHub module/,
          'raw module failure stays folded',
        );
        await page.evaluate(() => window.githubFixture.integrationReady());
        await connect.waitFor();
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
