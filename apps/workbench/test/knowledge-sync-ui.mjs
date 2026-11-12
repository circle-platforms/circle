// Settings → sync says what the sync server answered, in its own words: a refusal as "the server refused: …", a purge
// it holds for the account holder with the page to confirm on and its deadline, and a server without a discovery
// document as syncing on the fixed paths with no team sharing. A refused "sync now" is said by its kind. English and
// Chinese, light and dark, narrow and wide; a synthetic runtime, no network.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const DETAIL =
  '合成的说明：删除本人副本需要账户持有人确认。到确认页面确认后重试。';
const PAGE = 'https://sync.example.test/console/sync?confirm=purge';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-knowledge-sync-ui-')));
await mkdir(output, { recursive: true });
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
    for (const theme of ['light', 'dark'])
      for (const width of [375, 1280]) {
        const page = await browser.newPage({
          viewport: { width, height: 1000 },
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.setDefaultTimeout(5000);
        const label = (en, zh) => (language === 'en' ? en : zh);
        const name = `${language}-${theme}-${width}`;
        await page.goto(
          `${server.resolvedUrls.local[0]}test/knowledge-sync-ui.html?language=${language}&theme=${theme}`,
        );
        const settings = page.locator('.knowledge-sync-settings');
        // The server's words, as they came
        await settings
          .getByText(
            label(`the server refused: ${DETAIL}`, `服务器拒绝了：${DETAIL}`),
            { exact: true },
          )
          .waitFor();
        // The purge it holds: where to confirm, and by when
        await settings
          .getByText(
            label(
              /^confirm removing the personal copies on the server’s page by .+; Circle finishes the change then$/,
              /^请在 .+ 前到服务器的页面上确认删除本人副本，确认后 Circle 会完成这次更改$/,
            ),
          )
          .waitFor();
        await settings
          .getByRole('button', {
            name: label('open the page', '打开页面'),
            exact: true,
          })
          .click();
        assert.deepEqual(
          await page.evaluate(() => window.knowledgeSyncFixture.opened),
          [PAGE],
        );
        await settings
          .getByRole('button', {
            name: label('copy link', '复制链接'),
            exact: true,
          })
          .waitFor();
        // No discovery document: fixed paths, no team sharing
        await settings
          .getByText(
            label(
              'this server publishes no discovery document: it syncs on the fixed v1 paths; team sharing and team memory are not available',
              '这台服务器没有发布发现文档：按固定的 v1 路径同步，不能分享到团队，也不读取团队记忆',
            ),
            { exact: true },
          )
          .waitFor();
        await page.screenshot({ path: join(output, `${name}-answer.png`) });
        // A refused "sync now" is said by its kind, not as content that could not be opened
        await settings
          .getByRole('button', {
            name: label('sync now', '立即同步'),
            exact: true,
          })
          .click();
        await settings
          .getByRole('alert')
          .getByText(
            label(
              'the sync server refused the request',
              '同步服务器拒绝了这次请求',
            ),
            { exact: true },
          )
          .waitFor();
        assert.deepEqual(errors, []);
        receipts.push(name);
        await page.close();
      }
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify({ cases: receipts }, null, 2),
  );
  console.log(JSON.stringify({ cases: receipts.length, output }));
} finally {
  await browser?.close();
  await server.close();
}
