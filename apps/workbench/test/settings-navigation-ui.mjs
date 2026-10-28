import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
const output = process.env.CIRCLE_SETTINGS_UI_EVIDENCE_DIR;
if (output) await mkdir(output, { recursive: true });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const theme of ['light', 'dark'])
    for (const language of ['en', 'zh-CN'])
      for (const width of [1440, 760, 500]) {
        const page = await browser.newPage({
          viewport: { width, height: 700 },
        });
        await page.goto(
          `${server.resolvedUrls.local[0]}test/settings-navigation-ui.html?theme=${theme}&language=${language}`,
        );
        const en = language === 'en';
        const items = page.locator('.settings-index-list button');
        const search = page.locator('.settings-index input');
        await items.nth(4).waitFor();
        const narrow = width <= 720;
        // The groups, under their headings; the narrow row drops the headings.
        assert.equal(await items.count(), 5);
        assert.equal(
          await page
            .locator('.settings-group-label')
            .evaluateAll(
              (nodes) =>
                nodes.filter(
                  (node) => getComputedStyle(node).display !== 'none',
                ).length,
            ),
          narrow ? 0 : 3,
          'headings over the groups, in the wide layout only',
        );
        // Each group is named by its heading, also where the heading is not drawn.
        for (const name of en
          ? ['general', 'capabilities', 'permissions & safety']
          : ['通用', '能力', '权限与安全'])
          assert.equal(
            await page.getByRole('group', { name, exact: true }).count(),
            1,
          );
        assert.equal(
          await page.locator(".settings-index [aria-current='page']").count(),
          1,
        );
        assert.equal(
          await page
            .locator(".settings-index [aria-current='page']")
            .textContent(),
          en ? 'appearance' : '外观',
        );
        // The list follows the width: a column, or a row to scroll sideways.
        assert.equal(
          await page
            .locator('.settings-index-list')
            .evaluate((node) => getComputedStyle(node).flexDirection),
          narrow ? 'row' : 'column',
        );
        // A word of a section's own, and one only its page holds.
        await search.fill('GitHub');
        assert.equal(await items.count(), 1);
        assert.deepEqual(
          await page
            .locator('.settings-group-label')
            .evaluateAll((nodes) =>
              nodes
                .filter((node) => getComputedStyle(node).display !== 'none')
                .map((node) => node.textContent),
            ),
          narrow ? [] : [en ? 'capabilities' : '能力'],
          'a heading with no match goes',
        );
        await search.press('Enter');
        assert.equal(
          await page
            .locator(".settings-index [aria-current='page']")
            .textContent(),
          en ? 'extensions' : '扩展',
          'enter opens the first match',
        );
        await search.fill('secret-token');
        assert.equal(
          await items.count(),
          0,
          'only labels and their words are searched, never what a page holds',
        );
        assert.equal(
          await page.getByRole('status').textContent(),
          en ? 'no matching settings' : '没有匹配的设置',
        );
        // Esc empties the box first; a second one is the dialog's.
        await search.press('Escape');
        assert.equal(await search.inputValue(), '');
        assert.equal(
          await page.evaluate(() => window.settingsEffects.escaped),
          0,
          'the first Escape only empties the search',
        );
        assert.equal(await items.count(), 5);
        await search.press('Escape');
        assert.equal(
          await page.evaluate(() => window.settingsEffects.escaped),
          1,
          'the next one reaches the dialog',
        );
        // The arrows walk the list.
        await search.press('ArrowDown');
        assert.equal(
          await items
            .first()
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page.keyboard.press('ArrowDown');
        assert.equal(
          await items
            .nth(1)
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page.keyboard.press('ArrowUp');
        assert.equal(
          await items
            .first()
            .evaluate((node) => node === document.activeElement),
          true,
        );
        // A group opens at its top, whatever the last one was scrolled to.
        await page.locator('.settings-sections').evaluate((node) => {
          node.scrollTop = 600;
        });
        assert.ok(
          (await page
            .locator('.settings-sections')
            .evaluate((node) => node.scrollTop)) > 0,
          'the page is long enough to scroll',
        );
        await items.nth(1).click();
        assert.equal(
          await page
            .locator('.settings-sections .page')
            .getAttribute('data-group'),
          'shortcuts',
        );
        await page.waitForFunction(
          () => document.querySelector('.settings-sections').scrollTop === 0,
        );
        assert.deepEqual(
          await page.evaluate(() => window.settingsEffects.selected),
          ['extensions', 'shortcuts'],
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          'nothing makes the window scroll sideways',
        );
        assert.equal(
          await page
            .getByRole('region', { name: en ? 'shortcuts' : '快捷键' })
            .count(),
          1,
          'the right side is named for its group',
        );
        if (output)
          await page.screenshot({
            path: join(output, `${theme}-${language}-${width}.png`),
          });
        await page.close();
      }
  console.log(
    'settings navigation: 12 light/dark, English/Chinese, wide/narrow scenarios passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
