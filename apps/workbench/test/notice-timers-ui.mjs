import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

// A notice goes at its own time. An older notice's timer, or a session error that clears,
// does not take a newer notice with the same words. The page's clock moves only when the
// test moves it, so each check comes at a known moment, not when a model turn happens to
// end (#207).
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
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.clock.install({ time: new Date('2026-10-20T00:00:00Z') });
  await page.goto(`${server.resolvedUrls.local[0]}test/notice-timers-ui.html`);
  const message = page.getByRole('textbox', { name: 'message', exact: true });
  await message.waitFor();
  await page.clock.pauseAt(new Date('2026-10-20T00:01:00Z'));
  const send = async (text) => {
    await message.fill(text);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
  };
  const until = async (check, what) => {
    const deadline = Date.now() + 8000;
    while (!(await check())) {
      assert(Date.now() < deadline, what);
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  const actionError = () =>
    page.evaluate(
      () => window.runtime.getSnapshot().sessions[0].actionError ?? null,
    );
  const notice = 'unknown command /unrecognized-fixture-command';
  // React applies a timer's change in a task of its own. Two message round trips give it
  // that task, so a notice still counted has not merely not gone yet.
  const shown = async () => {
    await page.evaluate(async () => {
      for (let i = 0; i < 2; i++)
        await new Promise((done) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => done(undefined);
          channel.port2.postMessage(undefined);
        });
    });
    return page.locator('.toast').filter({ hasText: notice }).count();
  };
  await send('/skill nonexistent-fixture-skill');
  await page.locator('.toast').filter({ hasText: 'skill not found' }).waitFor();
  assert.equal(await actionError(), 'skill not found');
  await send('/unrecognized-fixture-command');
  await page.locator('.toast').filter({ hasText: notice }).waitFor();
  await page.clock.runFor(1800);
  // The same words again: text alone cannot tell the newer notice from the older one.
  await send('/unrecognized-fixture-command');
  assert.equal(await shown(), 1);
  await send('continue while preserving an independent notice');
  await until(
    async () =>
      (await page.evaluate(() => window.calls)).some(
        (call) => call.name === 'prompt',
      ),
    'the message reaches the runtime',
  );
  await until(
    async () => (await actionError()) === null,
    'sending clears the session error',
  );
  assert.equal(
    await shown(),
    1,
    'clearing the session error leaves the newer notice',
  );
  // The older notice is due 4200 ms after it showed, the newer one 1800 ms after that.
  await page.clock.runFor(2500);
  assert.equal(
    await shown(),
    1,
    "the older notice's timer leaves the newer notice with the same words",
  );
  await page.clock.runFor(1800);
  assert.equal(await shown(), 0, 'the newer notice goes at its own time');
  // #302: a missed toast was the only trace of an answer, and an answer that
  // arrived after the window moved on was dropped whole. Now every answer
  // stays in the conversation that asked for it.
  const asked = () =>
    page.evaluate(
      () =>
        window.runtime
          .getSnapshot()
          .sessions.find((item) => item.id === 'notice-session')
          .messages.filter(
            (message) =>
              message.text === 'unknown command /unrecognized-fixture-command',
          ).length,
    );
  // The same words were asked twice; both answers stay, in the order they came.
  assert.equal(
    await asked(),
    2,
    'a missed toast leaves its answer in the conversation',
  );
  // The same asked in one conversation, answered after the window moved on:
  // the answer lands where it was asked, and does not interrupt the other.
  await send('/share');
  await until(
    async () => (await page.evaluate(() => window.shareCalls.length)) === 1,
    'the share request reaches the host',
  );
  await page.evaluate(() => window.setActive('notice-session-b'));
  await page.evaluate(() => window.releaseShare());
  await until(
    async () =>
      await page.evaluate(() =>
        window.runtime
          .getSnapshot()
          .sessions.find((item) => item.id === 'notice-session')
          .messages.some(
            (message) =>
              message.role === 'notice' &&
              message.text.startsWith('local share saved'),
          ),
      ),
    'the answer stays in the conversation that asked for it',
  );
  assert.equal(
    await page.locator('.toast').count(),
    0,
    'the other conversation is not interrupted by an answer it did not ask for',
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.runtime
          .getSnapshot()
          .sessions.find((item) => item.id === 'notice-session-b')
          .messages.filter((message) => message.role === 'notice').length,
    ),
    0,
    'the conversation on screen gains nothing',
  );
  await page.evaluate(() => window.setActive('notice-session'));
  assert.equal(
    await page.evaluate(
      () =>
        window.runtime
          .getSnapshot()
          .sessions.find((item) => item.id === 'notice-session')
          .messages.filter((message) =>
            message.text.startsWith('local share saved'),
          ).length,
    ),
    1,
    'back in the conversation that asked, the answer is there to read',
  );
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
console.log('notice timers: ok');
