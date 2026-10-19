import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// What the overview leads to: the pull request button asks Circle for the create-pr skill,
// a pull request's menu opens, copies its link or its failed CI log, an output opens its
// difference in the changes mode, and there a file opens in the files mode, whose tree
// marks what changed. The plan key brings the overview back, and /terminals the terminal.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-overview-actions-')));
await mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const [theme, locale] of [
    ['light', 'en'],
    ['dark', 'zh-CN'],
  ]) {
    const zh = locale === 'zh-CN';
    const w = (en, cn) => (zh ? cn : en);
    const page = await browser.newPage({
      viewport: { width: 1680, height: 950 },
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/overview-actions-ui.html?theme=${theme}&locale=${locale}`,
    );
    const calls = (name) =>
      page.evaluate(
        (name) =>
          window.overviewFixture.calls
            .filter((entry) => entry.call === name)
            .map((entry) => entry.args),
        name,
      );
    const modeButton = (name) =>
      page.getByRole('button', {
        name: w(`${name} panel`, `${name}面板`),
        exact: true,
      });
    const overviewButton = page.locator(
      '.drawer-mode-toolbar > .drawer-mode-button',
    );
    const overview = page.locator('aside.overview');
    if ((await overviewButton.first().getAttribute('aria-pressed')) !== 'true')
      await overviewButton.first().click();
    await overview.waitFor();

    // The pull request button: Circle is asked to run create-pr in the conversation
    await overview
      .getByRole('button', { name: w('update pr', '更新 PR'), exact: true })
      .click();
    await page.waitForFunction(() =>
      window.overviewFixture.requests().some((one) => one.kind === 'prompt'),
    );
    const requests = await page.evaluate(() =>
      window.overviewFixture.requests(),
    );
    assert.deepEqual(
      requests.find((one) => one.kind === 'load-skill')?.payload,
      { name: 'create-pr' },
    );
    assert.equal(
      requests.find((one) => one.kind === 'prompt')?.payload.display,
      '/create-pr',
    );

    // A pull request's menu: open it, copy its link, copy its failed CI log
    const menu = () =>
      overview
        .getByRole('button', {
          name: w('pull request 186 actions', '拉取请求 #186 的操作'),
          exact: true,
        })
        .click();
    await menu();
    await page
      .getByRole('menuitem', { name: w('copy link', '复制链接'), exact: true })
      .click();
    await menu();
    await page
      .getByRole('menuitem', { name: w('open pr', '打开 PR'), exact: true })
      .click();
    await menu();
    await page
      .getByRole('menuitem', {
        name: w('copy failed ci logs', '复制失败的 CI 日志'),
        exact: true,
      })
      .click();
    await page.waitForFunction(
      () =>
        window.overviewFixture.calls.filter(
          (entry) => entry.call === 'copyText',
        ).length === 2,
    );
    const url = 'https://github.com/acme/orbit-api/pull/186';
    assert.deepEqual(await calls('copyText'), [
      [url],
      ['FAIL test/reconnect.test.ts'],
    ]);
    assert.deepEqual(await calls('openExternal'), [[url]]);
    assert.deepEqual(await calls('pulls.failedLog'), [[{ runId: 4021 }]]);
    await page.screenshot({
      path: `${output}/overview-${theme}-${locale}.png`,
    });

    // An output opens its difference in the changes mode
    await overview
      .getByRole('button', { name: /connection\.ts/ })
      .first()
      .click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('.changes-row[aria-current="true"]')
          ?.textContent?.includes('connection.ts') === true,
    );
    assert.equal(
      await modeButton(w('changes', '改动')).getAttribute('aria-pressed'),
      'true',
    );
    await page
      .locator('.changes-diff')
      .getByText('const pending = [...session.pending];')
      .first()
      .waitFor();
    const letters = await page
      .locator('.changes-row .overview-letter')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual([...letters].sort(), ['A', 'D', 'M', 'M']);
    // A deleted file has its difference and nothing to open
    await page
      .locator('.changes-row')
      .filter({ hasText: 'legacy-retry.ts' })
      .click();
    await page
      .locator('.changes-file header')
      .getByText(/legacy-retry/)
      .waitFor();
    assert.equal(
      await page
        .locator('.changes-file')
        .getByRole('button', { name: w('open file', '打开文件') })
        .count(),
      0,
    );
    await page
      .locator('.changes-row')
      .filter({ hasText: 'connection.ts' })
      .click();
    await page
      .locator('.changes-file')
      .getByRole('button', { name: w('open file', '打开文件') })
      .click();

    // The file opens in the files mode, whose tree marks what changed
    await page.locator('.file-view').waitFor();
    assert.equal(
      await modeButton(w('files', '文件')).getAttribute('aria-pressed'),
      'true',
    );
    const tree = page.locator('.drawer-document [role="tree"]').first();
    await tree.waitFor();
    const marks = () =>
      tree.evaluate((node) => {
        const row = (text) =>
          [...node.querySelectorAll('[role="treeitem"]')].find((item) =>
            item.textContent?.trim().startsWith(text),
          );
        return {
          connection:
            row('connection.ts')?.querySelector('.file-letter')?.textContent,
          added:
            row('reconnect.test.ts')?.querySelector('.file-letter')
              ?.textContent,
          folderDots: ['src', 'tests'].map(
            (folder) => !!row(folder)?.querySelector('.file-dot'),
          ),
          deleted: !!row('legacy-retry.ts'),
        };
      });
    // a folder with a changed file in it has a dot, even folded
    assert.deepEqual((await marks()).folderDots, [true, true]);
    await tree
      .getByRole('treeitem', { name: /^tests/ })
      .first()
      .click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="treeitem"]')].some((item) =>
        item.textContent?.trim().startsWith('reconnect.test.ts'),
      ),
    );
    assert.deepEqual(await marks(), {
      connection: 'M',
      added: 'A',
      folderDots: [true, true],
      deleted: false,
    });
    await page.screenshot({ path: `${output}/files-${theme}-${locale}.png` });

    // The plan key brings back the overview the person closed
    await modeButton(w('files', '文件')).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('.drawer-mode-toolbar > .drawer-mode-button')
          ?.getAttribute('aria-pressed') === 'true',
    );
    await overviewButton.first().click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('.drawer-mode-toolbar > .drawer-mode-button')
          ?.getAttribute('aria-pressed') === 'false',
    );
    await page.getByRole('textbox', { name: w('message', '消息') }).focus();
    await page.keyboard.press('Alt+p');
    await page.waitForFunction(
      () =>
        document
          .querySelector('.drawer-mode-toolbar > .drawer-mode-button')
          ?.getAttribute('aria-pressed') === 'true',
    );

    // /terminals opens the terminal mode
    const message = page.getByRole('textbox', { name: w('message', '消息') });
    await message.fill('/terminals');
    await message.press('Enter');
    await page.waitForFunction(
      (name) =>
        document
          .querySelector(`.drawer-mode-button[aria-label="${name}"]`)
          ?.getAttribute('aria-pressed') === 'true',
      w('terminal panel', '终端面板'),
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
console.log('overview actions: ok');
