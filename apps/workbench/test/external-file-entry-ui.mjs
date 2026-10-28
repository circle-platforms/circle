import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openNativeProjectFile } from '../../desktop/test/helpers/native-project-file.mjs';

// Access to one file outside the folder is a setting of the current conversation, under
// settings → file access, and no entry of the file index: the index offers its tree and
// its filter. This opens a file beside the tree, finds no such entry there, reaches the
// dialog from settings, and checks that the open document, the editor and the unsent draft
// all stay as they were through both dialogs.
const output = process.env.CIRCLE_EXTERNAL_ENTRY_EVIDENCE_DIR;
if (output) await mkdir(output, { recursive: true });
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
    // The drawer has no index toggle: an open file has the tree beside it whenever the
    // drawer has the room for both. The drawer widens to 760 pixels for a file (the
    // sidebar folds at 1280), and the narrow window lays it over the conversation at its
    // full width, so at both widths the document and the tree share it.
    await page.waitForFunction(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        return node?.getClientRects().length
          ? node.getBoundingClientRect()
          : null;
      };
      const content = box('.drawer-document.has-file .drawer-document-content');
      const index = box('.drawer-document.has-file .drawer-context-index');
      return (
        !!content &&
        !!index &&
        content.width > 0 &&
        index.width > 0 &&
        index.left >= content.right - 1
      );
    });
    // The index offers its tree and its filter, and nothing about files outside the folder.
    const index = page.locator('.drawer-context-index .files-panel');
    await index.waitFor();
    assert.equal(
      await index
        .getByRole('button', {
          name: 'external files',
          exact: true,
          includeHidden: true,
        })
        .count(),
      0,
      `the ${width}px file index has no external-file entry`,
    );
    assert.equal(
      await index
        .locator(
          '.panel-header-name, .panel-header-actions, .file-index-footer',
        )
        .count(),
      0,
      'no legacy heading, search trigger or footer',
    );

    // Settings are a window address away at any width; the dialog opens over the window.
    await page.evaluate(() => {
      location.hash = '/page/files';
    });
    const settings = page.locator('.settings-dialog');
    await settings.waitFor();
    await page.waitForFunction(() =>
      document.activeElement?.closest('.settings-dialog'),
    );
    await settings
      .getByRole('button', { name: 'manage external file access', exact: true })
      .click();
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
    await dialog.waitFor({ state: 'detached' });
    // Settings stay open under it, and close with esc, back to the window as it was.
    assert.equal(await settings.count(), 1);
    await page.waitForFunction(() =>
      document.activeElement?.closest('.settings-dialog'),
    );
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });
    await page.waitForFunction(() => location.hash === '#/session/session1');
    assert.equal(await draft.inputValue(), 'EXTERNAL_FILE_ENTRY_UNSENT_DRAFT');
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
      'the actual editor DOM stays mounted across settings and the authorization dialog',
    );
    assert.deepEqual(errors, []);
    receipts.push({
      width,
      entryInIndex: false,
      reachedFromSettings: true,
      scopedSession: 'session1',
      draftAndDocumentPreserved: true,
    });
    if (output)
      await page.screenshot({ path: join(output, `after-${width}.png`) });
    await page.close();
  }
  if (output)
    await writeFile(
      join(output, 'after.json'),
      JSON.stringify(receipts, null, 2),
    );
  console.log(JSON.stringify(receipts));
} finally {
  await browser?.close();
  await server.close();
}
