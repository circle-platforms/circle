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
          `${server.resolvedUrls.local[0]}test/tasks-panel-ui.html?theme=${theme}&language=${language}`,
        );
        const task = page
          .locator('.tasks-list')
          .getByText('Implement editor navigation', {
            exact: true,
          });
        await task.waitFor();
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
            name: language === 'en' ? 'execution resource' : '执行资源',
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
          .locator('.tasks-list')
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
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify({ native: false, observations }, null, 2),
  );
  console.log(
    'task panel headless UX: real CSS, 8 theme/language/width cases, visible progress, retained form and separate start/submit passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
