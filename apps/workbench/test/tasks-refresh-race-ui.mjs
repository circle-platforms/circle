import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
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
    channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL,
  });
  for (const language of ['en', 'zh-CN']) {
    const page = await browser.newPage();
    await page.goto(
      `${server.resolvedUrls.local[0]}test/tasks-panel-ui.html?language=${language}&embedded=1`,
    );
    await page.locator('#task-task-0[data-state=running]').waitFor();
    await page.evaluate(() => window.taskRace.hold());
    const refresh = page.locator('.task-panel-toolbar').getByRole('button', {
      name: language === 'en' ? 'refresh' : '刷新',
      exact: true,
    });
    await refresh.click();
    await page.waitForFunction(() => window.taskRace.count() === 1);
    await refresh.click();
    await page.waitForFunction(() => window.taskRace.count() === 2);
    await page.evaluate(() => window.taskRace.release(1, 'succeeded'));
    await page.locator('#task-task-0[data-state=succeeded]').waitFor();
    await page.evaluate(() => window.taskRace.release(0, 'waiting'));
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    assert.equal(
      await page.locator('#task-task-0').getAttribute('data-state'),
      'succeeded',
      'late pending-approval list must not overwrite newer terminal result',
    );
    await refresh.click();
    await page.waitForFunction(() => window.taskRace.count() === 3);
    await page.evaluate(() => window.taskRace.switchSession('other-session'));
    await page.waitForFunction(() => window.taskRace.count() === 4);
    await page.evaluate(() => window.taskRace.release(3, 'cancelled'));
    await page.locator('#task-task-0[data-state=cancelled]').waitFor();
    await page.evaluate(() => window.taskRace.release(2, 'running'));
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      await page.locator('#task-task-0').getAttribute('data-state'),
      'cancelled',
      'old-session response cannot populate the newly selected session',
    );
    await page.close();
  }
  console.log('Two actual React deferred refresh races passed');
} finally {
  await browser?.close();
  await server.close();
}
