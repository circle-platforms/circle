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
        const manage = detail
          .locator('summary')
          .filter({ hasText: new RegExp('^' + label('manage', '管理') + '$') });
        await manage.click();
        const toggle = detail.getByRole('checkbox', { name: 'enable github' });
        // Switch accessibility label is translated while the plugin id remains literal.
        const control =
          language === 'en'
            ? toggle
            : detail.getByRole('checkbox', { name: /github/ });
        assert.equal(await control.isChecked(), false);
        await control.focus();
        await page.keyboard.press('Space');
        await page.waitForFunction(
          () => window.githubPluginFixture.commands.length === 1,
        );
        assert.equal(
          await detail
            .getByRole('button', {
              name: label('try now', '立即试用'),
              exact: true,
            })
            .isEnabled(),
          false,
        );
        await page.evaluate(() => window.githubPluginFixture.reply(0));
        await detail
          .getByText(
            label('loading GitHub integration', '正在加载 GitHub 集成…'),
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await detail
            .getByText(
              label(
                'Enable the plugin to see its available tools.',
                '启用插件后可查看可用工具。',
              ),
              { exact: true },
            )
            .count(),
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
          await detail
            .getByText(
              label(
                'Enable the plugin to see its available tools.',
                '启用插件后可查看可用工具。',
              ),
              { exact: true },
            )
            .count(),
          0,
        );
        await page.evaluate(() => window.githubPluginFixture.load());
        await detail
          .getByText(label('GitHub login required', '需要登录 GitHub'), {
            exact: true,
          })
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
          name: label('try now', '立即试用'),
          exact: true,
        });
        await tryButton.waitFor();
        assert.equal(await tryButton.isEnabled(), true);
        assert.equal(
          await tryButton.evaluate((button) =>
            button.classList.contains('primary'),
          ),
          false,
          'disconnected example is secondary to authorization',
        );
        assert.equal(
          await detail.locator('button.primary').count(),
          1,
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
        assert.equal(
          await detail.locator('#github-connection textarea').isVisible(),
          false,
          'optional repositories folded',
        );
        await detail.locator('#github-connection h2').click();
        await page.screenshot({
          animations: 'disabled',
          path: `${output}/${language}-${theme}-${width}-plugin-ready.png`,
        });
        await page.evaluate(() => window.githubPluginFixture.connected());
        await detail
          .getByText(
            label('connected as fixture-account', '已连接账户 fixture-account'),
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await tryButton.evaluate((button) =>
            button.classList.contains('primary'),
          ),
          true,
          'connected example is the primary action',
        );
        assert.equal(await detail.locator('button.primary').count(), 1);
        const capabilities = detail.getByText(
          label('capabilities', '能力介绍'),
          {
            exact: true,
          },
        );
        await capabilities.click();
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
        await capabilities.click();
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
        await detail
          .locator('summary')
          .filter({ hasText: new RegExp('^' + label('manage', '管理') + '$') })
          .click();
        const off = detail.getByRole('checkbox', { name: /github/ });
        await off.uncheck();
        const offIndex = await page.evaluate(
          () => window.githubPluginFixture.commands.length - 1,
        );
        await page.evaluate(
          (index) => window.githubPluginFixture.reply(index),
          offIndex,
        );
        await detail
          .getByText(
            label(
              'GitHub connection is unavailable; enable the bundled GitHub extension in Circle desktop.',
              'GitHub 连接不可用；请在 Circle 桌面版启用内置 GitHub 扩展。',
            ),
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await detail
            .getByRole('button', {
              name: label('try now', '立即试用'),
              exact: true,
            })
            .isEnabled(),
          false,
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
