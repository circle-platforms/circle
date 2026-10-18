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
    const toggle = drawer.getByRole('button', {
      name: 'file index',
      exact: true,
    });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    const filter = drawer.getByRole('textbox', {
      name: 'filter files',
      exact: true,
    });
    await filter.fill('deep/nested/source.ts');
    await tree
      .getByRole('treeitem', { name: 'deep/nested/source.ts', exact: true })
      .click();
    await drawer
      .locator('.file-view')
      .getByText('source.ts', { exact: true })
      .first()
      .waitFor();
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
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
    const handle = drawer.getByRole('separator', {
      name: 'resize context index',
      exact: true,
    });
    await drawer
      .getByRole('button', { name: 'full view', exact: true })
      .click();
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
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
    await page.evaluate(() => {
      location.hash = '/session/large-tree-session-b';
    });
    await drawer
      .getByRole('button', { name: 'file index', exact: true })
      .waitFor();
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    await handle.waitFor();
    assert.notEqual(
      Number(await handle.getAttribute('aria-valuenow')),
      pointerWidth,
      'other session owns a distinct index preference',
    );
    await page.evaluate(() => {
      location.hash = '/session/large-tree-session-a';
    });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
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
    if ((await filesMode.getAttribute('aria-pressed')) !== 'true')
      await filesMode.click();
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    await filter.fill('deep/nested/source.ts');
    await tree
      .getByRole('treeitem', { name: 'deep/nested/source.ts', exact: true })
      .click();
    const full = drawer.getByRole('button', { name: 'full view', exact: true });
    if (await full.isVisible()) await full.click();
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
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    await drawer
      .locator('.file-view')
      .getByText('source.ts', { exact: true })
      .first()
      .waitFor();
    await drawer.locator('.drawer-context-index').waitFor();
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
