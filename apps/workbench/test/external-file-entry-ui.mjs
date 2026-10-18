import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openNativeProjectFile } from '../../desktop/test/helpers/native-project-file.mjs';
const output = process.env.CIRCLE_EXTERNAL_ENTRY_EVIDENCE_DIR;
if (output) await mkdir(output, { recursive: true });
const probe = process.env.CIRCLE_EXTERNAL_ENTRY_PROBE === '1';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
  for (const width of [1280, 760]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() =>
      localStorage.setItem('circle.workbench.language', 'en'),
    );
    await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
    const draft = page.getByRole('textbox', { name: 'message', exact: true });
    await draft.fill('EXTERNAL_FILE_ENTRY_UNSENT_DRAFT');
    const originalDraft = await draft.elementHandle();
    await openNativeProjectFile(page, 'README.md');
    await page
      .locator('.file-view')
      .getByRole('button', { name: 'source code', exact: true })
      .click();
    const editor = page.locator('.file-view .native-code-editor');
    await editor.waitFor();
    const editorIdentity = await editor.elementHandle();
    const indexToggle = page.getByRole('button', {
      name: 'file index',
      exact: true,
    });
    if ((await indexToggle.getAttribute('aria-pressed')) !== 'true')
      await indexToggle.click();
    const entry = page
      .locator('.drawer-context-index .files-panel')
      .getByRole('button', {
        name: 'external files',
        exact: true,
        includeHidden: true,
      });
    await page.locator('.drawer-context-index .files-panel').waitFor();
    const count = await entry.count();
    const visible = count > 0 && (await entry.isVisible());
    const before = count
      ? await entry.evaluate((node) => ({
          parentClass: node.parentElement.className,
          parentDisplay: getComputedStyle(node.parentElement).display,
          rect: {
            width: node.getBoundingClientRect().width,
            height: node.getBoundingClientRect().height,
          },
        }))
      : {
          count: 0,
          headerDisplay: await page
            .locator(
              '.drawer-context-index .files-panel > .panel-header-actions',
            )
            .evaluate((node) => getComputedStyle(node).display),
        };
    if (probe) {
      receipts.push({ width, visible, ...before, expectedFailure: !visible });
      if (output)
        await page.screenshot({ path: join(output, `before-${width}.png`) });
    } else {
      assert.equal(
        visible,
        true,
        `external-file action is visible in the actual ${width}px App index`,
      );
      await entry.click();
      const dialog = page.getByRole('dialog', {
        name: 'external file access',
        exact: true,
      });
      await dialog.waitFor();
      assert.equal(
        await dialog
          .locator('.external-file-access')
          .getAttribute('data-session-id'),
        'session1',
      );
      assert.equal(
        await dialog.locator('.external-file-scope').isVisible(),
        true,
      );
      assert.match(
        await dialog.locator('.external-file-scope').textContent(),
        /current session only/,
      );
      await dialog
        .getByRole('button', { name: 'close dialog', exact: true })
        .click();
      assert.equal(
        await draft.inputValue(),
        'EXTERNAL_FILE_ENTRY_UNSENT_DRAFT',
      );
      assert.equal(
        await originalDraft.evaluate(
          (node) => node === document.querySelector('[aria-label="message"]'),
        ),
        true,
      );
      assert.equal(
        await page.locator('.file-view-filename strong').getAttribute('title'),
        'README.md',
      );
      assert.equal(
        await editorIdentity.evaluate(
          (node) =>
            node === document.querySelector('.file-view .native-code-editor'),
        ),
        true,
        'the actual editor DOM stays mounted across authorization dialog',
      );
      assert.equal(
        await page
          .locator('.drawer-context-index .files-panel > .panel-header-name')
          .isVisible(),
        false,
        'legacy floating filename stays hidden',
      );
      assert.equal(
        await page
          .locator('.drawer-context-index .files-panel > .panel-header-actions')
          .isVisible(),
        false,
        'legacy floating action bar stays hidden',
      );
      assert.deepEqual(errors, []);
      receipts.push({
        width,
        visible,
        ...before,
        scopedSession: 'session1',
        draftAndDocumentPreserved: true,
      });
      if (output)
        await page.screenshot({ path: join(output, `after-${width}.png`) });
    }
    await page.close();
  }
  if (output)
    await writeFile(
      join(output, probe ? 'before.json' : 'after.json'),
      JSON.stringify(receipts, null, 2),
    );
  console.log(JSON.stringify(receipts));
} finally {
  await browser?.close();
  await server.close();
}
