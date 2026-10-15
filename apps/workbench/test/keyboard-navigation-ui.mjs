import { runNativeKeyboardJourney } from '../../desktop/test/helpers/native-keyboard-journey.mjs';
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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.addInitScript(() =>
    localStorage.setItem('circle.workbench.language', 'en'),
  );
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
  page.setDefaultTimeout(8000);
  const checks = [];
  await runNativeKeyboardJourney({ page, checks });
  assert.equal(checks.length, 1);
  assert.equal(
    await page
      .getByRole('button', { name: 'developer layout', exact: true })
      .count(),
    0,
  );
  const transcript = page.locator('.transcript');
  const frame = () =>
    page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  await transcript.evaluate((node) =>
    node.scrollTo({
      top: Math.max(0, node.scrollHeight - node.clientHeight - 15),
      behavior: 'instant',
    }),
  );
  await frame();
  const geometry = () =>
    transcript.evaluate((node) => ({
      top: node.scrollTop,
      max: node.scrollHeight - node.clientHeight,
    }));
  const before = await geometry();
  assert.ok(before.max > 15);
  const files = page.getByRole('button', { name: 'files panel', exact: true });
  await files.click();
  await frame();
  await files.click();
  await frame();
  const after = await geometry();
  assert.ok(
    Math.abs(before.top - after.top) <= 2,
    'manual reading15px above end survives original Inspector resize ' +
      JSON.stringify({ before, after }),
  );
  await transcript.evaluate((node) =>
    node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }),
  );
  await frame();
  await page.setViewportSize({ width: 1000, height: 900 });
  await frame();
  await page.setViewportSize({ width: 1280, height: 900 });
  await frame();
  const following = await geometry();
  assert.ok(
    Math.abs(following.top - following.max) <= 2,
    'actual bottom follows viewport reflow ' + JSON.stringify(following),
  );
  assert.deepEqual(errors, []);
  console.log(
    'original-shell quick open, file/Inspector continuity, palette focus, draft/selection and exact reading scroll passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
