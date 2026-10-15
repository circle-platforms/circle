import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const server = await createServer({
  root,
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
    `${server.resolvedUrls.local[0]}test/resource-boundary-ui.html`,
  );
  const conversation = page.getByRole('textbox', {
    name: 'conversation draft',
    exact: true,
  });
  const editor = page.getByRole('textbox', {
    name: 'editor buffer',
    exact: true,
  });
  await conversation.fill('developer keeps this draft');
  await editor.fill('developer keeps this unsaved source');
  await page
    .getByRole('button', { name: 'fail resource', exact: true })
    .click();
  await page.getByRole('alert', { name: 'terminal unavailable' }).waitFor();
  assert.equal(await conversation.inputValue(), 'developer keeps this draft');
  assert.equal(
    await editor.inputValue(),
    'developer keeps this unsaved source',
  );
  await conversation.fill('still writable after sibling crash');
  await editor.fill('still editable after sibling crash');
  assert.equal(
    await page.getByRole('textbox', { name: 'terminal search' }).count(),
    0,
  );
  assert.equal(
    await page.getByRole('button', { name: 'retry this view' }).count(),
    1,
  );
  assert.equal(
    await page.getByRole('button', { name: 'copy diagnostic' }).count(),
    1,
  );
  assert.equal(
    await page.locator('.native-resource-error details').getAttribute('open'),
    null,
  );
  await page
    .getByRole('button', { name: 'repair source', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'retry this view', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'terminal search' }).waitFor();
  assert.equal(
    await conversation.inputValue(),
    'still writable after sibling crash',
  );
  assert.equal(await editor.inputValue(), 'still editable after sibling crash');
  console.log(
    'PASS real React render failure isolated to one resource; sibling edits survive and explicit retry recovers',
  );
} finally {
  await browser?.close();
  await server.close();
}
