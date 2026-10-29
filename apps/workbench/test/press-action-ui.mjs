import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// The new-session buttons act on press. A press whose click never comes, here
// because the pointer is released elsewhere, must not swallow the next
// activation by keyboard or pointer.
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
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0] + 'test/press-action-ui.html');
  const button = page.getByRole('button', { name: 'new session', exact: true });
  const count = () => page.locator('output').getAttribute('data-count');

  await button.click();
  assert.equal(await count(), '1', 'a press and its click act once');

  await button.hover();
  await page.mouse.down();
  assert.equal(await count(), '2', 'the press acts at once');
  await page.locator('.elsewhere').hover();
  await page.mouse.up();
  assert.equal(await count(), '2', 'a release elsewhere adds nothing');

  await button.focus();
  await page.keyboard.press('Enter');
  assert.equal(await count(), '3', 'the next keyboard activation acts');

  await button.click();
  assert.equal(await count(), '4', 'the next pointer click acts once');
} finally {
  await browser?.close();
  await server.close();
}
