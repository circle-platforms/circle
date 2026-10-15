import { runNativeKeyboardJourney } from '../../desktop/test/helpers/native-keyboard-journey.mjs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.addInitScript(() =>
    localStorage.setItem('circle.workbench.language', 'en'),
  );
  page.on('pageerror', (error) => console.error(String(error)));
  await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
  page.setDefaultTimeout(8000);

  await page
    .getByRole('button', { name: 'developer layout', exact: true })
    .click();
  const message = page.getByRole('textbox', { name: 'message', exact: true });
  await message.fill('keyboard developer draft');
  await message.evaluate((node) => node.setSelectionRange(3, 10));
  await message.focus();
  await page.keyboard.press('Control+p');
  const search = page.getByRole('textbox', {
    name: 'global search',
    exact: true,
  });
  await search.waitFor();
  await search.press('ArrowDown');
  assert.equal(
    await page.locator('.search-results button.selected strong').textContent(),
    'tests/reconnect.test.ts',
  );
  await search.press('ArrowUp');
  assert.equal(
    await page.locator('.search-results button.selected strong').textContent(),
    'src/connection.ts',
  );
  await search.fill('README.md');
  await search.press('Enter');
  await page
    .locator('.file-view')
    .getByText('README.md', { exact: false })
    .first()
    .waitFor();
  await message.focus();
  await message.evaluate((node) => node.setSelectionRange(3, 10));
  await page.keyboard.press('Control+Shift+p');
  await search.waitFor();
  const firstCommand = await page
    .locator('.search-results button.selected strong')
    .textContent();
  await search.press('ArrowDown');
  await search.press('ArrowUp');
  assert.equal(
    await page.locator('.search-results button.selected strong').textContent(),
    firstCommand,
  );
  await search.press('Escape');
  await search.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    () =>
      document.activeElement ===
      document.querySelector('textarea[aria-label="message"]'),
  );
  assert.equal(
    await message.evaluate((node) => document.activeElement === node),
    true,
    'Escape should restore original input focus',
  );
  assert.deepEqual(
    await message.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [3, 10],
  );
  await page.getByRole('button', { name: 'task layout', exact: true }).click();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const transcript = page.locator('.transcript');
  await transcript.evaluate((node) => (node.scrollTop = 120));
  const scrollBefore = await transcript.evaluate((node) => node.scrollTop);
  assert.ok(scrollBefore > 0);
  await page
    .getByRole('button', { name: 'developer layout', exact: true })
    .click();
  await page.getByRole('button', { name: 'task layout', exact: true }).click();
  assert.equal(await message.inputValue(), 'keyboard developer draft');
  assert.deepEqual(
    await message.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [3, 10],
  );
  assert.ok(
    Math.abs(
      (await transcript.evaluate((node) => node.scrollTop)) - scrollBefore,
    ) <= 2,
    'layout preserves transcript reading position',
  );
  await page
    .getByRole('button', { name: 'developer layout', exact: true })
    .click();
  const nativeHelperChecks = [];
  await runNativeKeyboardJourney({ page, checks: nativeHelperChecks });
  assert.equal(nativeHelperChecks.length, 1);
  console.log(
    'quick-open keyboard, palette Escape focus, layout draft/selection passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
