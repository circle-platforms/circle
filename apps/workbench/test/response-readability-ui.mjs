import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 0,
    fs: {
      allow: [
        fileURLToPath(new URL('../../..', import.meta.url)),
        await realpath(
          fileURLToPath(new URL('../node_modules', import.meta.url)),
        ),
      ],
    },
  },
  logLevel: 'error',
});
await server.listen();
let browser;
const output =
  process.env.CIRCLE_RESPONSE_UI_EVIDENCE || '/tmp/circle-response-readability';
await mkdir(output, { recursive: true });
const cases = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['dark', 'light'])
      for (const width of [1280, 375]) {
        const page = await browser.newPage({
          viewport: { width, height: 950 },
        });
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(
          `${server.resolvedUrls.local[0]}test/response-readability-ui.html?language=${language}&theme=${theme}#/session/session1`,
        );
        const table = page.getByRole('region', {
          name: language === 'en' ? 'response table' : '回答表格',
          exact: true,
        });
        await table.waitFor();
        const resultHeading = table.getByRole('columnheader', {
          name: '结果',
          exact: true,
        });
        const heading = await resultHeading.evaluate((el) => ({
          whiteSpace: getComputedStyle(el).whiteSpace,
          height: el.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(el).lineHeight),
        }));
        assert.equal(heading.whiteSpace, 'nowrap');
        assert.ok(
          heading.height <= heading.lineHeight + 16,
          'short result header stays on one line',
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          'table must not stretch whole page',
        );
        const overflow = await table.evaluate((el) => ({
          client: el.clientWidth,
          scroll: el.scrollWidth,
        }));
        if (width === 375) {
          assert.ok(
            overflow.scroll > overflow.client,
            'representative wide table is contained in a scroll region',
          );
          await table.focus();
          await page.keyboard.press('ArrowRight');
          await page.waitForFunction(
            () =>
              document.querySelector('.markdown-table-scroll').scrollLeft > 0,
          );
        }
        const summary = page.locator('.thinking summary');
        assert.equal(
          await page.locator('.thinking').evaluate((el) => el.open),
          false,
        );
        assert.equal(await summary.locator('.thinking-chevron').count(), 1);
        const before = await summary
          .locator('.thinking-chevron')
          .evaluate((el) => getComputedStyle(el).transform);
        await summary.focus();
        await page.keyboard.press('Enter');
        assert.equal(
          await page.locator('.thinking').evaluate((el) => el.open),
          true,
        );
        assert.equal(
          await page.locator('.thinking p').textContent(),
          await page.evaluate(() => window.readabilityFixture.thinking),
        );
        const after = await summary
          .locator('.thinking-chevron')
          .evaluate((el) => getComputedStyle(el).transform);
        assert.notEqual(after, before);
        await page.keyboard.press('Enter');
        assert.equal(
          await page.locator('.thinking').evaluate((el) => el.open),
          false,
        );
        const message = page.locator(
          '[data-message-id="response-readability"]',
        );
        await message.hover();
        await message
          .getByRole('button', {
            name: language === 'en' ? 'copy message' : '复制消息',
            exact: true,
          })
          .click();
        assert.deepEqual(
          await page.evaluate(() => window.readabilityFixture.copied),
          [await page.evaluate(() => window.readabilityFixture.text)],
        );
        await page.screenshot({
          path: `${output}/${language}-${theme}-${width}.png`,
        });
        await page
          .getByRole('link', { name: 'public/task-model.mjs:2', exact: true })
          .click();
        await page.locator('.file-view').waitFor();
        await page.waitForFunction(() =>
          document
            .querySelector('.file-view')
            ?.textContent.includes('visibleTasks'),
        );
        assert.ok(
          (await page.locator('.file-view').innerText()).includes(
            'public/task-model.mjs',
          ),
        );
        await page
          .getByRole('button', {
            name: language === 'en' ? 'close file' : '关闭文件',
            exact: true,
          })
          .click();
        await table.waitFor();
        assert.deepEqual(errors, []);
        cases.push({
          language,
          theme,
          width,
          heading,
          overflow,
          before,
          after,
          native: false,
          passed: true,
        });
        await page.close();
      }
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify(
      {
        native: false,
        scope:
          'Full original CircleWorkbench with screenshot-representative model response; isolated clipboard-port spy; actual source route and native details keyboard interaction',
        cases,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, cases, output }));
} finally {
  await browser?.close();
  await server.close();
}
