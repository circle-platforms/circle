import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const evidence =
  process.env.CIRCLE_SOURCE_HEADER_EVIDENCE ??
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  let count = 0;
  for (const width of [375, 1280])
    for (const theme of ['light', 'dark'])
      for (const lang of ['en', 'zh-CN'])
        for (const source of ['parent', 'child']) {
          const page = await browser.newPage({
            viewport: { width, height: 800 },
          });
          const errors = [];
          page.on('pageerror', (error) => errors.push(String(error)));
          await page.goto(
            server.resolvedUrls.local[0] +
              `test/file-source-heading-ui.html?${new URLSearchParams({ theme, lang, source, readonly: 'true' })}`,
          );
          await page.waitForFunction(
            ({ theme, lang }) =>
              document.documentElement.dataset.theme === theme &&
              document.documentElement.lang === lang,
            { theme, lang },
          );
          const heading = page.locator('.file-view-heading');
          await heading.getByText('README.md', { exact: true }).waitFor();
          const origin = heading.locator('.file-source-origin');

          assert.doesNotMatch(
            await heading.innerText(),
            /a0b1c2d3e4f5678901234567|task-worktrees/,
            'internal generated directory is never default heading text',
          );
          assert.match(
            await origin.textContent(),
            source === 'child' ? /Login agent/ : /parent-project/,
          );
          // A child source says it is an agent's; the parent shows its workspace
          // by name, and both keep the full owner and folder for assistive tech.
          if (source === 'child')
            assert.match(
              await origin.textContent(),
              lang === 'en' ? /agent source:/ : /Agent 来源/,
            );
          else assert.equal(await origin.textContent(), 'parent-project');
          assert.match(
            await origin.getAttribute('aria-label'),
            source === 'child'
              ? lang === 'en'
                ? /^agent source: .*: \/isolated\//
                : /^Agent 来源：.*: \/isolated\//
              : lang === 'en'
                ? /^workspace: parent-project: \/isolated\/parent-project$/
                : /^工作区：parent-project: \/isolated\/parent-project$/,
          );
          await heading
            .getByText(lang === 'en' ? 'read-only' : '只读', {
              exact: true,
            })
            .waitFor();
          await page.waitForFunction(
            (source) =>
              document
                .querySelector('.view-lines')
                ?.textContent?.includes(
                  source === 'child' ? 'CHILD' : 'PARENT',
                ),
            source,
          );
          assert(
            await page
              .getByRole('button', {
                name: lang === 'en' ? 'save' : '保存',
                exact: true,
              })
              .last()
              .isDisabled(),
          );
          await page.evaluate(() => document.fonts.ready);
          await origin.focus();
          const tooltip = page.getByRole('tooltip');
          await tooltip.waitFor();
          const sourceTooltipId = await tooltip.getAttribute('id');
          assert(
            sourceTooltipId,
            'the source tooltip has a stable rendered identity',
          );
          assert.match(
            await tooltip.textContent(),
            new RegExp(
              `/isolated/${source === 'child' ? 'task-worktrees/a0b1c2d3e4f5678901234567-2' : 'parent-project'}`,
            ),
          );
          assert(
            await heading.evaluate((node) => {
              const box = node.getBoundingClientRect();
              return (
                box.left >= 0 &&
                box.right <= innerWidth + 1 &&
                [
                  ...node.querySelectorAll(
                    '.file-source-origin, .file-source-readonly, button',
                  ),
                ].every((child) => {
                  const rect = child.getBoundingClientRect();
                  return rect.left >= box.left && rect.right <= box.right + 1;
                })
              );
            }),
            'source, readonly and close remain within original header',
          );
          // The directory tooltip is tested above, but is not part of a header
          // baseline: close it before capturing to avoid overlaying its label.
          await heading.click({ position: { x: 5, y: 5 } });
          await page
            .locator(`[id="${sourceTooltipId}"]`)
            .waitFor({ state: 'hidden' });
          await page.evaluate(() => document.fonts.ready);
          assert(
            await heading
              .locator('.file-view-filename strong')
              .evaluate((node) => {
                const rect = node.getBoundingClientRect();
                const actual = document.elementFromPoint(
                  rect.left + rect.width / 2,
                  rect.top + rect.height / 2,
                );
                return (
                  node.textContent === 'README.md' &&
                  rect.width >= node.scrollWidth &&
                  (actual === node || node.contains(actual))
                );
              }),
            'filename must be fully sized and unobscured, including Chinese child sources',
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.dataset.theme),
            theme,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.lang),
            lang,
          );
          if (evidence)
            await heading.screenshot({
              path: join(evidence, `${width}-${theme}-${lang}-${source}.png`),
            });
          assert.deepEqual(errors, []);
          await page.close();
          count++;
        }
  for (const source of ['parent', 'child']) {
    const page = await browser.newPage({
      viewport: { width: 375, height: 800 },
    });
    await page.goto(
      server.resolvedUrls.local[0] +
        `test/file-source-heading-ui.html?source=${source}&readonly=false`,
    );
    await page.locator('.file-source-origin').waitFor();
    assert.equal(await page.locator('.file-source-readonly').count(), 0);
    assert.equal(
      await page
        .getByRole('button', { name: 'save', exact: true })
        .last()
        .isDisabled(),
      false,
    );
    await page.close();
  }
  console.log(
    `${count} original source header combinations passed: same-name parent/child, readonly, directory focus tooltip, locale/theme/narrow bounds`,
  );
} finally {
  await browser?.close();
  await server.close();
}
