import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
const output = resolve(
  process.env.CIRCLE_WINDOWED_EVIDENCE_DIR ??
    'apps/workbench/artifacts/windowed-mount',
);
await mkdir(output, { recursive: true });
const receipts = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const full of process.env.CIRCLE_WINDOWED_MODE === 'full'
    ? [true]
    : [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    page.setDefaultTimeout(4000);
    const mode = full ? 'full-workbench' : 'parent-scroller';
    await page.goto(
      `${server.resolvedUrls.local[0]}test/windowed-mount-ui.html${full ? '?full=1' : ''}`,
    );
    await page.locator('[data-windowed-count="10000"]').waitFor();
    await page.waitForTimeout(500);
    const initial = await page.evaluate(() => {
      const scroller = document.querySelector('.transcript');
      const bounds = scroller.getBoundingClientRect();
      const rows = [...document.querySelectorAll('[data-message],.message')];
      const id = (row) =>
        Number(
          row.dataset.message ??
            (row.textContent.includes('PERF_HISTORY_READY')
              ? '9999'
              : row.textContent.match(/history (\d+)/)?.[1]),
        );
      return {
        top: scroller.scrollTop,
        height: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        mounted: rows.map(id),
        visible: rows
          .filter((row) => {
            const r = row.getBoundingClientRect();
            return r.bottom > bounds.top && r.top < bounds.bottom;
          })
          .map(id),
      };
    });
    receipts.push({ mode, initial });
    await page.screenshot({ path: join(output, mode + '-initial.png') });
    await writeFile(
      join(output, 'receipt.json'),
      JSON.stringify(
        {
          native: false,
          sourceSha256: createHash('sha256')
            .update(
              await readFile(
                new URL('../src/components/WindowedList.tsx', import.meta.url),
              ),
            )
            .digest('hex'),
          receipts,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ mode, ...initial }));
    assert.ok(
      initial.visible.includes(9999),
      'initial end-following transcript must mount visible last message without manual scrolling',
    );
    assert.ok(initial.mounted.length < 100, '10k history stays virtualized');
    const tail = page.getByText('PERF_HISTORY_READY', { exact: true });
    const tailBounds = await tail.boundingBox();
    const scrollBounds = await page.locator('.transcript').boundingBox();
    assert.ok(
      tailBounds.y < scrollBounds.y + scrollBounds.height &&
        tailBounds.y + tailBounds.height > scrollBounds.y,
      'actual final text pixels intersect transcript viewport',
    );
    if (full) {
      await page
        .locator('.transcript')
        .evaluate((node) => node.scrollTo({ top: 0, behavior: 'instant' }));
      await page.waitForTimeout(150);
      await page.waitForFunction(() =>
        Boolean(
          document.querySelector('[data-message="0"],[data-message-id="0"]'),
        ),
      );
    }
    await page.close();
  }
  console.log(
    'real React 10k mount: initial end visible and scroll subscription works for parent ref and complete workbench',
  );
} finally {
  await browser?.close();
  await server.close();
}
