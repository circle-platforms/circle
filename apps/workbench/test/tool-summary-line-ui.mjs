import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { MIN_CONVERSATION } from '../src/app/workspace-layout.ts';

// A turn's tools fold to one line. When the line's words do not fit, the summary gives
// way with an ellipsis. The counts after it keep their words, and the turn's clock is cut
// short only once the summary has no room left. The row never leaves its column. Each
// width from the narrowest conversation to the widest column is checked.
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
  for (const language of ['en', 'zh-CN'])
    for (const variant of ['', '&retry=endpoint error 10/10', '&short=1']) {
      const page = await browser.newPage({
        viewport: { width: 1100, height: 400 },
      });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(
        `${server.resolvedUrls.local[0]}test/tool-summary-line-ui.html?language=${language}${variant}`,
      );
      await page.locator('.tool-summary .turn-clock').waitFor();
      for (let pane = MIN_CONVERSATION; pane <= 1000; pane += 10) {
        const where = `${language}${variant} in a ${pane}px conversation`;
        const row = await page.evaluate((pane) => {
          document.getElementById('pane').style.width = `${pane}px`;
          const button = document.querySelector('.tool-summary');
          // How a piece's words sit in its box: the lines they fall on, and by how much
          // they run past it (more than nothing draws an ellipsis).
          const measure = (element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return {
              text: element.textContent,
              lines: new Set(
                [...range.getClientRects()].map((rect) => Math.round(rect.top)),
              ).size,
              over:
                range.getBoundingClientRect().width -
                element.getBoundingClientRect().width,
            };
          };
          const summary = button.querySelector('.tool-summary-text');
          const column = button.closest('.transcript-column');
          const edge =
            column.getBoundingClientRect().right -
            parseFloat(getComputedStyle(column).paddingRight);
          return {
            room: summary.getBoundingClientRect().width,
            summary: measure(summary),
            counts: [
              ...button.querySelectorAll(
                ':scope > span:not(.tool-summary-text):not(.turn-clock)',
              ),
            ].map(measure),
            clock: measure(button.querySelector('.turn-clock')),
            out: Math.max(
              ...[...button.children].map(
                (child) => child.getBoundingClientRect().right - edge,
              ),
            ),
          };
        }, pane);
        assert.equal(row.summary.lines, 1, `${where}: the summary wraps`);
        for (const piece of [...row.counts, row.clock])
          assert.equal(piece.lines, 1, `${where}: "${piece.text}" wraps`);
        for (const count of row.counts)
          assert(count.over <= 0, `${where}: "${count.text}" is cut`);
        if (row.room >= 0.5)
          assert(row.clock.over <= 0, `${where}: the clock is cut first`);
        assert(row.out <= 0.5, `${where}: the row leaves its column`);
        if (pane === 1000) {
          // The widest column, as in the report: a long summary does not fit; a short
          // one does, and is left whole.
          const fits = variant === '&short=1';
          assert.equal(row.summary.over > 0, !fits, `${where}: summary`);
          assert.equal(row.counts.length, fits ? 0 : 2, `${where}: counts`);
        }
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
} finally {
  await browser?.close();
  await server.close();
}
console.log('tool summary line: ok');
