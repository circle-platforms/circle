import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { openNativeProjectFile } from '../../desktop/test/helpers/native-project-file.mjs';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
let browser;
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
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill('INDEX_HELPER_UNSENT');
    for (const path of [
      'README.md',
      'src/connection.ts',
      'tests/reconnect.test.ts',
      'README.md',
    ]) {
      await openNativeProjectFile(page, path);
      await page
        .locator('.file-view-filename strong')
        .filter({ hasText: path.split('/').at(-1) })
        .waitFor();
      assert.equal(
        await page.locator('.file-view-filename strong').getAttribute('title'),
        path,
      );
      // There is no index to reopen: the drawer widens for a file in the split at 1280,
      // and the narrow window lays it over the conversation at 760, and in both the tree
      // stays beside the open document, where the helper finds the next file.
      await page.waitForFunction(
        (mode) => {
          const box = (selector) => {
            const node = document.querySelector(selector);
            return node?.getClientRects().length
              ? node.getBoundingClientRect()
              : null;
          };
          const content = box(
            '.drawer-document.has-file .drawer-document-content',
          );
          const index = box('.drawer-document.has-file .drawer-context-index');
          return (
            document.getElementById('workbench-columns')?.dataset
              .inspectorMode === mode &&
            !!content &&
            !!index &&
            content.width > 0 &&
            index.width > 0 &&
            index.left >= content.right - 1
          );
        },
        width > 1050 ? 'split' : 'overlay',
      );
      await page
        .locator('.file-view')
        .getByRole('button', {
          name: path.endsWith('.md') ? 'source code' : 'edit',
          exact: true,
        })
        .click();
      await page.locator('.file-view .native-code-editor').waitFor();
      assert.equal(
        await page
          .getByRole('textbox', { name: 'message', exact: true })
          .inputValue(),
        'INDEX_HELPER_UNSENT',
      );
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'Shared native project-index helper actual App renderer: root/nested paths, source/edit labels, the index beside the open file in the split and the narrow overlay, composer preservation passed (native package not executed)',
  );
} finally {
  await browser?.close();
  await server.close();
}
