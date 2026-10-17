import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = process.env.CIRCLE_UI_EVIDENCE || '/tmp/circle-github-plugin-ui';
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
const receipts = [];
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
        await page.clock.setFixedTime(new Date('2026-10-16T00:00:00Z'));
        const label = (en, zh) => (language === 'en' ? en : zh);
        await page.goto(
          server.resolvedUrls.local[0] +
            `test/github-plugin-ui.html?language=${language}&theme=${theme}`,
        );
        const detail = page.getByRole('region', {
          name: label('GitHub plugin', 'GitHub 插件'),
          exact: true,
        });
        await detail.waitFor();
        await page.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme,
        );
        const palette = await page.evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        );
        assert.notEqual(palette, 'rgba(0, 0, 0, 0)');
        const turnOn = label(
          'Turn on GitHub to connect your account.',
          '开启 GitHub 后即可连接你的账户。',
        );
        const tryName = label('try in a conversation', '在对话中试用');
        const overflow = () =>
          page.evaluate(() => {
            const card = document.querySelector('#github-connection');
            return {
              page:
                document.querySelector('.page').scrollWidth -
                document.querySelector('.page').clientWidth,
              card: card.scrollWidth - card.clientWidth,
            };
          });
        const primaries = () =>
          detail
            .locator('button.primary')
            .evaluateAll((nodes) => nodes.map((node) => node.textContent));
        // The switch sits in the summary itself, not behind a fold.
        await detail.getByText(turnOn, { exact: true }).waitFor();
        const toggle = detail.getByRole('checkbox', { name: 'enable GitHub' });
        // Switch accessibility label is translated while the plugin id remains literal.
        const control =
          language === 'en'
            ? toggle
            : detail.getByRole('checkbox', { name: /GitHub/ });
        assert.equal(await control.isChecked(), false);
        await control.focus();
        await page.keyboard.press('Space');
        await page.waitForFunction(
          () => window.githubPluginFixture.commands.length === 1,
        );
        assert.equal(
          await detail
            .getByRole('button', { name: tryName, exact: true })
            .count(),
          0,
          'nothing to try before an account is connected',
        );
        await page.evaluate(() => window.githubPluginFixture.reply(0));
        await detail
          .getByText(
            label('loading GitHub integration', '正在加载 GitHub 集成…'),
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await detail.getByText(turnOn, { exact: true }).count(),
          0,
          'enabled loading must not ask to enable again',
        );
        await page.evaluate(() => window.githubPluginFixture.load(true));
        await detail
          .getByText(
            label(
              'GitHub integration could not be loaded.',
              '无法加载 GitHub 集成。',
            ),
            { exact: true },
          )
          .first()
          .waitFor();
        assert.equal(
          await detail.getByText(turnOn, { exact: true }).count(),
          0,
        );
        await page.evaluate(() => window.githubPluginFixture.load());
        await detail
          .getByText(label('not connected', '未连接'), { exact: true })
          .waitFor();
        assert.equal(
          await detail
            .getByText(label('extension could not be loaded', '无法加载扩展'), {
              exact: true,
            })
            .count(),
          0,
        );
        await detail
          .getByRole('heading', {
            name: label('GitHub account', 'GitHub 账户'),
            exact: true,
          })
          .waitFor();
        const tryButton = detail.getByRole('button', {
          name: tryName,
          exact: true,
        });
        assert.equal(
          await tryButton.count(),
          0,
          'the example waits for a connected account',
        );
        assert.deepEqual(
          await primaries(),
          [label('connect GitHub', '连接 GitHub')],
          'authorization is the only primary action before connection',
        );
        for (const summary of await detail
          .locator('.context-source > summary')
          .all())
          assert.equal(
            await summary.evaluate(
              (element) => getComputedStyle(element).display,
            ),
            'list-item',
            'existing disclosure arrows stay visible',
          );
        assert.deepEqual(
          await page.evaluate(() =>
            window.githubPluginFixture.commands.map((c) => c.name),
          ),
          ['save-settings'],
        );
        const addField = detail.getByRole('textbox', {
          name: label('add repository', '添加仓库'),
          exact: true,
        });
        assert.equal(await addField.inputValue(), '');
        assert.equal(
          await detail
            .getByRole('button', {
              name: label('connect GitHub', '连接 GitHub'),
              exact: true,
            })
            .isEnabled(),
          true,
          'repositories are optional before connecting',
        );
        assert.deepEqual(await overflow(), { page: 0, card: 0 });
        await detail.locator('#github-connection h2').click();
        await page.screenshot({
          animations: 'disabled',
          path: `${output}/${language}-${theme}-${width}-plugin-ready.png`,
        });
        // The device code: open GitHub is the one primary action.
        await page.evaluate(() => window.githubPluginFixture.authorizing());
        await detail.getByText('WDJB-MJHT', { exact: true }).waitFor();
        assert.deepEqual(await primaries(), [
          label('open GitHub', '打开 GitHub'),
        ]);
        assert.equal(await addField.count(), 0);
        assert.deepEqual(await overflow(), { page: 0, card: 0 });
        // A failure says what happened and what to do; the raw text is folded.
        await page.evaluate(() => window.githubPluginFixture.failed());
        const failure = detail.getByRole('alert');
        await failure
          .getByText(
            label('GitHub authorization has expired.', 'GitHub 授权已失效。'),
            { exact: true },
          )
          .waitFor();
        await detail
          .getByText(label('needs attention', '需要处理'), { exact: true })
          .waitFor();
        assert.equal(
          await failure.locator('details').evaluate((node) => node.open),
          false,
        );
        assert.deepEqual(await primaries(), [
          label('connect GitHub', '连接 GitHub'),
        ]);
        assert.deepEqual(await overflow(), { page: 0, card: 0 });
        await page.evaluate(() => window.githubPluginFixture.connected());
        await detail
          .getByText(
            label('connected as fixture-account', '已连接：fixture-account'),
            { exact: true },
          )
          .waitFor();
        assert.equal(await tryButton.isEnabled(), true);
        assert.equal(
          await tryButton.evaluate((button) =>
            button.classList.contains('primary'),
          ),
          false,
          'the example is a secondary action',
        );
        assert.equal(
          await detail.locator('.github-summary button.primary').count(),
          0,
          'connected: nothing in the summary competes as a primary action',
        );
        assert.equal(
          await detail
            .getByRole('button', {
              name: label('disconnect', '断开连接'),
              exact: true,
            })
            .evaluate((button) => button.classList.contains('danger')),
          true,
        );
        // What Circle can do is listed in plain words, not folded.
        await detail
          .getByText(
            label('read pull request checks', '读取拉取请求检查结果'),
            { exact: true },
          )
          .waitFor();
        await detail
          .getByText(
            label(
              'inspect the exact commit and files before publishing',
              '检查待发布的提交和文件',
            ),
            { exact: true },
          )
          .waitFor();
        assert.doesNotMatch(
          await detail.innerText(),
          /github_(?:connection|candidate|checks|logs|retry|publish)/,
          'tool names stay internal',
        );
        assert.deepEqual(await overflow(), { page: 0, card: 0 });
        await detail.locator('#github-connection h2').click();
        await page.screenshot({
          animations: 'disabled',
          path: `${output}/${language}-${theme}-${width}-plugin-account.png`,
        });
        await tryButton.click();
        const composer = page.getByRole('textbox', {
          name: label('message', '消息'),
          exact: true,
        });
        await composer.waitFor();
        assert.equal(
          await composer.evaluate((e) => document.activeElement === e),
          true,
          'Try returns focus to the original composer',
        );
        assert.match(await composer.inputValue(), /^original draft\n\n/);
        const state = await page.evaluate(() =>
          window.githubPluginFixture.snapshot(),
        );
        assert.equal(
          state.sessions.find((s) => s.id === state.activeSessionId)
            .attachments[0].id,
          'keep',
        );
        assert.deepEqual(
          await page.evaluate(() =>
            window.githubPluginFixture.commands
              .filter((c) => c.name !== 'workspace-service')
              .map((c) => c.name),
          ),
          ['save-settings'],
          'try does not send or authorize',
        );
        await page.evaluate(() => (location.hash = '/page/settings'));
        const link = page.getByRole('link', {
          name: label('manage GitHub plugin', '管理 GitHub 插件'),
          exact: true,
        });
        await link.waitFor();
        assert.equal(
          await page.locator('#github-connection').count(),
          0,
          'single account surface',
        );
        await link.click();
        await detail.waitFor();
        await page
          .getByRole('button', {
            name: label('back to plugins', '返回插件'),
            exact: true,
          })
          .click();
        await page
          .getByRole('link', {
            name: label('plugin details', '插件详情'),
            exact: true,
          })
          .first()
          .waitFor();
        await page
          .getByRole('link', {
            name: label('plugin details', '插件详情'),
            exact: true,
          })
          .first()
          .click();
        await detail.waitFor();
        const off = detail.getByRole('checkbox', { name: /GitHub/ });
        await off.uncheck();
        const offIndex = await page.evaluate(
          () => window.githubPluginFixture.commands.length - 1,
        );
        await page.evaluate(
          (index) => window.githubPluginFixture.reply(index),
          offIndex,
        );
        await detail.getByText(turnOn, { exact: true }).waitFor();
        await detail
          .getByText(label('turned off', '已关闭'), { exact: true })
          .waitFor();
        assert.equal(
          await detail
            .getByRole('button', { name: tryName, exact: true })
            .count(),
          0,
        );
        assert.deepEqual(errors, []);
        receipts.push({
          language,
          theme,
          width,
          palette,
          requests: ['save-settings'],
          passed: true,
          kind: 'controlled LiveRuntime original app; no OAuth',
        });
        await page.close();
      }
} finally {
  await writeFile(`${output}/receipt.json`, JSON.stringify(receipts, null, 2));
  await browser?.close();
  await server.close();
}
