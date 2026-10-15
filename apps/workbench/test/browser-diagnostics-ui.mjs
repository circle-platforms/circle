import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const output = process.env.CIRCLE_BROWSER_UI_EVIDENCE;
if (output) await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
});
const checks = [];
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  const setup = async () => {
    await page.goto(
      server.resolvedUrls.local[0] + 'test/browser-diagnostics-ui.html',
    );
    await page
      .getByRole('button', { name: 'page diagnostics', exact: true })
      .click();
    await page.getByRole('tab', { name: 'page debugger', exact: true }).click();
    await page
      .locator('.browser-diagnostic-results details summary')
      .first()
      .click();
  };
  for (const scenario of [
    'step refreshes selected locals across merged pauses',
    'old asynchronous scope reply cannot restore an obsolete pause',
  ]) {
    try {
      await setup();
      if (scenario.startsWith('step')) {
        await page.getByRole('button', { name: 'local', exact: true }).click();
        await page.getByText('count: 1', { exact: true }).waitFor();
        await page
          .getByRole('button', { name: 'step over', exact: true })
          .click();
        await page
          .getByText('count: 2', { exact: true })
          .waitFor({ timeout: 1500 });
      } else {
        await page.evaluate(() => window.__browserFixture.defer());
        await page.getByRole('button', { name: 'local', exact: true }).click();
        await page.evaluate(() => window.__browserFixture.next());
        await page
          .getByText('fixture-2 http://localhost/fixture.js:2', { exact: true })
          .waitFor();
        await page.evaluate(() => window.__browserFixture.release());
        await page
          .getByText('count: 2', { exact: true })
          .waitFor({ timeout: 1500 });
        await page.waitForTimeout(80);
        assert.equal(
          await page
            .getByText('fixture-1 http://localhost/fixture.js:1', {
              exact: true,
            })
            .count(),
          0,
        );
      }
      checks.push({ scenario, status: 'passed' });
    } catch (error) {
      checks.push({
        scenario,
        status: 'failed',
        error: String(error),
        actual: await page.locator('.browser-diagnostics').innerText(),
      });
      if (output)
        await page.screenshot({
          path: join(output, 'failure-' + checks.length + '.png'),
        });
    }
  }
  if (output)
    await writeFile(
      join(output, 'receipt.json'),
      JSON.stringify(
        {
          kind: 'actual headless React BrowserDiagnostics interactions',
          checks,
        },
        null,
        2,
      ),
    );
  assert(
    checks.every((check) => check.status === 'passed'),
    JSON.stringify(checks),
  );
  console.log(
    'PASS real React browser debugger pause and stale variable reply scenarios',
  );
} finally {
  await browser?.close();
  await server.close();
}
