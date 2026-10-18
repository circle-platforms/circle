import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
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
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width: 760, height: 720 },
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/virtual-file-tree-ui.html?theme=${theme}`,
    );
    const tree = page.getByRole('tree', { name: 'files', exact: true });
    const filter = page.getByRole('textbox', {
      name: 'filter files',
      exact: true,
    });
    await page
      .getByRole('treeitem', { name: 'group099/file499.ts', exact: true })
      .waitFor();
    assert.ok((await tree.getByRole('treeitem').count()) < 50);
    await filter.fill('file');
    await page.waitForFunction(
      () =>
        Number.parseFloat(
          document.querySelector('.virtual-file-tree-space')?.style.height ??
            '',
        ) === 1503000,
    );
    assert.ok(
      (await tree.getByRole('treeitem').count()) < 50,
      '50k expanded files have bounded DOM',
    );
    await tree.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    assert.equal(
      await page.getByLabel('open calls').textContent(),
      '[]',
      'arrows only focus',
    );
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(
      await page.getByLabel('selected path').textContent(),
      'group099/file499.ts',
    );
    assert.equal(
      await page.getByLabel('open calls').textContent(),
      '["group099/file499.ts"]',
    );
    await filter.fill('group050/file123.ts');
    await page
      .getByRole('treeitem', { name: 'group050/file123.ts', exact: true })
      .click();
    assert.equal(
      await page.getByLabel('selected path').textContent(),
      'group050/file123.ts',
    );
    assert.equal(await tree.getByRole('treeitem').count(), 2);
    await filter.fill('');
    await page
      .getByRole('button', { name: 'reveal early file', exact: true })
      .click();
    await page
      .getByRole('treeitem', { name: 'group000/file003.ts', exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel('retained draft').inputValue(),
      'my draft',
    );
    await tree.focus();
    await page.keyboard.press('ArrowLeft');
    const active = await tree.getAttribute('aria-activedescendant');
    assert.equal(
      await page.locator(`[id="${active}"]`).getAttribute('data-path'),
      'group000',
    );
    await page.keyboard.press('ArrowLeft');
    assert.equal(
      await page
        .getByRole('treeitem', { name: 'group000', exact: true })
        .getAttribute('aria-expanded'),
      'false',
    );
    assert.ok((await tree.getByRole('treeitem').count()) < 50);
    await filter.fill('group050/file123.ts');
    await page
      .getByRole('button', { name: 'switch tree owner', exact: true })
      .click();
    assert.equal(
      await filter.inputValue(),
      '',
      'new owner has independent filter',
    );
    await page
      .getByRole('button', { name: 'switch tree owner', exact: true })
      .click();
    assert.equal(
      await filter.inputValue(),
      'group050/file123.ts',
      'returning owner restores filter',
    );
    await filter.fill('unmatched-file');
    await page
      .getByRole('button', { name: 'loading listing', exact: true })
      .click();
    await page.getByText('loading file list…', { exact: true }).waitFor();
    assert.equal(
      await page.getByText('no matching files', { exact: true }).count(),
      0,
      'incomplete search does not assert no match',
    );
    await page
      .getByRole('button', { name: 'partial listing', exact: true })
      .click();
    await page.getByText('file list is incomplete', { exact: true }).waitFor();
    await page.getByText('2000 files loaded', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'FilesPanel: 50k synthetic paths, bounded DOM, filter/selection/reveal/folder keyboard and light/dark passed; native indexing not inferred',
  );
} finally {
  await browser?.close();
  await server.close();
}
