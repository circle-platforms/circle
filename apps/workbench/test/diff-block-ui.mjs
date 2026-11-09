import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// A write_file whose new file has long lines of prose, as a tool row of the conversation
// shows it: every line wraps under its own text, the sign and number stay in their column,
// the row's colour runs the full width, and nothing scrolls sideways. A Git difference
// without line numbers keeps its sign in the same column.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const output = process.env.CIRCLE_COMPONENT_UI_EVIDENCE ?? 'artifacts';
await mkdir(output, { recursive: true });
const long =
  '验收：一个合成的嵌套文件只按显式记录失效，未被引用的派生物不重读；'.repeat(
    9,
  );
const lines = [
  '# 合成任务：长行的差异',
  '',
  long,
  '',
  'short line',
  'x'.repeat(400),
];
const width = String(lines.length).length;
const rows = [
  { text: `@@ -0,0 +1,${lines.length} @@` },
  ...lines.map((line, index) => ({
    text: `+${String(index + 1).padStart(width + 2)}  ${line}`,
    tone: 'added',
  })),
];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const [language, theme] of [
    ['en', 'light'],
    ['zh-CN', 'dark'],
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/response-readability-ui.html?language=${language}&theme=${theme}#/session/session1`,
    );
    await page.locator('.overview-column .overview-card').first().waitFor();
    await page.evaluate((rows) => {
      window.readabilityFixture.runtime.change((state) => {
        const session = state.sessions.find((item) => item.id === 'session1');
        const last = session.messages.at(-1);
        // The conversation shows the branch that ends at its leaf
        session.leafId = 'diff-write';
        session.branchIds = [...(session.branchIds ?? []), 'diff-write'];
        session.messages.push({
          id: 'diff-write',
          parentId: last?.id ?? null,
          role: 'tool',
          at: '10:30',
          text: 'write the task page',
          tool: {
            id: 'tool-diff-write',
            name: 'write_file',
            input: { file_path: 'docs/tasks/long-lines.md', content: '' },
            output: 'Wrote docs/tasks/long-lines.md',
            status: 'success',
            elapsed: '0.1s',
            filePath: 'docs/tasks/long-lines.md',
            diff: { summary: `new file, ${rows.length - 1} lines`, rows },
          },
        });
        session.state = 'idle';
      });
    }, rows);
    // The row may sit inside a folded line of calls: open it until the block shows
    const block = page
      .locator('.diff-block')
      .filter({ hasText: '合成任务：长行的差异' })
      .first();
    for (
      let attempt = 0;
      attempt < 3 && !(await block.isVisible());
      attempt++
    ) {
      const folded = page
        .locator('.tool-group-summary, .tool-summary-line, button')
        .filter({ hasText: /write|写入|edited|编辑|long-lines/ })
        .last();
      if (await folded.count()) await folded.click();
      await page.waitForTimeout(100);
    }
    await block.scrollIntoViewIfNeeded();
    const measured = await block.evaluate((node) => {
      const pre = node.querySelector('pre');
      const rows = [...pre.children];
      const lineHeight = parseFloat(getComputedStyle(pre).lineHeight);
      const textLeft = (row) =>
        Math.round(
          row.querySelector('.diff-text').getBoundingClientRect().left,
        );
      const body = rows.filter((row) => row.querySelector('.diff-gutter'));
      return {
        sideways: pre.scrollWidth - pre.clientWidth,
        rowWidths: [
          ...new Set(
            rows.map((row) => Math.round(row.getBoundingClientRect().width)),
          ),
        ],
        preWidth: pre.clientWidth,
        textLefts: [...new Set(body.map(textLeft))],
        gutters: body.map(
          (row) => row.querySelector('.diff-gutter').textContent,
        ),
        longLines: Math.round(
          body[2].getBoundingClientRect().height / lineHeight,
        ),
        shortLines: Math.round(
          body[4].getBoundingClientRect().height / lineHeight,
        ),
        unbroken: Math.round(
          body[5].getBoundingClientRect().height / lineHeight,
        ),
        hunkWhole: !rows[0].querySelector('.diff-gutter'),
        background: getComputedStyle(body[2]).backgroundColor,
        text: pre.textContent.split('\n').slice(0, 3),
      };
    });
    assert.equal(measured.sideways, 0, JSON.stringify(measured));
    // Every row is as wide as the block: its colour runs the full width
    assert.deepEqual(
      measured.rowWidths,
      [measured.preWidth],
      JSON.stringify(measured),
    );
    // Every line's text starts in one column, after its sign and number
    assert.equal(measured.textLefts.length, 1, JSON.stringify(measured));
    assert.deepEqual(measured.gutters.slice(0, 3), [
      '+  1  ',
      '+  2  ',
      '+  3  ',
    ]);
    // The long prose line and the line with no break both wrap; a short one does not
    assert.ok(measured.longLines >= 3, JSON.stringify(measured));
    assert.ok(measured.unbroken >= 2, JSON.stringify(measured));
    assert.equal(measured.shortLines, 1, JSON.stringify(measured));
    assert.ok(measured.hunkWhole);
    assert.notEqual(measured.background, 'rgba(0, 0, 0, 0)');
    // Copying the block gives the rows as they were, one a line
    assert.deepEqual(measured.text, [
      `@@ -0,0 +1,${lines.length} @@`,
      '+  1  # 合成任务：长行的差异',
      '+  2  ',
    ]);
    await block.screenshot({
      path: `${output}/diff-block-${language}-${theme}.png`,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'diff block: long lines wrap under their text with the gutter in place, nothing scrolls sideways, in English and Chinese',
  );
} finally {
  await browser?.close();
  await server.close();
}
