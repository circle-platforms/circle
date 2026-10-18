import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
let browser;
const output = resolve(
  process.env.CIRCLE_TASKS_UI_EVIDENCE_DIR ??
    'apps/workbench/artifacts/tasks-panel-headless',
);
await mkdir(output, { recursive: true });
const observations = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const theme of ['light', 'dark'])
    for (const language of ['en', 'zh-CN'])
      for (const width of [1000, 375]) {
        const page = await browser.newPage({
          viewport: { width, height: 650 },
        });
        await page.goto(
          `${server.resolvedUrls.local[0]}test/tasks-panel-ui.html?theme=${theme}&language=${language}&embedded=1`,
        );
        const task = page
          .locator('.tasks-list .task-row')
          .getByText('Implement editor navigation', {
            exact: true,
          });
        await task.waitFor();
        assert.equal(
          await page.locator('.task-panel-toolbar > strong').count(),
          0,
          'the embedded activity content must not repeat the inspector title',
        );
        assert.equal(await page.locator('.task-entry[open]').count(), 0);
        assert.equal(await page.locator('.task-row').count(), 3);
        assert.equal(await page.getByRole('textbox').count(), 0);
        const rect = await task.boundingBox();
        assert.ok(rect.y >= 0 && rect.y + rect.height < 650);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await page.screenshot({
          path: join(output, `${theme}-${language}-${width}-initial.png`),
        });
        const fontSize = await page
          .locator('.task-panel')
          .evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
        await page.evaluate(() =>
          document.documentElement.style.setProperty('--ui-size', '17px'),
        );
        assert.ok(
          (await page
            .locator('.task-panel')
            .evaluate((node) => parseFloat(getComputedStyle(node).fontSize))) >
            fontSize,
          'embedded task text must follow the existing text-size preference',
        );
        await page.evaluate(() =>
          document.documentElement.style.removeProperty('--ui-size'),
        );
        observations.push({
          theme,
          language,
          width,
          firstTaskBounds: rect,
          realWorkbenchCss: true,
          native: false,
        });
        const add = page.getByRole('button', {
          name: language === 'en' ? 'new task' : '新建任务',
          exact: true,
        });
        await add.focus();
        await add.press('Enter');
        const instruction = page.getByRole('textbox', {
          name: language === 'en' ? 'task instruction' : '任务指令',
          exact: true,
        });
        await instruction.fill('New keyboard task');
        const criteria = page.getByRole('textbox', {
          name: language === 'en' ? 'acceptance criteria' : '验收条件',
          exact: true,
        });
        await criteria.fill('Actual files persist\nIndependent check passes');
        await page
          .getByRole('button', {
            name: language === 'en' ? 'close task form' : '收起新建任务',
            exact: true,
          })
          .click();
        await add.click();
        assert.equal(await instruction.inputValue(), 'New keyboard task');
        assert.equal(
          await criteria.inputValue(),
          'Actual files persist\nIndependent check passes',
        );
        await page
          .getByRole('combobox', {
            name: language === 'en' ? 'workspace access' : '工作区访问',
            exact: true,
          })
          .selectOption('readonly');
        await page
          .getByRole('combobox', {
            name: language === 'en' ? 'kind of work' : '工作类型',
            exact: true,
          })
          .selectOption('build');
        await page
          .getByRole('button', {
            name: language === 'en' ? 'start ready tasks' : '启动就绪任务',
            exact: true,
          })
          .click();
        assert.equal(
          (await page.evaluate(() => window.calls)).filter(
            (call) => call.payload.method === 'enqueue',
          ).length,
          0,
          'start must never submit the creation form',
        );
        await page
          .getByRole('button', {
            name: language === 'en' ? 'queue task' : '加入任务队列',
            exact: true,
          })
          .click();
        await page
          .locator('.tasks-list .task-row')
          .getByText('New keyboard task', { exact: true })
          .waitFor();
        assert.equal(await instruction.isVisible(), false);
        const request = (await page.evaluate(() => window.calls)).find(
          (call) => call.payload.method === 'enqueue',
        );
        assert.deepEqual(request.payload.params.tasks[0].acceptanceCriteria, [
          'Actual files persist',
          'Independent check passes',
        ]);
        assert.equal(request.payload.params.tasks[0].access, 'readonly');
        assert.equal(request.payload.params.tasks[0].resource, 'build');
        await page.close();
      }
  const race = await browser.newPage({
    viewport: { width: 1000, height: 650 },
  });
  await race.addInitScript(() => {
    const frame = window.requestAnimationFrame.bind(window);
    // A busy renderer may deliver a scheduled frame after focus already moved.
    window.requestAnimationFrame = (callback) =>
      frame((time) => setTimeout(() => callback(time), 80));
  });
  await race.goto(
    `${server.resolvedUrls.local[0]}test/tasks-panel-ui.html?theme=dark&language=en`,
  );
  await race.getByRole('button', { name: 'new task', exact: true }).click();
  const raceInstruction = race.getByRole('textbox', {
    name: 'task instruction',
    exact: true,
  });
  const raceCriteria = race.getByRole('textbox', {
    name: 'acceptance criteria',
    exact: true,
  });
  await raceInstruction.fill('TASK_FOCUS_RACE');
  await raceCriteria.focus();
  await race.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  assert.equal(
    await raceCriteria.evaluate((node) => document.activeElement === node),
    true,
    'new task must not steal focus back after the developer moved to acceptance criteria',
  );
  await race.keyboard.type('criterion typed once');
  assert.equal(await raceInstruction.inputValue(), 'TASK_FOCUS_RACE');
  assert.equal(await raceCriteria.inputValue(), 'criterion typed once');
  await race.screenshot({ path: join(output, 'delayed-frame-focus-race.png') });
  await race.getByRole('button', { name: 'queue task', exact: true }).click();
  await race
    .locator('.tasks-list .task-row')
    .getByText('TASK_FOCUS_RACE', { exact: true })
    .waitFor();
  await race.getByRole('button', { name: 'new task', exact: true }).click();
  await raceInstruction.fill('TASK_FOCUS_RACE_B');
  await raceCriteria.focus();
  await race.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  await race.keyboard.type('second criterion typed once');
  await race.getByRole('button', { name: 'queue task', exact: true }).click();
  await race
    .locator('.tasks-list .task-row')
    .getByText('TASK_FOCUS_RACE_B', { exact: true })
    .waitFor();
  const enqueued = (await race.evaluate(() => window.calls)).filter(
    (call) => call.payload.method === 'enqueue',
  );
  assert.deepEqual(
    enqueued.map((call) => ({
      prompt: call.payload.params.tasks[0].prompt,
      criteria: call.payload.params.tasks[0].acceptanceCriteria,
    })),
    [
      { prompt: 'TASK_FOCUS_RACE', criteria: ['criterion typed once'] },
      {
        prompt: 'TASK_FOCUS_RACE_B',
        criteria: ['second criterion typed once'],
      },
    ],
  );
  await race.close();
  const background = await browser.newPage();
  await background.goto(
    `${server.resolvedUrls.local[0]}test/tasks-panel-ui.html?focusTask=1`,
  );
  await background.locator('#task-task-0').waitFor();
  await background.locator('#task-task-0 .task-entry[open]').waitFor();
  const manual = background.getByRole('textbox', {
    name: 'manual editor',
    exact: true,
  });
  await manual.fill('developer is editing another file');
  await background
    .getByRole('button', { name: 'refresh', exact: true })
    .first()
    .evaluate((node) => node.click());
  await background.waitForFunction(
    () =>
      window.calls.filter(
        (call) =>
          call.payload.service === 'tasks' && call.payload.method === 'list',
      ).length >= 2,
  );
  await background.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await manual.evaluate((node) => document.activeElement === node),
    true,
    'refreshing an already revealed task must not steal manual editor focus',
  );
  await background.screenshot({
    path: join(output, 'background-task-focus.png'),
  });
  await background.close();
  const review = await browser.newPage({
    viewport: { width: 375, height: 750 },
  });
  await review.goto(
    `${server.resolvedUrls.local[0]}test/tasks-panel-ui.html?embedded=1&review=1&theme=light&language=en`,
  );
  const reviewRow = review.locator('#task-review-task .task-row');
  await reviewRow.waitFor();
  assert.equal(await review.locator('.task-review').isVisible(), false);
  await reviewRow.focus();
  await reviewRow.press('Enter');
  assert.equal(
    await review.locator('#task-review-task .task-instruction').textContent(),
    'Review task summary\nComplete task instruction remains available after expanding the activity row.',
  );
  await review.locator('.task-evidence > summary').click();
  assert.match(
    await review.locator('.task-evidence').textContent(),
    /Original regression failed/,
  );
  assert.match(
    await review.locator('.task-evidence').textContent(),
    /exit code: 1/,
  );
  assert.match(
    await review.locator('.task-evidence').textContent(),
    /needs review/,
  );
  assert.equal(
    await review.locator('.task-evidence .status-success').count(),
    0,
    'worker results never synthesize passed verification',
  );
  const confirm = review.getByRole('button', {
    name: 'confirm reviewed criteria',
    exact: true,
  });
  assert.equal(await confirm.isDisabled(), true);
  await review.locator('.task-review input[type=checkbox]').check();
  assert.equal(
    await confirm.isDisabled(),
    true,
    'checking a criterion alone must not approve it',
  );
  const evidence = review.getByRole('textbox', {
    name: 'review evidence for keep complete source',
    exact: true,
  });
  await evidence.fill('Inspected the actual patch and complete source.');
  assert.equal(await confirm.isEnabled(), true);
  assert.equal(
    await review
      .locator('.task-review .task-technical code')
      .last()
      .isVisible(),
    false,
    'technical patch identifiers stay folded until explicitly inspected',
  );
  await review
    .getByRole('button', { name: 'view results', exact: true })
    .click();
  await review
    .locator('.task-artifacts')
    .getByRole('button', { name: 'changes', exact: true })
    .click();
  await review.locator('.task-artifacts .data-block pre').waitFor();
  assert.equal(
    await review.locator('.task-artifacts .data-block pre').textContent(),
    'diff --git a/demo.ts b/demo.ts\n+preserved complete change\n',
  );
  assert.equal(
    await review.locator('.task-artifacts .task-technical code').isVisible(),
    false,
  );
  await review.screenshot({
    path: join(output, 'embedded-human-review-narrow.png'),
    fullPage: true,
  });
  const overflow = await review.evaluate(() =>
    Array.from(document.querySelectorAll('*'))
      .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
      .map((node) => ({
        tag: node.tagName,
        className: node.className,
        right: node.getBoundingClientRect().right,
      })),
  );
  assert.equal(
    await review.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    JSON.stringify(overflow),
  );
  await confirm.click();
  await review.waitForFunction(() =>
    window.calls.some((call) => call.payload.method === 'review'),
  );
  const reviewCall = (await review.evaluate(() => window.calls)).find(
    (call) => call.payload.method === 'review',
  );
  assert.deepEqual(reviewCall.payload.params, {
    id: 'review-task',
    expectedAttempt: 1,
    expectedPatchSha256: 'b'.repeat(64),
    checks: [
      {
        criterion: 'keep complete source',
        evidence: 'Inspected the actual patch and complete source.',
      },
    ],
  });
  await review.close();
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        native: false,
        observations,
        focusChecks: {
          delayedFrameCannotStealCriteria: true,
          twoSequentialTasksKeepIndependentPromptsAndCriteria: true,
          taskRefreshCannotStealManualEditor: true,
        },
        embeddedChecks: {
          singleInspectorTitle: true,
          compactRows: true,
          fullInstructionAccessible: true,
          strictHumanReview: true,
          completeArtifactPreserved: true,
        },
      },
      null,
      2,
    ),
  );
  console.log(
    'task panel headless UX: real CSS, 8 theme/language/width cases, visible progress, retained form and separate start/submit passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
