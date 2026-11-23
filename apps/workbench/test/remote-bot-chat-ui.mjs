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

      // Recover with 200 OK and R1 notice codes localized cleanly in en and zh-CN.
      await page.evaluate(() => {
        window.remoteBotUiFixture.setFailure(undefined);
        window.remoteBotUiFixture.setEvents([
          {
            id: 'ev-n1',
            at: '2026-11-23T00:00:00Z',
            role: 'notice',
            code: 'conversation_started',
            text: 'started a new conversation',
            cursor: 1,
          },
          {
            id: 'ev-n2',
            at: '2026-11-23T00:00:01Z',
            role: 'notice',
            code: 'attachment_integrity_failed',
            text: 'attachment integrity check failed',
            cursor: 2,
          },
        ]);
      });
      await page.clock.runFor(30_000);
      await page.locator('#remote-bot-input').waitFor();
      if (language === 'zh-CN') {
        await page.getByText('已开始新对话').waitFor();
        await page.getByText('附件完整性校验失败').waitFor();
      } else {
        await page.getByText('started a new conversation').waitFor();
        await page.getByText('attachment integrity check failed').waitFor();
      }

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
      if (language === 'zh-CN') {
        assert.match(attachError, /最多只能选择 8 个文件/);
      } else {
        assert.match(attachError, /select up to eight files/);
      }
      assert.equal(await page.getByText('report.pdf').count(), 1);

      // S12 & F19: partial mid-batch upload error localizes uploaded count, total, filename (including ": ") and inner reason.
      await page.evaluate(() =>
        window.remoteBotUiFixture.setAttachError(
          'Uploaded 2 of 5 files; failed on c.txt: fetch failed',
        ),
      );
      await page
        .getByRole('button', {
          name: label('attach files', '附加文件…'),
          exact: true,
        })
        .click();
      const partialAttachError = await page
        .locator('.composer-area [role="status"]')
        .textContent();
      assert.ok(partialAttachError);
      if (language === 'zh-CN') {
        assert.match(
          partialAttachError,
          /已上传 2\/5 个文件；c\.txt 上传失败：网络请求失败/,
        );
      } else {
        assert.match(
          partialAttachError,
          /Uploaded 2 of 5 files; failed on c\.txt: fetch failed/,
        );
      }

      await page.evaluate(() =>
        window.remoteBotUiFixture.setAttachError({
          message: 'Uploaded 1 of 3 files; failed on c: d.txt: fetch failed',
          errorUploaded: 1,
          errorTotal: 3,
          errorFileName: 'c: d.txt',
          errorReason: 'fetch failed',
        }),
      );
      await page
        .getByRole('button', {
          name: label('attach files', '附加文件…'),
          exact: true,
        })
        .click();
      const colonAttachError = await page
        .locator('.composer-area [role="status"]')
        .textContent();
      assert.ok(colonAttachError);
      if (language === 'zh-CN') {
        assert.equal(
          colonAttachError,
          '已上传 1/3 个文件；c: d.txt 上传失败：网络请求失败',
        );
      } else {
        assert.equal(
          colonAttachError,
          'Uploaded 1 of 3 files; failed on c: d.txt: fetch failed',
        );
      }

      // F18: 400 BOT_VERSION_MISMATCH, 422 BOT_INVALID_REQUEST (Chinese detail), F14/F16/F17 local/auth/403 split.
      for (const transientFailure of [
        {
          error: 'request timed out',
          errorStatus: 408,
          errorCode: 'BOT_REQUEST_TIMEOUT',
        },
        {
          error: 'bot busy',
          errorStatus: 429,
          errorCode: 'BOT_BUSY',
        },
        {
          error: 'internal error',
          errorStatus: 500,
        },
      ]) {
        await page.evaluate(() =>
          window.remoteBotUiFixture.setFailure(undefined),
        );
        await page.clock.runFor(30_000);
        await page.locator('#remote-bot-input').waitFor();
        await page.evaluate((f) => {
          window.remoteBotUiFixture.resetDiscoverCalls();
          window.remoteBotUiFixture.setFailure(f);
        }, transientFailure);
        await page.clock.runFor(1000);
        await page.locator('.empty-state [role="status"]').waitFor();
        await flushMicrotasks(page);
        const beforeBackoff = await getCalls();
        await page.clock.runFor(1000);
        await flushMicrotasks(page);
        assert.ok(
          (await getCalls()) > beforeBackoff,
          `${transientFailure.errorCode ?? transientFailure.errorStatus} must auto-retry`,
        );
      }

      // Next transient 502 error polls after 1000ms once backoff resets on 200.
      await page.evaluate(() =>
        window.remoteBotUiFixture.setFailure(undefined),
      );
      await page.clock.runFor(30_000);
      await page.locator('#remote-bot-input').waitFor();
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

      // C5 + R3 + S15: distinct non-retryable real Hub states pause auto-polling and provide Retry.
      const distinctStates = new Set();
      const transientState = (
        await page.locator('.empty-state').textContent()
      )?.trim();
      distinctStates.add(transientState);

      for (const failure of [
        {
          error: 'client too old',
          errorStatus: 400,
          errorCode: 'BOT_VERSION_MISMATCH',
        },
        {
          error: 'invalid client version',
          errorStatus: 400,
          errorCode: 'BOT_VERSION_INVALID',
        },
        {
          error: 'bot disabled',
          errorStatus: 503,
          errorCode: 'BOT_DISABLED',
        },
        {
          error: 'token expired',
          errorStatus: 401,
          errorCode: 'BOT_UNAUTHENTICATED',
        },
        {
          error: 'oauth client token rejected',
          errorStatus: 403,
          errorCode: 'BOT_CLIENT_FORBIDDEN',
        },
        {
          error: '参数无效：机器人附件完整性校验未通过。请重新上传附件后再试。',
          errorStatus: 422,
          errorCode: 'BOT_INVALID_REQUEST',
        },
        {
          error: 'MCP sign-in is required',
        },
        {
          error: 'remote bot requires https or loopback http',
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
          `auto-polling must stay paused for ${failure.errorCode ?? failure.errorStatus ?? failure.error}`,
        );
        const body = (await page.locator('.empty-state').textContent())?.trim();
        assert.ok(body && body.length > 0);
        if (failure.errorCode === 'BOT_CLIENT_FORBIDDEN') {
          assert.match(body, /\/tmp\/circle-ui\/runtime-home\/settings\.json/);
          assert.match(body, /Bearer <(token|令牌)>/);
          if (language === 'zh-CN') {
            assert.match(
              body,
              /请先在 \/tmp\/circle-ui\/runtime-home\/settings\.json 的 Hub 配置 headers\.Authorization/,
            );
          }
        }
        if (
          failure.errorCode === 'BOT_UNAUTHENTICATED' &&
          language === 'zh-CN'
        ) {
          assert.match(body, /机器人登录已过期/);
          assert.match(body, /请在 设置 -> 扩展 中重新登录 Hub 后再重试/);
        }
        if (failure.errorCode === 'BOT_DISABLED' && language === 'zh-CN') {
          assert.match(body, /我的机器人已停用/);
        }
        if (
          failure.errorStatus === 422 &&
          failure.errorCode === 'BOT_INVALID_REQUEST' &&
          language === 'zh-CN'
        ) {
          assert.match(body, /附件完整性校验失败/);
        }
        distinctStates.add(body);
      }

      // F16: 401 with hasAuthorizationHeader shows direct Bearer token update action instead of Settings -> Extensions.
      await page.evaluate(() => {
        window.remoteBotUiFixture.setHubConfig({
          hasAuthorizationHeader: true,
          settingsPath: '/tmp/circle-ui/runtime-home/settings.json',
        });
        window.remoteBotUiFixture.resetDiscoverCalls();
        window.remoteBotUiFixture.setFailure({
          error: 'token expired',
          errorStatus: 401,
          errorCode: 'BOT_UNAUTHENTICATED',
        });
      });
      await flushMicrotasks(page);
      const authFixed = page.locator('[data-bot-error-kind="auth"]');
      await authFixed.waitFor();
      const authFixedText = (await authFixed.textContent()) ?? '';
      assert.match(
        authFixedText,
        /\/tmp\/circle-ui\/runtime-home\/settings\.json/,
      );
      assert.doesNotMatch(authFixedText, /Settings -> Extensions|设置 -> 扩展/);
      await page.evaluate(() =>
        window.remoteBotUiFixture.setHubConfig({
          hasAuthorizationHeader: false,
          settingsPath: '/tmp/circle-ui/runtime-home/settings.json',
        }),
      );

      // 401 with BOT_CLIENT_FORBIDDEN must still classify as auth (expired login), not oauth-forbidden.
      await page.evaluate(() => {
        window.remoteBotUiFixture.resetDiscoverCalls();
        window.remoteBotUiFixture.setFailure({
          error: 'token expired',
          errorStatus: 401,
          errorCode: 'BOT_CLIENT_FORBIDDEN',
        });
      });
      await page
        .getByRole('button', { name: label('retry', '重试'), exact: true })
        .click();
      await flushMicrotasks(page);
      await page.locator('[data-bot-error-kind="auth"]').waitFor();

      assert.equal(
        distinctStates.size,
        9,
        `expected 9 distinct failure panels, got ${distinctStates.size}: ${[...distinctStates].join(' | ')}`,
      );

      // R3 & T1: disconnected Hub state shows structured error panel in en and zh-CN + retry reloads Hub and recovers.
      await page.evaluate(() => {
        window.remoteBotUiFixture.resetReloadCalls();
        window.remoteBotUiFixture.setFailure(undefined);
        window.remoteBotUiFixture.setHubStatus('not connected', 'ECONNREFUSED');
      });
      const disconnectedPanel = page.locator(
        '[data-bot-error-kind="disconnected"]',
      );
      await disconnectedPanel.waitFor();
      const disconnectedTitle =
        (await disconnectedPanel.locator('h2').textContent()) ?? '';
      const disconnectedCause =
        (await disconnectedPanel.locator('[role="status"]').textContent()) ??
        '';
      const disconnectedText = (await disconnectedPanel.textContent()) ?? '';
      assert.match(disconnectedText, /ECONNREFUSED/);
      if (language === 'zh-CN') {
        assert.equal(disconnectedTitle, '机器人连接中断');
        assert.equal(disconnectedCause, '当前未连接到 Hub。');
        assert.match(
          disconnectedText,
          /请在 设置 -> 扩展 中检查 Hub 连接状态，或点击重试重新连接。/,
        );
      } else {
        assert.equal(disconnectedTitle, 'remote bot disconnected');
        assert.equal(disconnectedCause, 'Hub is not connected right now.');
        assert.match(
          disconnectedText,
          /Check your Hub connection in Settings -> Extensions, or retry reconnecting\./,
        );
      }
      await disconnectedPanel
        .getByRole('button', { name: label('retry', '重试'), exact: true })
        .click();
      await flushMicrotasks(page);
      assert.equal(
        await page.evaluate(() => window.remoteBotUiFixture.reloadCalls()),
        1,
      );
      await page.evaluate(() =>
        window.remoteBotUiFixture.setHubStatus('connected'),
      );
      await page.locator('#remote-bot-input').waitFor();
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
