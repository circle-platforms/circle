import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-remote-bot-chat-ui-')));
await mkdir(output, { recursive: true });
let browser;
const receipts = [];

async function flushMicrotasks(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        queueMicrotask(() => queueMicrotask(resolve));
      }),
  );
}

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.setDefaultTimeout(5000);
      await page.clock.install({ time: 1_700_000_000_000 });
      await page.clock.pauseAt(1_700_000_000_000);
      const label = (en, zh) => (language === 'en' ? en : zh);
      const name = `${language}-${theme}`;

      await page.goto(
        `${server.resolvedUrls.local[0]}test/remote-bot-chat-ui.html?language=${language}&theme=${theme}`,
      );
      await page.locator('.empty-state [role="status"]').waitFor();
      await flushMicrotasks(page);

      const getCalls = () =>
        page.evaluate(() => window.remoteBotUiFixture.discoverCalls());
      assert.equal(await getCalls(), 1, 'initial discover attempt ran');

      // C16: exponential backoff 1s -> 2s -> 4s -> 8s -> 16s -> 30s -> 30s
      const expectedSteps = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
      let calls = 1;
      for (const waitMs of expectedSteps) {
        await page.clock.runFor(waitMs - 1);
        assert.equal(
          await getCalls(),
          calls,
          `did not poll before ${waitMs}ms`,
        );
        await page.clock.runFor(1);
        await flushMicrotasks(page);
        calls += 1;
        assert.equal(await getCalls(), calls, `polled at ${waitMs}ms`);
      }

      // Recover with 200 OK -> backoff resets back to 1000ms on next error.
      await page.evaluate(() =>
        window.remoteBotUiFixture.setFailure(undefined),
      );
      await page.clock.runFor(30_000);
      await page.locator('#remote-bot-input').waitFor();

      // C20: attaching a file, then cancelling picker keeps the file; IPC prefix is stripped.
      await page.evaluate(() =>
        window.remoteBotUiFixture.setAttachFiles([
          { name: 'report.pdf', sha256: 'a'.repeat(64), size: 128 },
        ]),
      );
      await page
        .getByRole('button', {
          name: label('attach files', '附加文件…'),
          exact: true,
        })
        .click();
      await page.getByText('report.pdf').waitFor();

      await page.evaluate(() => window.remoteBotUiFixture.setAttachCancel());
      await page
        .getByRole('button', {
          name: label('attach files', '附加文件…'),
          exact: true,
        })
        .click();
      assert.equal(
        await page.getByText('report.pdf').count(),
        1,
        'cancelling file picker preserves already-selected attachments',
      );

      await page.evaluate(() =>
        window.remoteBotUiFixture.setAttachError(
          "Error invoking remote method 'circle:attach-bot-files': Error: select up to eight files",
        ),
      );
      await page
        .getByRole('button', {
          name: label('attach files', '附加文件…'),
          exact: true,
        })
        .click();
      const attachError = await page
        .locator('.composer-area [role="status"]')
        .textContent();
      assert.ok(attachError);
      assert.doesNotMatch(attachError, /Error invoking remote method/);
      assert.match(
        attachError,
        /select up to eight files|最多只能选择 8 个文件/,
      );
      assert.equal(await page.getByText('report.pdf').count(), 1);

      // Next transient 502 error polls after 1000ms (backoff was reset on 200).
      await page.evaluate(() => {
        window.remoteBotUiFixture.resetDiscoverCalls();
        window.remoteBotUiFixture.setFailure({
          error: 'remote bot unavailable',
          errorStatus: 502,
        });
      });
      await page.clock.runFor(1000);
      await page.locator('.empty-state [role="status"]').waitFor();
      await flushMicrotasks(page);
      const countAfterFirstResetErr = await getCalls();
      await page.clock.runFor(999);
      assert.equal(await getCalls(), countAfterFirstResetErr);
      await page.clock.runFor(1);
      await flushMicrotasks(page);
      assert.equal(await getCalls(), countAfterFirstResetErr + 1);

      // C5 + C16: distinct non-retryable states pause auto-polling and provide Retry.
      const distinctStates = new Set();
      const transientState = (
        await page.locator('.empty-state').textContent()
      )?.trim();
      distinctStates.add(transientState);

      for (const failure of [
        {
          error: 'client too old',
          errorStatus: 426,
          errorCode: 'BOT_VERSION_MISMATCH',
        },
        {
          error: 'invalid client version',
          errorStatus: 400,
          errorCode: 'BOT_VERSION_INVALID',
        },
        {
          error: 'bot disabled',
          errorStatus: 403,
          errorCode: 'BOT_DISABLED',
        },
        {
          error: 'session expired',
          errorStatus: 401,
        },
        {
          error: 'oauth client token rejected',
          errorStatus: 403,
          errorCode: 'BOT_CLIENT_FORBIDDEN',
        },
      ]) {
        await page.evaluate((f) => {
          window.remoteBotUiFixture.resetDiscoverCalls();
          window.remoteBotUiFixture.setFailure(f);
        }, failure);
        const retryBtn = page.getByRole('button', {
          name: label('retry', '重试'),
          exact: true,
        });
        await retryBtn.click();
        await flushMicrotasks(page);
        assert.equal(await getCalls(), 1);
        await page.clock.runFor(60_000);
        assert.equal(
          await getCalls(),
          1,
          `auto-polling must stay paused for ${failure.errorCode ?? failure.errorStatus}`,
        );
        const body = (await page.locator('.empty-state').textContent())?.trim();
        assert.ok(body && body.length > 0);
        distinctStates.add(body);
      }

      assert.equal(
        distinctStates.size,
        6,
        `expected 6 distinct failure panels, got ${distinctStates.size}: ${[...distinctStates].join(' | ')}`,
      );
      await page.screenshot({ path: join(output, `${name}.png`) });
      assert.deepEqual(errors, []);
      receipts.push(name);
      await page.close();
    }
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify({ cases: receipts }, null, 2),
  );
  console.log(JSON.stringify({ cases: receipts.length, output }));
} finally {
  await browser?.close();
  await server.close();
}
