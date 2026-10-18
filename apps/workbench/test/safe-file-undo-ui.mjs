import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
const evidence = await mkdtemp(join(tmpdir(), 'circle-safe-file-undo-ui-'));
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage();
  const open = async (query = '') =>
    page.goto(
      `${server.resolvedUrls.local[0]}test/safe-file-undo-ui.html?${query}`,
    );
  const undo = () =>
    page.getByRole('button', { name: 'undo file changes', exact: true });
  const restore = () =>
    page.getByRole('button', { name: 'restore these files', exact: true });
  for (const theme of ['light', 'dark'])
    for (const language of ['en', 'zh-CN'])
      for (const width of [360, 1200]) {
        await page.setViewportSize({ width, height: 800 });
        await open(`theme=${theme}&language=${language}`);
        const zh = language === 'zh-CN';
        await page
          .getByRole('button', {
            name: zh ? '撤销文件改动' : 'undo file changes',
            exact: true,
          })
          .click();
        const confirm = page.getByRole('button', {
          name: zh ? '还原这些文件' : 'restore these files',
          exact: true,
        });
        await confirm.waitFor();
        assert.equal(await page.locator('.safe-file-undo li').count(), 2);
        assert.match(
          await page.locator('.safe-file-undo').innerText(),
          /src\/alpha.ts/,
        );
        assert.ok(
          (await page.evaluate(() => window.undoFixture.calls)).every(
            (call) => call.name === 'preview-file-undo',
          ),
          'preview alone cannot restore files',
        );
        assert.ok(
          Object.values(
            await page.evaluate(() => window.undoFixture.files),
          ).every((value) => value === 'after text-tool edit'),
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await page.screenshot({
          path: join(evidence, `${theme}-${language}-${width}.png`),
        });
        await confirm.click();
        await page
          .getByRole('status')
          .filter({ hasText: zh ? '文件改动已恢复' : 'file changes restored' })
          .waitFor();
        assert.equal(await page.locator('.safe-file-undo section').count(), 0);
        assert.equal(
          await page
            .getByRole('textbox', { name: 'working draft' })
            .inputValue(),
          'retain the working draft',
        );
        assert.ok(
          Object.values(
            await page.evaluate(() => window.undoFixture.files),
          ).every((value) => value === 'before text-tool edit'),
        );
        const calls = await page.evaluate(() => window.undoFixture.calls);
        assert.deepEqual(
          calls.map((call) => ({
            name: call.name,
            sessionId: call.sessionId,
            payload: call.payload,
          })),
          [
            {
              name: 'preview-file-undo',
              sessionId: 'undo-session',
              payload: { turnId: 'turn-1' },
            },
            {
              name: 'restore-turn-files',
              sessionId: 'undo-session',
              payload: { previewId: 'preview-token-1' },
            },
          ],
        );
        assert.equal(
          new Set(calls.map((call) => call.id)).size,
          2,
          'live bridge sends distinct command receipts',
        );
      }
  await open('failure');
  await undo().click();
  await restore().click();
  await page.getByRole('alert').waitFor();
  assert.match(
    await page.getByRole('alert').innerText(),
    /controlled restore failure/,
  );
  assert.equal(await page.locator('.safe-file-undo section').count(), 1);
  assert.equal(
    await page.getByRole('textbox', { name: 'working draft' }).inputValue(),
    'retain the working draft',
  );
  assert.equal(
    await page
      .getByRole('status')
      .filter({ hasText: 'file changes restored' })
      .count(),
    0,
  );
  assert.ok(
    Object.values(await page.evaluate(() => window.undoFixture.files)).every(
      (value) => value === 'after text-tool edit',
    ),
  );
  await restore().click();
  await page
    .getByRole('status')
    .filter({ hasText: 'file changes restored' })
    .waitFor();
  await open('unconfirmed');
  await undo().click();
  await restore().click();
  await page.getByRole('alert').waitFor();
  assert.match(
    await page.getByRole('alert').innerText(),
    /file restore was not confirmed/,
  );
  assert.equal(await page.locator('.safe-file-undo section').count(), 1);
  assert.equal(
    await page
      .getByRole('status')
      .filter({ hasText: 'file changes restored' })
      .count(),
    0,
  );
  await open('invalidPreview');
  await undo().click();
  await page.getByRole('alert').waitFor();
  assert.equal(await restore().count(), 0);
  await open('conflict');
  await undo().click();
  await restore().waitFor();
  assert.equal(await restore().isDisabled(), true);
  assert.match(
    await page.locator('.safe-file-undo').innerText(),
    /file changed externally/,
  );
  assert.equal((await page.evaluate(() => window.undoFixture.calls)).length, 1);
  await open('readonly');
  await undo().click();
  await restore().waitFor();
  assert.equal(await restore().isDisabled(), true);
  assert.equal(await page.getByRole('status').innerText(), 'read-only');
  assert.equal((await page.evaluate(() => window.undoFixture.calls)).length, 1);
  await open('disabled');
  assert.equal(await undo().isDisabled(), true);
  assert.equal((await page.evaluate(() => window.undoFixture.calls)).length, 0);
  await open('deferred');
  await undo().waitFor();
  await undo().evaluate((button) => {
    button.click();
    button.click();
  });
  await page.waitForFunction(() => window.undoFixture.calls.length === 1);
  assert.equal(await undo().isDisabled(), true);
  await page.evaluate(() => window.undoFixture.resolve());
  await restore().waitFor();
  await restore().evaluate((button) => {
    button.click();
    button.click();
  });
  await page.waitForFunction(() => window.undoFixture.calls.length === 2);
  assert.equal(await restore().isDisabled(), true);
  await page.evaluate(() => window.undoFixture.resolve());
  await page
    .getByRole('status')
    .filter({ hasText: 'file changes restored' })
    .waitFor();
  console.log(
    `safe file undo UI: eight theme/language/width combinations, explicit bridge receipts, retained failure, no unconfirmed success, conflict/read-only guards, duplicate exclusion passed; screenshots: ${evidence}`,
  );
} finally {
  await browser?.close();
  await server.close();
}
