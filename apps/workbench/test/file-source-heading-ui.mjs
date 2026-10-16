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
          assert.match(
            await origin.textContent(),
            source === 'child'
              ? lang === 'en'
                ? /agent source:/
                : /Agent 来源/
              : lang === 'en'
                ? /workspace source:/
                : /工作区来源/,
          );
          await heading
            .getByText(lang === 'en' ? 'read-only source' : '只读来源', {
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
                name: lang === 'en' ? 'save buffer' : '保存缓冲区',
                exact: true,
              })
              .last()
              .isDisabled(),
          );
          await origin.focus();
          const tooltip = page.getByRole('tooltip');
          await tooltip.waitFor();
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
        .getByRole('button', { name: 'save buffer', exact: true })
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
