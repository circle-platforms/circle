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
  const page = await browser.newPage();
  await page.goto(
    `${server.resolvedUrls.local[0]}test/conversation-requests-ui.html`,
  );
  const allow = page.getByRole('button', { name: 'allow once', exact: true });
  await allow.waitFor();
  assert.equal(
    await page.locator('.tool-summary .spin').count(),
    0,
    'waiting tools do not imply execution',
  );
  assert.equal(
    await page.locator('.tool-summary [aria-label="waiting for you"]').count(),
    1,
  );
  const before = await page.evaluate(() => window.fixture.snapshot());
  await page.getByRole('button', { name: 'open file', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.fixture.opened), [
    'src/example.ts',
  ]);
  assert.equal(
    await page.evaluate(() => window.fixture.snapshot()),
    before,
    'source navigation cannot change runtime history',
  );
  await allow.click();
  assert.equal(await allow.isDisabled(), true);
  assert.equal(
    await page.evaluate(() => window.fixture.settled()),
    0,
    'pending transport is not a settled request',
  );
  await page.evaluate(() => window.fixture.reject());
  await page.getByRole('alert').waitFor();
  assert.match(
    await page.getByRole('alert').innerText(),
    /controlled answer failure/,
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'draft' }).inputValue(),
    'keep this draft',
  );
  assert.equal(await page.evaluate(() => window.fixture.settled()), 0);
  await allow.click();
  await page.evaluate(() => window.fixture.resolve());
  await allow.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.fixture.settled()), 1);
  assert.deepEqual(await page.evaluate(() => window.fixture.calls), [
    ['approval-local', 4, 'allow once'],
    ['approval-local', 4, 'allow once'],
  ]);
  assert.equal(
    await page.evaluate(() => window.fixture.snapshot()),
    before,
    'fixture answer delivery must not rewrite transcript',
  );
  await page.goto(
    `${server.resolvedUrls.local[0]}test/conversation-requests-ui.html?theme=dark`,
  );
  await page.getByRole('button', { name: 'allow once', exact: true }).waitFor();
  assert.equal(
    await page
      .locator('.inline-request')
      .evaluate(
        (el) => getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)',
      ),
    true,
  );
  await page.goto(
    `${server.resolvedUrls.local[0]}test/conversation-requests-ui.html?kind=question`,
  );
  await page.getByRole('checkbox', { name: 'small patch' }).check();
  await page
    .getByRole('textbox', { name: 'your answer' })
    .fill('preserve local edits');
  const send = page.getByRole('button', { name: 'send answer', exact: true });
  await send.click();
  await page.evaluate(() => window.fixture.reject());
  await page.getByRole('alert').waitFor();
  assert.equal(
    await page.getByRole('checkbox', { name: 'small patch' }).isChecked(),
    true,
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'your answer' }).inputValue(),
    'preserve local edits',
  );
  await send.click();
  await page.evaluate(() => window.fixture.resolve());
  await send.waitFor({ state: 'detached' });
  const questionCalls = await page.evaluate(() => window.fixture.calls);
  assert.deepEqual(JSON.parse(questionCalls[1][2]), {
    choices: ['small patch'],
    comment: 'preserve local edits',
  });
  await page.goto(
    `${server.resolvedUrls.local[0]}test/conversation-requests-ui.html`,
  );
  await page.getByRole('button', { name: 'allow once', exact: true }).click();
  await page.evaluate(() => {
    window.fixture.switchAway();
    window.fixture.resolve();
  });
  assert.equal(
    await page.evaluate(() => window.fixture.settled()),
    0,
    'late answers cannot take focus from another session',
  );
  // A project hooks file waiting for approval: each changed hook with its whole
  // command, the unchanged ones by name, and the answer is the card's own choice.
  await page.goto(
    `${server.resolvedUrls.local[0]}test/conversation-requests-ui.html?kind=hooks`,
  );
  const approve = page.getByRole('button', {
    name: 'approve these hooks',
    exact: true,
  });
  await approve.waitFor();
  const card = page.locator('.inline-request[data-kind="hooks"]');
  assert.match(await card.innerText(), /project hooks need approval/);
  assert.match(await card.innerText(), /\/work\/app\/\.circle\/hooks\.json/);
  assert.equal(
    await card.locator('.hook-changes li[data-mark="changed"] pre').innerText(),
    'npm run lint',
  );
  assert.equal(
    await card.locator('.hook-changes li[data-mark="new"] pre').innerText(),
    'node .circle/guard.mjs',
  );
  assert.match(
    await card.locator('.hook-changes li[data-mark="unchanged"]').innerText(),
    /unchanged hook · fmt/,
  );
  assert.equal(await card.getByText('prettier --write .').count(), 0);
  await page.getByRole('button', { name: 'skip', exact: true }).click();
  await page.evaluate(() => window.fixture.resolve());
  await approve.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.fixture.calls), [
    ['hooks-local', 2, 'skip'],
  ]);
  await page.goto(
    `${server.resolvedUrls.local[0]}test/conversation-requests-ui.html?kind=hooks`,
  );
  await page
    .getByRole('button', { name: 'approve these hooks', exact: true })
    .click();
  await page.evaluate(() => window.fixture.resolve());
  assert.deepEqual(await page.evaluate(() => window.fixture.calls), [
    ['hooks-local', 2, 'approve'],
  ]);
  console.log(
    'conversation requests: pending transport, local failure, explicit retry, source navigation, retained draft and the hooks card passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
