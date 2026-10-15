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
    `${server.resolvedUrls.local[0]}test/recovered-input-ui.html`,
  );
  const copy = page.getByRole('button', {
    name: 'return input to draft',
    exact: true,
  });
  await copy.waitFor();
  assert.equal(
    (await page.evaluate(() => window.calls)).filter(
      (c) => c.payload.method === 'resolve',
    ).length,
    0,
  );
  await copy.click();
  await page
    .getByText(
      'copied to draft without sending; recovery copy retained until you explicitly remove it',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'restored draft' }).inputValue(),
    'existing draft\n\n' +
      Array.from({ length: 600 }, (_, i) => `preserved line ${i}`).join('\n'),
  );
  assert.equal(
    await page.getByRole('status', { name: 'restored media' }).textContent(),
    'data:image/png;base64,AAEC',
  );
  const discard = page.getByRole('button', {
    name: 'discard recovered input',
    exact: true,
  });
  assert.equal(await discard.isDisabled(), true);
  await page.getByRole('checkbox').check();
  await discard.click();
  await page
    .getByText('recovery copy explicitly removed', { exact: true })
    .waitFor();
  const actions = (await page.evaluate(() => window.calls))
    .filter((c) => c.payload.method === 'resolve')
    .map((c) => c.payload.params.action);
  assert.deepEqual(actions, ['returnToDraft', 'discard']);
  const failurePage = await browser.newPage();
  await failurePage.goto(
    `${server.resolvedUrls.local[0]}test/recovered-input-ui.html?storageFailure=1`,
  );
  await failurePage
    .getByRole('button', { name: 'return input to draft', exact: true })
    .click();
  await failurePage
    .getByRole('alert')
    .filter({ hasText: 'draft is available only in memory' })
    .waitFor();
  assert.equal(
    await failurePage
      .getByText(
        'copied to draft without sending; recovery copy retained until you explicitly remove it',
        { exact: true },
      )
      .count(),
    0,
  );
  const fullDraft =
    'existing draft\n\n' +
    Array.from({ length: 600 }, (_, i) => `preserved line ${i}`).join('\n');
  assert.equal(
    await failurePage
      .getByRole('textbox', { name: 'restored draft' })
      .inputValue(),
    fullDraft,
  );
  assert.equal(
    await failurePage
      .getByRole('button', { name: 'copied in memory; not saved', exact: true })
      .isDisabled(),
    true,
  );
  await failurePage.evaluate(() => window.allowRecoveryStorage());
  await failurePage
    .getByRole('button', { name: 'retry saving recovered draft', exact: true })
    .click();
  await failurePage
    .getByText(
      'draft saved; recovery copy retained until you explicitly remove it',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await failurePage
      .getByRole('textbox', { name: 'restored draft' })
      .inputValue(),
    fullDraft,
  );
  await failurePage.reload();
  await failurePage.getByRole('textbox', { name: 'restored draft' }).waitFor();
  assert.equal(
    await failurePage
      .getByRole('textbox', { name: 'restored draft' })
      .inputValue(),
    fullDraft,
  );
  assert.equal(
    await failurePage
      .getByRole('status', { name: 'restored media' })
      .textContent(),
    'data:image/png;base64,AAEC',
  );
  console.log(
    'recovered input UI: no automatic replay, complete 600-line draft/media and explicit copy removal passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
