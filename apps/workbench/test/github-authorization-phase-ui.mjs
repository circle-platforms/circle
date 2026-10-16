import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out =
  process.env.CIRCLE_UI_EVIDENCE || '/tmp/circle-github-authorization-phase';
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
        const card = page.locator('#github-connection');
        await card.waitFor();
        await page.waitForFunction(
          (t) => document.documentElement.dataset.theme === t,
          theme,
        );
        const disconnectedWarning = label(
          'Disconnected from Circle. GitHub authorization revocation is not confirmed.',
          '已从 Circle 断开连接。尚未确认 GitHub 授权已撤销。',
        );
        for (const current of ['disconnected', 'authorizing', 'connected']) {
          await page.evaluate(
            (current) => window.githubFixture.priorDisconnectedGrant(current),
            current,
          );
          await page.waitForFunction(() =>
            document
              .querySelector('#github-connection')
              ?.textContent?.includes('GitHub'),
          );
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          assert.equal(
            await card.getByText(disconnectedWarning, { exact: true }).count(),
            current === 'disconnected' ? 1 : 0,
            'historical remote grant warning must not claim a current connected/authorizing session is disconnected',
          );
          if (current === 'connected')
            await card
              .getByText(
                label(
                  'connected as fixture-account',
                  '已连接账户 fixture-account',
                ),
                { exact: true },
              )
              .waitFor();
        }
        for (const authorization of [
          undefined,
          { id: 'preparing', code: '', status: 'waiting' },
          {
            id: 'preparing',
            code: '',
            url: 'https://github.com/login/device',
            status: 'waiting',
          },
        ]) {
          await page.evaluate(
            (authorization) =>
              window.githubFixture.preparingAuthorization(authorization),
            authorization,
          );
          await card
            .getByText(
              label(
                'preparing GitHub authorization code',
                '正在准备 GitHub 授权码…',
              ),
              { exact: true },
            )
            .waitFor();
          assert.equal(
            await card
              .getByText(
                label(
                  'enter this code in your browser',
                  '在浏览器中输入此代码',
                ),
                { exact: true },
              )
              .count(),
            0,
          );
          assert.equal(
            await card
              .getByRole('button', {
                name: label('copy authorization code', '复制授权码'),
                exact: true,
              })
              .count(),
            0,
          );
          assert.equal(
            await card
              .getByRole('button', {
                name: label('open GitHub authorization', '打开 GitHub 授权页'),
                exact: true,
              })
              .count(),
            0,
          );
          assert.equal(
            await card
              .getByRole('button', {
                name: label('cancel login', '取消登录'),
                exact: true,
              })
              .isEnabled(),
            true,
          );
        }
        await page.screenshot({
          path: `${out}/${language}-${theme}-${width}-preparing.png`,
        });
        await page.evaluate(() => window.githubFixture.authorizationCode());
        await card
          .getByText(
            label('waiting for GitHub authorization', '等待 GitHub 授权'),
            { exact: true },
          )
          .waitFor();
        assert.equal(await card.locator('code').innerText(), 'CODE-TEST');
        await card
          .getByRole('button', {
            name: label('copy authorization code', '复制授权码'),
            exact: true,
          })
          .click();
        await card
          .getByRole('button', {
            name: label('open GitHub authorization', '打开 GitHub 授权页'),
            exact: true,
          })
          .click();
        assert.deepEqual(
          await page.evaluate(() => window.githubFixture.copies),
          ['CODE-TEST'],
        );
        assert.deepEqual(
          await page.evaluate(() => window.githubFixture.opened),
          ['https://github.com/login/device'],
        );
        await page.screenshot({
          path: `${out}/${language}-${theme}-${width}-code-ready.png`,
        });
        assert.deepEqual(
          await page.evaluate(() => window.githubFixture.calls),
          [],
          'phase events do not invent OAuth or auto open browser',
        );
        await page.evaluate(() =>
          window.githubFixture.verifyingAuthorization(),
        );
        await card
          .getByText(
            label('verifying GitHub account', '正在核验 GitHub 账户…'),
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await card
            .getByText(
              label('enter this code in your browser', '在浏览器中输入此代码'),
              { exact: true },
            )
            .count(),
          0,
        );
        assert.equal(
          await card
            .getByRole('button', {
              name: label('copy authorization code', '复制授权码'),
              exact: true,
            })
            .count(),
          0,
        );
        await card
          .getByRole('button', {
            name: label('cancel login', '取消登录'),
            exact: true,
          })
          .click();
        await card
          .getByText(
            label('GitHub authorization was cancelled.', 'GitHub 授权已取消。'),
            { exact: true },
          )
          .waitFor();
        await page.evaluate(() => window.githubFixture.holdNextConnect());
        await card
          .getByRole('button', {
            name: label('start GitHub authorization', '开始 GitHub 授权'),
            exact: true,
          })
          .click();
        await card
          .getByText(
            label(
              'preparing GitHub authorization code',
              '正在准备 GitHub 授权码…',
            ),
            { exact: true },
          )
          .waitFor();
        const cancel = card.getByRole('button', {
          name: label('cancel login', '取消登录'),
          exact: true,
        });
        assert.equal(
          await cancel.isEnabled(),
          true,
          'real pending connect promise must not block cancellation',
        );
        await cancel.click();
        await card
          .getByText(
            label(
              'GitHub authorization was cancelled before a code was ready. No new connection was established.',
              'GitHub 授权已在授权码生成前取消，尚未建立新连接。',
            ),
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await card
            .getByText(
              label(
                'Disconnected from Circle. GitHub authorization revocation is not confirmed.',
                '已从 Circle 断开连接。尚未确认 GitHub 授权已撤销。',
              ),
              { exact: true },
            )
            .count(),
          0,
          'never connected cancellation does not pretend a disconnect',
        );
        await page.evaluate(() => window.githubFixture.rejectHeldConnect());
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        assert.equal(
          await card.getByRole('alert').count(),
          0,
          'stale connect failure does not replace successful cancellation',
        );
        await page.screenshot({
          path: `${out}/${language}-${theme}-${width}-cancelled-before-code.png`,
        });

        assert.deepEqual(errors, []);
        receipt.push({
          language,
          theme,
          width,
          palette: await page.evaluate(
            () => getComputedStyle(document.documentElement).backgroundColor,
          ),
          passed: true,
          kind: 'controlled actual phase metadata, no OAuth',
        });
        await page.close();
      }
} finally {
  await writeFile(`${out}/receipt.json`, JSON.stringify(receipt, null, 2));
  await browser?.close();
  await server.close();
}
