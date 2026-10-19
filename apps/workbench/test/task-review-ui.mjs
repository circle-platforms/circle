import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// A finished task waits for you in its own conversation: every criterion ticked with what
// you saw before the review can be confirmed, or the attempt sent back with a reason.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-task-review-')));
await mkdir(output, { recursive: true });
const open = async (browser, theme, locale) => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(
    `${server.resolvedUrls.local[0]}test/task-review-ui.html?theme=${theme}&locale=${locale}`,
  );
  await page.locator('.task-review-card').waitFor();
  return { page, errors };
};
const decisions = (page) => page.evaluate(() => window.taskReviewFixture.calls);
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  {
    // Confirm: only when every criterion is ticked and has what was seen.
    const { page, errors } = await open(browser, 'light', 'en');
    const card = page.locator('.task-review-card');
    assert.match(await card.innerText(), /2 files changed/);
    assert.match(await card.innerText(), /attempt 1/);
    const confirm = card.getByRole('button', {
      name: 'confirm reviewed criteria',
    });
    assert.equal(await confirm.isDisabled(), true);
    const evidence = card.getByRole('textbox');
    const boxes = card.getByRole('checkbox');
    await boxes.nth(0).check();
    await evidence
      .nth(0)
      .fill('ran tests/reconnect.test.ts: the case at line 42 passes');
    assert.equal(
      await confirm.isDisabled(),
      true,
      'one criterion is not enough',
    );
    await boxes.nth(1).check();
    assert.equal(
      await confirm.isDisabled(),
      true,
      'a tick with nothing seen is not enough',
    );
    await evidence.nth(1).fill('the buffer length is 0 in the debugger');
    assert.equal(await confirm.isDisabled(), false);
    await page.screenshot({ path: `${output}/review-light-en.png` });
    await confirm.click();
    await card.waitFor({ state: 'detached' });
    const [one] = await decisions(page);
    assert.equal(one.method, 'review');
    assert.equal(one.params.id, 'task-1');
    assert.equal(one.params.expectedAttempt, 1);
    assert.equal(one.params.expectedPatchSha256, 'a'.repeat(64));
    assert.deepEqual(one.params.checks, [
      {
        criterion: 'the last frame is kept at the close boundary',
        evidence: 'ran tests/reconnect.test.ts: the case at line 42 passes',
      },
      {
        criterion: 'the buffer is empty after the reconnect',
        evidence: 'the buffer length is 0 in the debugger',
      },
    ]);
    assert.deepEqual(errors, []);
    await page.close();
  }
  {
    // Send back: needs a reason, and starts the next attempt; a changed task asks again.
    const { page, errors } = await open(browser, 'dark', 'en');
    const card = page.locator('.task-review-card');
    await card.getByRole('button', { name: 'send back' }).click();
    const reason = card.getByRole('textbox', {
      name: 'reason for sending it back',
    });
    const sendBack = card.getByRole('button', { name: 'confirm sending back' });
    assert.equal(await sendBack.isDisabled(), true, 'a reason is required');
    await reason.fill(
      'the buffer is not emptied; the case only covers the close',
    );
    await page.screenshot({ path: `${output}/reject-dark-en.png` });
    await card.getByRole('button', { name: 'cancel' }).click();
    assert.equal(
      await card
        .getByRole('textbox', { name: 'reason for sending it back' })
        .count(),
      0,
      'cancel leaves the card as it was',
    );
    await card.getByRole('button', { name: 'send back' }).click();
    await card
      .getByRole('textbox', { name: 'reason for sending it back' })
      .fill('the buffer is not emptied; the case only covers the close');
    await card.getByRole('button', { name: 'confirm sending back' }).click();
    await card.waitFor({ state: 'detached' });
    const [two] = await decisions(page);
    assert.equal(two.method, 'reject');
    assert.equal(two.params.id, 'task-1');
    assert.equal(two.params.expectedAttempt, 1);
    assert.equal(two.params.expectedPatchSha256, 'a'.repeat(64));
    assert.equal(
      two.params.reason,
      'the buffer is not emptied; the case only covers the close',
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  {
    // The task ran again while the card was open: a decision is refused for the old patch,
    // and the card is made again for the attempt that now waits.
    const { page, errors } = await open(browser, 'light', 'en');
    const card = page.locator('.task-review-card');
    await card.getByRole('button', { name: 'send back' }).click();
    await card
      .getByRole('textbox', { name: 'reason for sending it back' })
      .fill('not what was asked');
    await page.evaluate(() => window.taskReviewFixture.nextAttempt());
    await card.getByRole('button', { name: 'confirm sending back' }).click();
    await page.waitForFunction(() =>
      /attempt 2/.test(
        document.querySelector('.task-review-card')?.textContent ?? '',
      ),
    );
    assert.deepEqual(
      await decisions(page),
      [],
      'nothing was decided for the old patch',
    );
    assert.equal(
      await page
        .locator('.task-review-card')
        .getByRole('textbox', { name: 'reason for sending it back' })
        .count(),
      0,
      'the new attempt starts with a fresh card',
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  {
    // The parent's link to the task opens the task's own conversation, with its card; the
    // task's reviewer has no card, and a file opened there is read-only, as the runtime
    // keeps it.
    const { page, errors } = await open(browser, 'light', 'en');
    const parentId = await page.evaluate(() => window.taskReviewFixture.parent);
    await page.evaluate((id) => {
      location.hash = `/session/${id}`;
    }, parentId);
    await page.locator('.task-review-card').waitFor({ state: 'detached' });
    const group = page
      .locator('.tool-group')
      .filter({ hasText: 'scheduled agents' })
      .last();
    await group.locator('.tool-summary').click();
    await group
      .locator('.tool-agent-links')
      .getByRole('button', { name: /add a regression for the close boundary/ })
      .click();
    await page.waitForFunction(() =>
      location.hash.endsWith('/session/task-session'),
    );
    await page.locator('.task-review-card').waitFor();
    assert.equal(
      await page.getByRole('list', { name: 'subagents' }).count(),
      0,
      'the link does not open an empty subagents mode',
    );
    await page.evaluate(() => {
      location.hash = '/session/reviewer-session';
    });
    await page.locator('.task-review-card').waitFor({ state: 'detached' });
    await page.getByRole('textbox', { name: 'message' }).focus();
    await page.keyboard.press('ControlOrMeta+p');
    const search = page.getByRole('textbox', {
      name: 'global search',
      exact: true,
    });
    await search.fill('README.md');
    await search.press('Enter');
    const view = page.locator('.file-view');
    await view.waitFor();
    await view.getByText('read-only', { exact: true }).waitFor();
    assert.equal(
      await view
        .getByRole('button', { name: 'save', exact: true })
        .isDisabled(),
      true,
    );
    await page.screenshot({ path: `${output}/reviewer-source-light-en.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }
  {
    // The files link shows what the task changed, in the changes mode.
    const { page, errors } = await open(browser, 'light', 'zh-CN');
    const card = page.locator('.task-review-card');
    assert.match(await card.innerText(), /需核对/);
    assert.match(await card.innerText(), /第 1 次执行/);
    await card.getByRole('button', { name: '改了 2 个文件' }).click();
    await page.locator('.changes-mode').waitFor();
    await page.screenshot({ path: `${output}/review-light-zh-CN.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
console.log('task review: ok');
