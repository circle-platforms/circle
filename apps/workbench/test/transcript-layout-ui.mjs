import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// The conversation takes the room the window gives it, up to 1280 pixels with the input box
// as wide; and an opened line of calls stacks each step's calls in one frame, with no room
// between them.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const output = process.env.CIRCLE_COMPONENT_UI_EVIDENCE ?? 'artifacts';
await mkdir(output, { recursive: true });
const call = (id, name, target) => ({
  id,
  role: 'tool',
  at: '10:30',
  text: `${name} ${target}`,
  tool: {
    id: 'tool-' + id,
    name,
    input:
      name === 'execute'
        ? { command: `npm test -- ${target}`, description: `Run ${target}` }
        : { file_path: target },
    output: 'ok',
    status: 'success',
    elapsed: '0.1s',
    ...(name === 'execute' ? {} : { filePath: target }),
  },
});
const steps = [
  {
    id: 'think-1',
    role: 'assistant',
    at: '10:30',
    text: '',
    thinking: 'Verifying the existing tests',
  },
  call('c1', 'execute', 'scanner'),
  call('c2', 'read_file', 'hub/connectors/read.ts'),
  call('c3', 'read_file', 'hub/connectors/read.test.ts'),
  {
    id: 'think-2',
    role: 'assistant',
    at: '10:31',
    text: '',
    thinking: 'Adding a cache test',
  },
  call('c4', 'execute', 'cache'),
  {
    ...call('c5', 'write_file', 'docs/tasks/cache.md'),
    tool: {
      ...call('c5', 'write_file', 'docs/tasks/cache.md').tool,
      diff: {
        summary: 'new file, 2 lines',
        rows: [
          { text: '@@ -0,0 +1,2 @@' },
          { text: '+  1  # Cache', tone: 'added' },
          { text: '+  2  ', tone: 'added' },
        ],
      },
    },
  },
  { id: 'answer', role: 'assistant', at: '10:32', text: 'Done.' },
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
      viewport: { width: 1800, height: 1000 },
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/response-readability-ui.html?language=${language}&theme=${theme}#/session/session1`,
    );
    await page.locator('.overview-column .overview-card').first().waitFor();
    await page.evaluate((steps) => {
      window.readabilityFixture.runtime.change((state) => {
        const session = state.sessions.find((item) => item.id === 'session1');
        let parent = session.messages.at(-1)?.id ?? null;
        for (const step of steps) {
          session.messages.push({ ...step, parentId: parent });
          parent = step.id;
        }
        session.leafId = parent;
        session.branchIds = session.messages.map((message) => message.id);
        session.showThinking = true;
        session.state = 'idle';
      });
    }, steps);
    // Open the line that folds the two steps' calls
    const line = page
      .locator('.tool-group')
      .filter({ hasText: /read 2 files|读取了 2 个文件/ })
      .first();
    await line.waitFor();
    if (!(await line.locator('.tool-group-calls').count()))
      await line.locator('.tool-summary').first().click();
    await line.locator('.tool-group-calls').waitFor();
    const measured = await line.evaluate((group) => {
      const stacks = [...group.querySelectorAll('.tool-stack')];
      const calls = stacks.map((stack) =>
        [...stack.querySelectorAll(':scope > div > .tool-call')].map((card) => {
          const box = card.getBoundingClientRect();
          const style = getComputedStyle(card);
          return {
            top: box.top,
            bottom: box.bottom,
            margin: style.marginTop + ' ' + style.marginBottom,
            border: style.borderTopWidth,
          };
        }),
      );
      const gaps = calls.map((cards) =>
        cards
          .slice(1)
          .map((card, index) => Math.round(card.top - cards[index].bottom)),
      );
      const frame = getComputedStyle(stacks[0]);
      const list = group.querySelector('.tool-group-calls');
      return {
        rule: getComputedStyle(list).borderLeftWidth,
        indent: Math.round(
          stacks[0].getBoundingClientRect().left -
            group.querySelector('.tool-summary').getBoundingClientRect().left,
        ),
        stacks: calls.map((cards) => cards.length),
        gaps,
        margins: [...new Set(calls.flat().map((card) => card.margin))],
        frame: frame.borderTopWidth + ' ' + frame.borderTopStyle,
      };
    });
    // One frame per step: three calls, then two, with no room between the calls of a step
    assert.deepEqual(measured.stacks, [3, 2], JSON.stringify(measured));
    assert.ok(
      measured.gaps[0].every((gap) => gap >= 0 && gap <= 1),
      JSON.stringify(measured),
    );
    assert.deepEqual(measured.margins, ['0px 0px'], JSON.stringify(measured));
    assert.equal(measured.frame, '1px solid');
    // A call's difference sits under its row with the row's margins on both sides: its
    // left edge under the row's icon, as far from the card's right edge
    const diff = await line.evaluate((group) => {
      const card = [...group.querySelectorAll('.tool-call')].find((node) =>
        node.querySelector('.tool-diff'),
      );
      const box = card.getBoundingClientRect();
      const block = card.querySelector('.diff-block').getBoundingClientRect();
      const icon = card.querySelector('.tool-head svg').getBoundingClientRect();
      return {
        left: Math.round(block.left - box.left),
        right: Math.round(box.right - block.right),
        iconLeft: Math.round(icon.left - box.left),
      };
    });
    assert.equal(diff.left, diff.right, JSON.stringify(diff));
    assert.ok(Math.abs(diff.left - diff.iconLeft) <= 1, JSON.stringify(diff));
    // The frames sit under the line itself, with no rule or indent on their left
    assert.equal(measured.rule, '0px', JSON.stringify(measured));
    assert.equal(measured.indent, 0, JSON.stringify(measured));
    // The column and the input box take the room the window gives them, up to 1280 pixels
    const widths = await page.evaluate(() => {
      const column = document
        .querySelector('.transcript-column')
        .getBoundingClientRect();
      const transcript = document
        .querySelector('.transcript')
        .getBoundingClientRect();
      const composer = document
        .querySelector('.composer-area > *')
        .getBoundingClientRect();
      return {
        column: Math.round(column.width),
        room: Math.round(transcript.width),
        composer: Math.round(composer.width),
      };
    });
    assert.ok(widths.column > 780, JSON.stringify(widths));
    assert.ok(widths.column <= 1280, JSON.stringify(widths));
    assert.ok(
      widths.column >= Math.min(1280, widths.room - 20),
      `the column fills the room it has: ${JSON.stringify(widths)}`,
    );
    // The input box is as wide as the column, or as its text where the room is short of
    // 1280 pixels: both keep the 28-pixel margins of the room
    assert.ok(
      widths.composer >= widths.column - 56 && widths.composer <= widths.column,
      JSON.stringify(widths),
    );
    await page.screenshot({
      path: `${output}/transcript-layout-${language}-${theme}.png`,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "transcript layout: the column takes the room up to 1280px with the input as wide, and a step's calls stack in one frame, in English and Chinese",
  );
} finally {
  await browser?.close();
  await server.close();
}
