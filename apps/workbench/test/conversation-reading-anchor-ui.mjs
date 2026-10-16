import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const output = process.env.CIRCLE_READING_ANCHOR_EVIDENCE;
if (output) await mkdir(output, { recursive: true });
let browser, page;
const frames = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.addInitScript(() => {
    window.readingScrollEvents = [];
    document.addEventListener(
      'scroll',
      (event) => {
        const node = event.target;
        if (
          !(node instanceof HTMLElement) ||
          !node.classList.contains('transcript')
        )
          return;
        const bounds = node.getBoundingClientRect();
        const anchor = [...node.querySelectorAll('[data-message-id]')].find(
          (row) => row.getBoundingClientRect().bottom > bounds.top + 1,
        );
        window.readingScrollEvents.push({
          at: performance.now(),
          sessionId: window.readingRuntime?.getSnapshot().activeSessionId,
          top: node.scrollTop,
          height: node.scrollHeight,
          anchor: anchor?.getAttribute('data-message-id'),
          offset: anchor
            ? anchor.getBoundingClientRect().top - bounds.top
            : null,
        });
      },
      true,
    );
  });
  await page.goto(
    server.resolvedUrls.local[0] + 'test/conversation-reading-anchor-ui.html',
  );
  await page.locator('.transcript [data-windowed-count="10000"]').waitFor();
  const frame = async (phase) => {
    await page.waitForTimeout(200);
    const value = await page.locator('.transcript').evaluate((scroller) => {
      const viewport = scroller.getBoundingClientRect();
      const nodes = [...scroller.querySelectorAll('[data-message-id]')];
      const node = nodes.find(
        (row) =>
          row.getBoundingClientRect().bottom > viewport.top + 1 &&
          row.getBoundingClientRect().top < viewport.bottom,
      );
      return {
        id: node?.getAttribute('data-message-id'),
        offset: node ? node.getBoundingClientRect().top - viewport.top : null,
        top: scroller.scrollTop,
        height: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        rows: nodes.map((row) => ({
          id: row.getAttribute('data-message-id'),
          top: row.getBoundingClientRect().top - viewport.top,
          height: row.getBoundingClientRect().height,
        })),
      };
    });
    const presentation = await page.evaluate(
      () =>
        window.readingRuntime
          .getSnapshot()
          .sessions.find((row) => row.id === 'history')?.presentation,
    );
    frames.push({ phase, ...value, presentation });
    return value;
  };
  await page.waitForTimeout(400);
  await page.locator('.transcript').evaluate((node) => {
    node.scrollTop = node.scrollHeight - node.clientHeight - 2000;
  });
  await page.waitForTimeout(400);
  const before = await frame('before-history');
  assert(before.id?.startsWith('history-'));
  for (let index = 0; index < 4; index++) {
    await page.getByRole('button', { name: 'alternate', exact: true }).click();
    await page.locator('[data-message-id="alternate-0"]').waitFor();
    await page.getByRole('button', { name: 'history', exact: true }).click();
    await page.locator('[data-windowed-count="10000"]').waitFor();
    const after = await frame(`history-return-${index}`);
    assert.equal(
      after.id,
      before.id,
      'switching history preserves exact visible message identity',
    );
    assert(
      Math.abs(after.offset - before.offset) <= 4,
      'switching history preserves reading anchor within 4px',
    );
  }
  await page
    .getByRole('button', { name: 'open source and remount', exact: true })
    .click();
  await page.getByRole('button', { name: 'close source', exact: true }).click();
  const remounted = await frame('remounted');
  assert.equal(remounted.id, before.id);
  assert(Math.abs(remounted.offset - before.offset) <= 4);
  await page.reload();
  await page.locator('[data-windowed-count="10000"]').waitFor();
  const restored = await frame('reload');
  assert.equal(restored.id, before.id);
  assert(Math.abs(restored.offset - before.offset) <= 4);
  await page.locator('.transcript').evaluate((node) => {
    node.scrollTo({ top: node.scrollHeight, behavior: 'instant' });
  });
  await page.waitForFunction(() => {
    const node = document.querySelector('.transcript');
    return node && node.scrollHeight - node.scrollTop - node.clientHeight <= 1;
  });
  await page.evaluate(() =>
    window.readingRuntime.change((snapshot) => {
      const session = snapshot.sessions.find((row) => row.id === 'history');
      session.messages.push({
        id: 'history-new',
        parentId: session.leafId,
        role: 'assistant',
        at: '12:01',
        text: 'New tail message remains followed.',
      });
      session.leafId = 'history-new';
    }),
  );
  const tail = await frame('follow-tail');
  assert(
    tail.height - tail.top - tail.clientHeight <= 1,
    'follow-tail still follows appended real message',
  );
  assert.equal(
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue(),
    'unchanged manual draft',
  );
  console.log(
    'real Conversation 10k variable-height history stable ID/offset across 4 session switches, remount, reload and follow-tail passed',
  );
} finally {
  if (output) {
    await writeFile(
      join(output, 'frames.json'),
      JSON.stringify(frames, null, 2),
    );
    await writeFile(
      join(output, 'scroll-events.json'),
      JSON.stringify(
        await page?.evaluate(() => window.readingScrollEvents).catch(() => []),
        null,
        2,
      ),
    );
    await page
      ?.screenshot({ path: join(output, 'reading-anchor.png') })
      .catch(() => {});
  }
  await browser?.close();
  await server.close();
}
