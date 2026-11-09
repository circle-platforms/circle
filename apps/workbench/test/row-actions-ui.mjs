import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// One way to copy and one place to act, everywhere in the conversation: text copies itself
// with the same icon in its top right corner, a folded text is copied from its row's head,
// and what opens elsewhere (a file) sits at the right end of the row it belongs to. No row
// holds buttons alone.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const output = process.env.CIRCLE_COMPONENT_UI_EVIDENCE ?? 'artifacts';
await mkdir(output, { recursive: true });
const command = 'npm test -- --grep "row actions"';
const steps = [
  {
    id: 'ra-read',
    role: 'tool',
    at: '10:30',
    text: 'read public/task-model.mjs',
    tool: {
      id: 'tool-ra-read',
      name: 'read_file',
      input: { file_path: 'public/task-model.mjs' },
      output: 'export function visibleTasks(tasks, mode) {',
      status: 'success',
      elapsed: '0.1s',
      filePath: 'public/task-model.mjs',
    },
  },
  {
    id: 'ra-run',
    role: 'tool',
    at: '10:30',
    text: 'run the tests',
    tool: {
      id: 'tool-ra-run',
      name: 'execute',
      input: { command, description: 'Run the row action tests' },
      output: '1 passing',
      status: 'success',
      elapsed: '0.4s',
    },
  },
  {
    id: 'ra-answer',
    role: 'assistant',
    at: '10:31',
    text: 'Run it again with:\n\n```sh\nnpm test\n```',
  },
  {
    id: 'failure-ra',
    role: 'notice',
    at: '10:32',
    text: 'model request failed\nHTTP 502 from the synthetic gateway',
  },
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
    const zh = language === 'zh-CN';
    const word = (en, chinese) => (zh ? chinese : en);
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
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
        session.state = 'idle';
      });
    }, steps);
    // Open both calls, wherever the line of calls folds them
    const card = (target) =>
      page.locator('.tool-call').filter({ hasText: target }).first();
    for (const target of ['public/task-model.mjs', 'row action']) {
      for (
        let attempt = 0;
        attempt < 3 && !(await card(target).isVisible());
        attempt++
      ) {
        await page.locator('.tool-summary').last().click();
        await page.waitForTimeout(100);
      }
      if (!(await card(target).locator('.tool-content').count()))
        await card(target).locator('.tool-head').click();
      await card(target).locator('.tool-content').waitFor();
    }
    // A call opens to its blocks only: no row of buttons above them
    assert.equal(await page.locator('.tool-toolbar').count(), 0);
    // Opening the file sits on the call's head, at its right end
    const read = card('public/task-model.mjs');
    const open = read.getByRole('button', {
      name: word('open file', '打开文件'),
      exact: true,
    });
    const placed = await read.evaluate((node) => {
      const head = node.querySelector('.tool-head').getBoundingClientRect();
      const button = [...node.querySelectorAll('.tool-row button')].find(
        (item) => !item.classList.contains('tool-head'),
      );
      const box = button.getBoundingClientRect();
      const cardBox = node.getBoundingClientRect();
      return {
        inRow: !!button.closest('.tool-row'),
        inContent: !!button.closest('.tool-content'),
        middle: Math.abs(
          box.top + box.height / 2 - (head.top + head.height / 2),
        ),
        right: Math.round(cardBox.right - box.right),
        text: button.textContent.trim(),
      };
    });
    assert.equal(placed.inRow, true, JSON.stringify(placed));
    assert.equal(placed.inContent, false, JSON.stringify(placed));
    assert.ok(placed.middle <= 1, JSON.stringify(placed));
    assert.ok(placed.right <= 12, JSON.stringify(placed));
    assert.equal(placed.text, '', 'an icon, named by its tip');
    // A folded call shows no actions on its head
    await read.locator('.tool-head').click();
    assert.equal(await open.count(), 0);
    await read.locator('.tool-head').click();
    await open.click();
    await page.locator('.file-view').waitFor();
    await page.goBack();
    await page.locator('.tool-call').first().waitFor();
    // A command copies itself without its `$`, from the icon in its own corner
    const run = card('row action');
    if (!(await run.locator('.tool-content').count()))
      await run.locator('.tool-head').click();
    const copyCommand = run.getByRole('button', {
      name: word('copy command', '复制命令'),
      exact: true,
    });
    const corner = await copyCommand.evaluate((button) => {
      const block = button
        .closest('.copyable')
        .querySelector('pre')
        .getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return {
        top: Math.round(box.top - block.top),
        right: Math.round(block.right - box.right),
        inside: box.left > block.left && box.bottom < block.bottom,
      };
    });
    assert.ok(corner.inside, JSON.stringify(corner));
    assert.ok(corner.top >= 0 && corner.top <= 10, JSON.stringify(corner));
    assert.ok(corner.right >= 0 && corner.right <= 10, JSON.stringify(corner));
    const copied = () => page.evaluate(() => window.readabilityFixture.copied);
    const before = (await copied()).length;
    await copyCommand.click();
    await page.waitForFunction(
      (count) => window.readabilityFixture.copied.length > count,
      before,
    );
    assert.equal((await copied()).at(-1), command);
    // The code of an answer copies from its bar, with the same icon
    await page
      .locator('.code-block')
      .getByRole('button', { name: word('copy code', '复制代码'), exact: true })
      .click();
    await page.waitForFunction(
      (count) => window.readabilityFixture.copied.length > count + 1,
      before,
    );
    assert.equal((await copied()).at(-1), 'npm test');
    // A failure's details copy from its head, beside what failed
    const failure = page.locator('.runtime-failure');
    const failureCopy = failure.getByRole('button', {
      name: word('copy error details', '复制错误详情'),
      exact: true,
    });
    assert.equal(
      await failureCopy.evaluate((button) => !!button.closest('.head-row')),
      true,
    );
    await failureCopy.click();
    await page.waitForFunction(
      (count) => window.readabilityFixture.copied.length > count + 2,
      before,
    );
    assert.match((await copied()).at(-1), /HTTP 502/);
    // Every copy button is the same icon, and none is a word
    const icons = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter((button) =>
          /^(copy|复制)/.test(button.getAttribute('aria-label') ?? ''),
        )
        .map((button) => ({
          label: button.getAttribute('aria-label'),
          text: button.textContent.trim(),
          icon: button.querySelector('svg')?.getAttribute('class') ?? '',
        })),
    );
    assert.ok(icons.length >= 4, JSON.stringify(icons));
    for (const icon of icons) {
      assert.equal(icon.text, '', JSON.stringify(icon));
      assert.match(icon.icon, /lucide-(copy|check)\b/, JSON.stringify(icon));
    }
    await page.screenshot({
      path: `${output}/row-actions-${language}-${theme}.png`,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'row actions: text copies itself with one icon, a failure copies from its head, and a call opens its file from its head, in English and Chinese',
  );
} finally {
  await browser?.close();
  await server.close();
}
