import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// What the model writes stays in the record as text, a long folded line stays inside the
// conversation's column, and file undo is on the finished turn's own row.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const evidence =
  process.env.CIRCLE_FOLDING_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-conversation-folding-ui-')));
await mkdir(evidence, { recursive: true });
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      for (const width of [1400, 900]) {
        const where = `${language} ${theme} ${width}`;
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(
          `${server.resolvedUrls.local[0]}test/conversation-folding-ui.html?language=${language}&theme=${theme}`,
        );
        const undoWord =
          language === 'en' ? 'undo file changes' : '撤销文件改动';
        const update = page.locator('.message', {
          hasText: 'The review found two problems',
        });
        await update.waitFor();
        await update.scrollIntoViewIfNeeded();

        // The update is text of its own, whole and readable.
        assert.equal(await update.locator('.message-body').count(), 1, where);
        assert.equal(
          await page
            .locator('.tool-summary', { hasText: 'The review found' })
            .count(),
          0,
          `${where}: an update was folded into a line`,
        );
        // A step's row takes no place between an update and its line.
        const gap = await update.evaluate((node) => {
          const body = node.querySelector('.message-body');
          const line = node.parentElement.nextElementSibling;
          return (
            line.querySelector('.tool-summary').getBoundingClientRect().top -
            body.getBoundingClientRect().bottom
          );
        });
        assert(gap < 20, `${where}: ${gap}px between an update and its line`);

        // However long the line is, it stays in the column and gives way with an ellipsis.
        const line = await page.evaluate(() => {
          const button = [...document.querySelectorAll('.tool-summary')].sort(
            (a, b) => b.textContent.length - a.textContent.length,
          )[0];
          const column = button.closest('.transcript-column');
          const style = getComputedStyle(column);
          const edge =
            column.getBoundingClientRect().right -
            parseFloat(style.paddingRight);
          const text = button.querySelector('.tool-summary-text');
          return {
            out: button.getBoundingClientRect().right - edge,
            kids: Math.max(
              ...[...button.children].map(
                (child) => child.getBoundingClientRect().right - edge,
              ),
            ),
            clipped: text.scrollWidth > text.clientWidth,
            overflow: getComputedStyle(text).textOverflow,
            first: text.firstElementChild.className,
            color: getComputedStyle(text.firstElementChild).color,
            rest: getComputedStyle(text.lastElementChild).color,
            words: text.textContent,
          };
        });
        assert(line.out <= 1, `${where}: the line leaves by ${line.out}px`);
        assert(line.kids <= 1, `${where}: a piece leaves by ${line.kids}px`);
        assert.equal(line.overflow, 'ellipsis', where);
        assert.equal(line.first, 'failed', `${where}: the failure comes first`);
        assert.notEqual(line.color, line.rest, `${where}: failure not marked`);
        assert(!line.words.includes('write_todos'), where);

        // Undo sits on the finished turn's row, by its usage; an older turn's waits for the
        // pointer, and there is none under a message of yours.
        const newest = page.locator('.message-meta', {
          has: page.getByText('6m 42s'),
        });
        const undo = newest.getByRole('button', {
          name: undoWord,
          exact: true,
        });
        await undo.scrollIntoViewIfNeeded();
        assert.equal(
          await undo.evaluate((node) => getComputedStyle(node).opacity),
          '1',
          where,
        );
        assert.equal(
          await page.locator('.message.user .safe-file-undo').count(),
          0,
          where,
        );
        assert.equal(await page.locator('.safe-file-undo').count(), 2, where);
        await page.screenshot({
          path: join(evidence, `${language}-${theme}-${width}.png`),
        });
        const older = page
          .locator('.message', { hasText: 'The first turn is finished' })
          .locator('.safe-file-undo > button');
        await older.scrollIntoViewIfNeeded();
        await page.mouse.move(1, 1);
        await page.waitForFunction(
          (word) =>
            [...document.querySelectorAll('.safe-file-undo > button')].some(
              (node) =>
                node.textContent === word &&
                getComputedStyle(node).opacity === '0',
            ),
          undoWord,
        );
        await page
          .locator('.message', { hasText: 'The first turn is finished' })
          .hover();
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('.safe-file-undo > button'))
              .opacity === '1',
        );

        // A line of one call says what it did, and opening it opens the call.
        const single = page.locator('.tool-summary', {
          hasText: '$ git status',
        });
        await single.click();
        await page
          .locator('.tool-content pre', { hasText: '$ git status' })
          .waitFor();
        await page
          .locator('.tool-content pre', { hasText: 'output of' })
          .first()
          .waitFor();

        // A session at work offers no undo.
        await page.evaluate(() => window.foldingFixture.work());
        await page.waitForFunction(
          () => !document.querySelector('.safe-file-undo'),
        );
        assert.deepEqual(errors, [], where);
        await page.close();
      }
  console.log(`conversation folding: ok; screenshots: ${evidence}`);
} finally {
  await browser?.close();
  await server.close();
}
