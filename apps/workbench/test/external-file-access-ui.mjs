import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const output = process.env.CIRCLE_EXTERNAL_FILES_UI_EVIDENCE_DIR;
if (output) await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
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
  const open = async (query = '') => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 760 },
    });
    await page.goto(
      `${server.resolvedUrls.local[0]}test/external-file-access-ui.html?${query}`,
    );
    await page.locator('.external-file-access[aria-busy="false"]').waitFor();
    return page;
  };
  const page = await open();
  const read = page.getByRole('button', {
    name: 'choose read-only file',
    exact: true,
  });
  await page.evaluate(() => {
    window.externalFilesFixture.pickerMode = 'cancel';
  });
  await read.click();
  await page.getByText('file selection cancelled', { exact: true }).waitFor();
  assert.equal(await page.locator('.external-file-grant').count(), 0);
  await page.evaluate(() => {
    window.externalFilesFixture.pickerMode = 'error';
  });
  await read.click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'synthetic picker failure' })
    .waitFor();
  await page.evaluate(() => {
    window.externalFilesFixture.pickerMode = 'grant';
    window.externalFilesFixture.holdList = true;
  });
  await read.click();
  await page.waitForFunction(
    () => window.externalFilesFixture.grants.length === 1,
  );
  assert.equal(
    await page.locator('.external-file-grant').count(),
    0,
    'OS receipt alone is not a confirmed list',
  );
  assert.equal(
    await page.getByText('file access granted', { exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.externalFilesFixture.releaseLists());
  await page.locator('.external-file-grant').waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.externalFilesFixture.pickers.at(-1)),
    { sessionId: 'file-owner-a', access: 'read' },
  );
  assert.equal(
    await page.locator('.external-file-grant code').textContent(),
    '/synthetic/outside/项目 report exact-file.txt',
  );
  await page.evaluate(() => {
    window.externalFilesFixture.revokeMode = 'hold';
  });
  await page
    .getByRole('button', { name: 'revoke access', exact: true })
    .click();
  await page.waitForFunction(() =>
    window.externalFilesFixture.calls.some(
      (command) => command.name === 'revoke-external-file-grant',
    ),
  );
  assert.equal(
    await page.getByText('file access revoked', { exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.externalFilesFixture.resolveRevoke(false));
  await page.getByRole('alert').waitFor();
  assert.equal(
    await page.evaluate(() => window.externalFilesFixture.grants.length),
    1,
  );
  await page.getByRole('button', { name: 'refresh', exact: true }).click();
  await page.locator('.external-file-grant').waitFor();
  await page.evaluate(() => {
    window.externalFilesFixture.revokeMode = 'ok';
  });
  await page
    .getByRole('button', { name: 'revoke access', exact: true })
    .click();
  await page.getByText('file access revoked', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.externalFilesFixture.grants.length),
    0,
  );
  await page.evaluate(() => {
    window.externalFilesFixture.pickerMode = 'hold';
  });
  await read.click();
  await page.evaluate(() => {
    window.externalFilesFixture.switchSession('file-owner-b');
    window.externalFilesFixture.resolvePicker();
  });
  await page
    .locator(
      '.external-file-access[data-session-id="file-owner-b"][aria-busy="false"]',
    )
    .waitFor();
  await page.waitForFunction(
    () => window.externalFilesFixture.grants.length === 0,
  );
  assert.equal(await page.locator('.external-file-grant').count(), 0);
  const commands = await page.evaluate(() => window.externalFilesFixture.calls);
  assert.ok(
    commands.some(
      (command) =>
        command.name === 'revoke-external-file-grant' &&
        command.sessionId === 'file-owner-a',
    ),
  );
  assert.ok(
    commands.every((command) =>
      ['list-external-file-grants', 'revoke-external-file-grant'].includes(
        command.name,
      ),
    ),
    'no send/model execution or path-mint command',
  );
  assert.ok(
    commands.every((command) => !('path' in command.payload)),
    'renderer never supplies a path',
  );
  await page.evaluate(() => {
    window.externalFilesFixture.foreignList = true;
  });
  await page.getByRole('button', { name: 'refresh', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'file access receipt does not match this session' })
    .waitFor();
  assert.equal(await page.locator('.external-file-grant').count(), 0);
  await page.close();
  for (const flag of ['readonly', 'unavailable']) {
    const gated = await open(flag);
    assert.equal(
      await gated
        .getByRole('button', { name: 'choose read-only file', exact: true })
        .isDisabled(),
      true,
    );
    await gated.close();
  }
  for (const theme of ['light', 'dark'])
    for (const language of ['en', 'zh-CN'])
      for (const width of [1000, 760]) {
        const visual = await open(`theme=${theme}&language=${language}`);
        await visual.setViewportSize({ width, height: 760 });
        await visual.locator('.external-file-actions button').nth(1).click();
        await visual.locator('.external-file-grant').waitFor();
        assert.equal(
          await visual.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        assert.equal(
          await visual.locator('.external-file-grant').evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth;
          }),
          true,
        );
        assert.equal(
          await visual.locator('.external-file-grant small').textContent(),
          language === 'en'
            ? 'read and write · current session only'
            : '可读写 · 仅当前会话',
        );
        if (output)
          await visual.screenshot({
            path: join(output, `${theme}-${language}-${width}.png`),
          });
        await visual.close();
      }
  console.log(
    'external file access: cancellation, native error, confirmed grant/revoke, false receipt, stale session, foreign receipt, gating and 8 themed layout cases passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
