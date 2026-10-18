import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
    ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
    : {}),
});
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      server.resolvedUrls.local[0] +
        'test/context-index-resize-ui.html?theme=' +
        theme,
    );
    const index = page.locator('.resizable-context-index'),
      separator = index.getByRole('separator');
    await separator.waitFor();
    const marker = await page.locator('[data-document-marker]').elementHandle(),
      draft = page.getByRole('textbox', { name: 'document draft' }),
      filter = page.getByRole('textbox', { name: 'index filter' });
    await draft.fill('same live draft');
    await filter.fill('same local filter');
    const initial = Number(await separator.getAttribute('aria-valuenow'));
    const outer = await page.locator('.resize-fixture').boundingBox();
    const grip = await separator.boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 70);
    await page.mouse.down();
    await page.mouse.move(grip.x - 70, grip.y + 70);
    await page.mouse.up();
    const dragged = Number(await separator.getAttribute('aria-valuenow'));
    assert.ok(dragged >= initial + 60);
    assert.deepEqual(
      await page.locator('.resize-fixture').boundingBox(),
      outer,
      'index drag cannot resize its outer drawer',
    );
    await separator.focus();
    await separator.press('ArrowRight');
    assert.equal(
      Number(await separator.getAttribute('aria-valuenow')),
      dragged - 16,
    );
    const ownerA = dragged - 16;
    assert.equal(
      await separator.evaluate((node) => node === document.activeElement),
      true,
    );
    await page.getByRole('button', { name: 'owner b', exact: true }).click();
    assert.equal(
      Number(await separator.getAttribute('aria-valuenow')),
      initial,
    );
    await separator.press('Home');
    assert.equal(
      await separator.getAttribute('aria-valuenow'),
      await separator.getAttribute('aria-valuemin'),
    );
    await separator.press('End');
    assert.equal(
      await separator.getAttribute('aria-valuenow'),
      await separator.getAttribute('aria-valuemax'),
    );
    await page.getByRole('button', { name: 'owner a', exact: true }).click();
    assert.equal(Number(await separator.getAttribute('aria-valuenow')), ownerA);
    await page
      .getByRole('button', { name: 'switch resource', exact: true })
      .click();
    assert.equal(
      Number(await separator.getAttribute('aria-valuenow')),
      initial,
      'Git does not inherit the files index width',
    );
    await separator.press('Home');
    await page
      .getByRole('button', { name: 'switch resource', exact: true })
      .click();
    assert.equal(
      Number(await separator.getAttribute('aria-valuenow')),
      ownerA,
      'files retains its own width',
    );
    {
      const rect = await separator.boundingBox();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + 70);
      await page.mouse.down();
      await page.mouse.move(rect.x - 30, rect.y + 70);
      await page
        .getByRole('button', { name: 'owner b', exact: true })
        .evaluate((button) => button.click());
      await page.waitForFunction(() => document.body.style.userSelect === '');
      await page.mouse.up();
      await page.getByRole('button', { name: 'owner a', exact: true }).click();
      assert.equal(
        Number(await separator.getAttribute('aria-valuenow')),
        ownerA,
        'changing owner during a drag discards the transient width',
      );
    }
    for (const cancel of ['pointercancel', 'lostpointercapture']) {
      const before = Number(await separator.getAttribute('aria-valuenow')),
        rect = await separator.boundingBox();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + 70);
      await page.mouse.down();
      await page.mouse.move(rect.x - 30, rect.y + 70);
      if (cancel === 'pointercancel')
        await separator.dispatchEvent('pointercancel', {
          pointerId: 1,
          isPrimary: true,
        });
      else {
        await separator.evaluate((node) => node.releasePointerCapture(1));
        // Capture changes are delivered with the next pointer dispatch.
        await page.mouse.move(rect.x - 31, rect.y + 70);
      }
      await page.waitForFunction(() => document.body.style.userSelect === '');
      await page.mouse.up();
      assert.equal(
        Number(await separator.getAttribute('aria-valuenow')),
        before,
        cancel + ' restores starting preference',
      );
      assert.equal(
        await page.evaluate(() => document.body.style.userSelect),
        '',
      );
      assert.equal(await page.evaluate(() => document.body.style.cursor), '');
    }
    await page
      .getByRole('button', { name: 'toggle index', exact: true })
      .click();
    assert.equal(await index.isVisible(), false);
    await page
      .getByRole('button', { name: 'toggle index', exact: true })
      .click();
    assert.equal(Number(await separator.getAttribute('aria-valuenow')), ownerA);
    await page.setViewportSize({ width: 500, height: 800 });
    await page.waitForFunction(() =>
      document
        .querySelector('.resizable-context-index')
        ?.hasAttribute('data-index-overlay'),
    );
    await page.evaluate(() => (document.documentElement.style.zoom = '2'));
    await page.waitForFunction(() => {
      const node = document.querySelector('.resizable-context-index');
      const bounds = node.getBoundingClientRect();
      return bounds.left >= -1 && bounds.right <= innerWidth + 1;
    });
    const bounds = await index.boundingBox();
    assert.ok(
      bounds.x >= -1 && bounds.x + bounds.width <= 501,
      JSON.stringify(bounds),
    );
    assert.equal(await marker.evaluate((node) => node.isConnected), true);
    assert.equal(await draft.inputValue(), 'same live draft');
    assert.equal(await filter.inputValue(), 'same local filter');
    assert.deepEqual(errors, []);
    await page.evaluate(() => (document.documentElement.style.zoom = '1'));
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.reload();
    await separator.waitFor();
    assert.equal(
      Number(await separator.getAttribute('aria-valuenow')),
      ownerA,
      'preference survives a window reload',
    );
    await page.close();
  }
  console.log(
    'PASS context index real pointer/keyboard/cancel/owner/focus/light-dark/narrow200% retained document',
  );
} finally {
  await browser.close();
  await server.close();
}
