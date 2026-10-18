import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/native-tools-drawer-ui.html?theme=${theme}`,
    );
    const draft = page.getByRole('textbox', { name: 'resource draft' });
    await draft.fill('persistent tab draft');
    const original = await draft.elementHandle();
    await page.getByRole('tab', { name: 'debug', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'program path' })
      .fill('/synthetic/app.cjs');
    await page.getByRole('tab', { name: 'debug', exact: true }).press('Home');
    assert.equal(await draft.inputValue(), 'persistent tab draft');
    assert.equal(await original.evaluate((node) => node.isConnected), true);
    await page.getByRole('tab', { name: 'activity', exact: true }).press('End');
    assert.equal(
      await page.getByRole('textbox', { name: 'program path' }).inputValue(),
      '/synthetic/app.cjs',
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.nativeDrawerFixture.calls.filter(
            (call) => call.payload.method === 'snapshot',
          ).length,
      ),
      1,
      'tab navigation must not recreate the debug service view',
    );
    const geometry = await page
      .locator('.workspace-resource-tabs')
      .evaluate((tabs) => ({
        top: tabs.getBoundingClientRect().top,
        header: tabs
          .closest('aside')
          .querySelector('header')
          .getBoundingClientRect().bottom,
      }));
    assert.ok(geometry.top >= geometry.header, JSON.stringify(geometry));
    assert.equal(
      await page
        .locator('[data-inspector-panel="browser"] .inspector-title-name')
        .evaluate((node) => getComputedStyle(node).visibility),
      'visible',
      'native resource tabs do not hide the drawer heading',
    );
    await page.waitForFunction(() =>
      window.nativeDrawerFixture.bounds.some((call) => call[2] === true),
    );
    await page.evaluate(() => {
      window.nativeDrawerFixture.hidden.length = 0;
    });
    await page
      .getByRole('button', { name: 'toggle resource', exact: true })
      .click();
    await page.waitForFunction(
      () => window.nativeDrawerFixture.hidden.length > 0,
    );
    assert.ok(
      await page.evaluate(() =>
        window.nativeDrawerFixture.keys.some(
          (call) => call[1] === 'keys' && call[2] === false,
        ),
      ),
      'hidden native view releases keyboard ownership',
    );
    const count = await page.evaluate(
      () => window.nativeDrawerFixture.bounds.length,
    );
    await page
      .getByRole('button', { name: 'toggle resource', exact: true })
      .click();
    await page.waitForFunction(
      (before) =>
        window.nativeDrawerFixture.bounds.length > before &&
        window.nativeDrawerFixture.bounds.at(-1)[2] === true,
      count,
    );
    assert.equal(
      await page
        .getByRole('button', { name: 'fixture tab', exact: true })
        .count(),
      1,
      'the same tab survives drawer hide/show',
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'native drawer: local keyboard tabs retain draft/debug identity; browser hide/show releases native bounds and keys in dark/light themes',
  );
} finally {
  await browser?.close();
  await server.close();
}
