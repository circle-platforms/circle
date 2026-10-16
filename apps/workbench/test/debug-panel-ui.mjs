import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { port: 0, host: '127.0.0.1' },
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${server.resolvedUrls.local[0]}test/debug-panel-ui.html`);
  const pending = (method, session) =>
    page.evaluate(
      ({ method, session }) =>
        window.debugFixture
          .pending()
          .find((p) => p.payload.method === method && p.sessionId === session),
      { method, session },
    );
  const waitPending = async (method, session) => {
    await page.waitForFunction(
      ({ method, session }) =>
        window.debugFixture
          .pending()
          .some((p) => p.payload.method === method && p.sessionId === session),
      { method, session },
    );
    return pending(method, session);
  };
  const setSession = (session) =>
    page.evaluate((s) => window.debugFixture.session(s), session);
  const hold = (method) =>
    page.evaluate((m) => window.debugFixture.hold(m), method);
  const resolve = (id, data) =>
    page.evaluate(({ id, data }) => window.debugFixture.resolve(id, data), {
      id,
      data,
    });
  const stackA = await waitPending('stackTrace', 'A');
  await hold('');
  await setSession('B');
  await page.getByRole('button', { name: /frame-B/ }).waitFor();
  await resolve(stackA.id, {
    stackFrames: [
      {
        id: 101,
        name: 'STALE_A_FRAME',
        source: { path: '/fixture/A.cjs' },
        line: 1,
      },
    ],
  });
  await page.waitForTimeout(50);
  assert.equal(
    await page.getByRole('button', { name: /STALE_A_FRAME/ }).count(),
    0,
    'slow A stack must not replace B frames',
  );
  await setSession('A');
  await page.getByRole('button', { name: /frame-A/ }).waitFor();
  await hold('scopes');
  await page.getByRole('button', { name: /frame-A/ }).click();
  const scopeA = await waitPending('scopes', 'A');
  await hold('');
  await setSession('B');
  await page.getByRole('button', { name: /frame-B/ }).waitFor();
  await resolve(scopeA.id, {
    scopes: [{ name: 'STALE_A_SCOPE', variablesReference: 101 }],
  });
  await page.waitForTimeout(50);
  assert.equal(
    await page.getByRole('button', { name: 'STALE_A_SCOPE' }).count(),
    0,
    'slow A scopes cannot appear in B',
  );
  await setSession('A');
  await page.getByRole('button', { name: /frame-A/ }).waitFor();
  await hold('variables');
  await page.getByRole('button', { name: /frame-A/ }).click();
  const varsA = await waitPending('variables', 'A');
  await hold('');
  await setSession('B');
  await page.getByRole('button', { name: /frame-B/ }).waitFor();
  await resolve(varsA.id, {
    variables: [
      { name: 'STALE_A_VARIABLE', value: 'old', variablesReference: 0 },
    ],
  });
  await page.waitForTimeout(50);
  assert.equal(
    await page.getByRole('button', { name: 'STALE_A_VARIABLE' }).count(),
    0,
    'slow A variables cannot appear in B',
  );
  await hold('evaluate');
  await page.getByLabel('debug expression', { exact: true }).fill('value');
  await page.getByRole('button', { name: 'evaluate', exact: true }).click();
  const evaluation = await waitPending('evaluate', 'B');
  await page.evaluate(() => window.debugFixture.pause('B', 3));
  await page.getByRole('button', { name: /frame-B.*:3/ }).waitFor();
  await resolve(evaluation.id, { result: 'STALE_PAUSE_RESULT' });
  await page.waitForTimeout(50);
  assert.equal(
    await page.locator('form output').innerText(),
    '',
    'an old paused-frame evaluation must not survive the next pause',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real React deferred stack/scopes/variables/evaluation requests stay with their session and pause',
  );
} finally {
  await browser?.close();
  await server.close();
}
