import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
let browser;
const output = await mkdtemp(join(tmpdir(), 'circle-large-tree-ui-'));
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 950 },
    });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/large-file-tree-ui.html?theme=${theme}#/session/large-tree-session-a`,
    );
    await page
      .getByRole('button', { name: 'files panel', exact: true })
      .click();
    const drawer = page.locator('.work-drawer');
    const tree = drawer.getByRole('tree', { name: 'files', exact: true });
    await tree.waitFor();
    // With no file open the tree is the whole drawer.
    assert.equal(await drawer.locator('.drawer-document.list-only').count(), 1);
    await tree.getByRole('treeitem', { name: 'bulk', exact: true }).click();
    await tree.press('End');
    await tree.press('ArrowUp');
    await tree
      .getByRole('treeitem', { name: 'bulk/item-10999.ts', exact: true })
      .waitFor();
    assert.ok(
      (await tree.getByRole('treeitem').count()) < 80,
      '11,000 expanded files use bounded row DOM',
    );
    await tree.press('Enter');
    await drawer
      .locator('.file-view')
      .getByText('item-10999.ts', { exact: true })
      .first()
      .waitFor();
    // There is no index toggle: a file opens with the tree beside it while the drawer
    // has the room for both, and the drawer widens to 760 pixels for a file. The tree
    // belongs to the conversation that opened the file.
    const indexBeside = (owner) =>
      page.waitForFunction((owner) => {
        const box = (selector) => {
          const node = document.querySelector(selector);
          return node?.getClientRects().length
            ? node.getBoundingClientRect()
            : null;
        };
        const content = box(
          '.drawer-document.has-file .drawer-document-content',
        );
        const index = box(
          `.drawer-document.has-file .drawer-context-index[data-context-index-owner="${owner}"]`,
        );
        return (
          !!content &&
          !!index &&
          content.width > 0 &&
          index.width > 0 &&
          index.left >= content.right - 1
        );
      }, owner);
    await indexBeside('large-tree-session-a');
    const filter = drawer.getByRole('textbox', {
      name: 'filter files',
      exact: true,
    });
    const openThroughFilter = async (path) => {
      await filter.fill(path);
      await tree.getByRole('treeitem', { name: path, exact: true }).click();
      await drawer
        .locator('.file-view')
        .getByText(path.split('/').at(-1), { exact: true })
        .first()
        .waitFor();
    };
    await openThroughFilter('deep/nested/source.ts');
    await indexBeside('large-tree-session-a');
    await filter.fill('');
    const selected = tree.getByRole('treeitem', {
      name: 'deep/nested/source.ts',
      exact: true,
    });
    await selected.waitFor();
    assert.equal(await selected.getAttribute('aria-selected'), 'true');
    await tree.focus();
    await tree.press('ArrowLeft');
    assert.equal(
      await tree.locator('.tree-focused').getAttribute('data-path'),
      'deep/nested',
    );
    // The index beside the open file is resized here, in the split: the drawer's own
    // edge is beside it, and the index's separator must move the index alone.
    const handle = drawer.getByRole('separator', {
      name: 'resize context index',
      exact: true,
    });
    await handle.waitFor();
    await handle.press('Home');
    const min = Number(await handle.getAttribute('aria-valuenow'));
    await handle.press('ArrowLeft');
    const expanded = Number(await handle.getAttribute('aria-valuenow'));
    assert.equal(expanded, min + 16);
    const drawerWidth = await drawer.evaluate(
      (el) => el.getBoundingClientRect().width,
    );
    const bounds = await handle.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 40);
    await page.mouse.down();
    await page.mouse.move(bounds.x - 80, bounds.y + 40, { steps: 4 });
    await page.mouse.up();
    const pointerWidth = Number(await handle.getAttribute('aria-valuenow'));
    assert.ok(pointerWidth > expanded);
    assert.equal(
      await drawer.evaluate((el) => el.getBoundingClientRect().width),
      drawerWidth,
      'index drag cannot resize work drawer',
    );
    // Another conversation closes the file, and the tree is the whole drawer again, that
    // conversation's own. The separator is there only beside a file: open one there too.
    await page.evaluate(() => {
      location.hash = '/session/large-tree-session-b';
    });
    await drawer
      .locator(
        '.drawer-document.list-only [data-context-index-owner="large-tree-session-b"]',
      )
      .waitFor();
    await openThroughFilter('deep/nested/source.ts');
    await indexBeside('large-tree-session-b');
    await handle.waitFor();
    assert.notEqual(
      Number(await handle.getAttribute('aria-valuenow')),
      pointerWidth,
      'other session owns a distinct index preference',
    );
    await page.evaluate(() => {
      location.hash = '/session/large-tree-session-a';
    });
    await drawer
      .locator(
        '.drawer-document.list-only [data-context-index-owner="large-tree-session-a"]',
      )
      .waitFor();
    await openThroughFilter('deep/nested/source.ts');
    await indexBeside('large-tree-session-a');
    await page.waitForFunction(
      (width) =>
        Number(
          document
            .querySelector(
              '[data-context-index-owner="large-tree-session-a"] [role=separator]',
            )
            ?.getAttribute('aria-valuenow'),
        ) === width,
      pointerWidth,
    );
    assert.equal(
      await page
        .getByRole('textbox', { name: 'message', exact: true })
        .inputValue(),
      'large tree retained draft',
    );
    const filesMode = page.getByRole('button', {
      name: 'files panel',
      exact: true,
    });
    assert.equal(await filesMode.getAttribute('aria-pressed'), 'true');
    await page.setViewportSize({ width: 800, height: 950 });
    await page.waitForFunction(
      () =>
        matchMedia('(max-width:1050px)').matches &&
        document
          .querySelector('[aria-label="files panel"]')
          ?.getAttribute('aria-pressed') === 'false',
    );
    await filesMode.click();
    await page.waitForFunction(
      () =>
        document.getElementById('workbench-columns')?.dataset.inspectorMode ===
        'overlay',
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await drawer
      .locator('.file-view')
      .getByText('source.ts', { exact: true })
      .first()
      .waitFor();
    // At 800 pixels the sidebar stays and the drawer lies over the conversation beside
    // it, too narrow for the file and the tree: the file has the drawer to itself.
    await page.waitForFunction(() => {
      const drawer = document.querySelector('.work-drawer');
      const content = document.querySelector(
        '.drawer-document.has-file .drawer-document-content',
      );
      const index = document.querySelector(
        '.drawer-document.has-file .drawer-context-index',
      );
      if (!drawer || !content || !index) return false;
      const width = drawer.getBoundingClientRect().width;
      return (
        width < 620 &&
        index.hidden &&
        Math.abs(content.getBoundingClientRect().width - width) <= 1
      );
    });
    // The tree comes back when the file closes, filtered to the deep path as it was left.
    await drawer
      .getByRole('button', { name: 'close file', exact: true })
      .click();
    // A narrow window also closes the drawer with the file; the files button opens it.
    await page
      .locator('.drawer-document.list-only')
      .waitFor({ state: 'attached' });
    if ((await filesMode.getAttribute('aria-pressed')) !== 'true')
      await filesMode.click();
    await page.waitForFunction(
      () =>
        document.getElementById('workbench-columns')?.dataset.inspectorMode ===
        'overlay',
    );
    await drawer
      .locator('.drawer-document.list-only .drawer-context-index')
      .waitFor();
    assert.equal(await filter.inputValue(), 'deep/nested/source.ts');
    await tree
      .getByRole('treeitem', { name: 'deep/nested/source.ts', exact: true })
      .waitFor();
    await page.screenshot({
      path: join(output, `deep-index-${theme}-narrow.png`),
    });
    assert.ok((await tree.getByRole('treeitem').count()) < 80);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    `large tree/index integration passed: 11,001 resources, bounded DOM, actual selection/navigation/filter, pointer/keyboard width and session preference; screenshots ${output}`,
  );
} finally {
  await browser?.close();
  await server.close();
}
