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
  const page = await browser.newPage();
  await page.goto(
    `${server.resolvedUrls.local[0]}test/pending-operations-ui.html`,
  );
  const button = page.getByRole('button', {
    name: 'record review without replay',
  });
  await button.waitFor();
  assert.equal(await button.isDisabled(), true);
  assert.equal(
    (await page.locator('body').innerText()).includes('HIDDEN_'),
    false,
  );
  const note = page.getByRole('textbox');
  await note.fill('Inspected remote branch and terminal; push completed once.');
  await button.click();
  await page.getByRole('alert').waitFor();
  assert.equal(
    await note.inputValue(),
    'Inspected remote branch and terminal; push completed once.',
  );
  await button.click();
  await page
    .getByText('no operations awaiting review', { exact: true })
    .waitFor();
  const calls = await page.evaluate(() => window.calls);
  assert.deepEqual(
    calls
      .filter((c) => c.payload.method === 'review')
      .map((c) => c.payload.params),
    [
      {
        id: 'op1',
        note: 'Inspected remote branch and terminal; push completed once.',
      },
      {
        id: 'op1',
        note: 'Inspected remote branch and terminal; push completed once.',
      },
    ],
  );
  assert.ok(calls.every((c) => ['list', 'review'].includes(c.payload.method)));
  console.log(
    'pending operation UI: explicit evidence, failed review retention, safe metadata and no replay passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
