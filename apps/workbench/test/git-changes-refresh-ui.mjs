import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

// A list of Git's changes reads the project again after each tool call of a turn and as
// the turn ends, not on a short timer: a large project's status and diffs are not read
// every second while a turn runs. The page's clock moves only when the test moves it.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
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
  const page = await browser.newPage({ viewport: { width: 400, height: 200 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.clock.install({ time: new Date('2026-10-21T00:00:00Z') });
  await page.goto(
    `${server.resolvedUrls.local[0]}test/git-changes-refresh-ui.html`,
  );
  await page.locator('#list').waitFor();
  await page.clock.pauseAt(new Date('2026-10-21T00:00:01Z'));
  const reads = () => page.evaluate(() => window.reads());
  const set = (state) => page.evaluate((next) => window.setList(next), state);
  // React runs an effect in a task of its own: two message round trips give it that task
  const settle = () =>
    page.evaluate(async () => {
      for (let i = 0; i < 2; i++)
        await new Promise((done) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => done(undefined);
          channel.port2.postMessage(undefined);
        });
    });
  await settle();
  assert.equal(await reads(), 1, 'the list reads Git once as it opens');
  // A turn runs for 20 seconds and no tool call ends: nothing is read on a timer
  await set({ busy: true, settled: 0 });
  await settle();
  await page.clock.runFor(20_000);
  await settle();
  assert.equal(await reads(), 1, 'no read while nothing ended');
  // A tool call ends: one read a moment later, and only one
  await set({ busy: true, settled: 1 });
  await settle();
  await page.clock.runFor(1_000);
  await settle();
  assert.equal(await reads(), 2, 'one read after a tool call ended');
  await page.clock.runFor(5_000);
  await settle();
  assert.equal(await reads(), 2, 'and no more until the next one');
  // The turn ends: one more
  await set({ busy: false, settled: 1 });
  await settle();
  await page.clock.runFor(1_000);
  await settle();
  assert.equal(await reads(), 3, 'one read as the turn ends');
  assert.deepEqual(errors, []);
  console.log('git changes refresh: ok');
} finally {
  await browser?.close();
  await server.close();
}
