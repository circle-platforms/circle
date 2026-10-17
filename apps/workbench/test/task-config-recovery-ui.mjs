import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const output = process.env.CIRCLE_COMPONENT_UI_EVIDENCE;
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
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      for (const width of [375, 1000]) {
        const page = await browser.newPage({
          viewport: { width, height: 750 },
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(
          `${server.resolvedUrls.local[0]}test/task-config-recovery-ui.html?language=${language}&theme=${theme}`,
        );
        const zh = language === 'zh-CN';
        const name = `${language}-${theme}-${width}`;
        if (output) await mkdir(output, { recursive: true });
        const panelAlert = page
          .locator('.tasks-panel')
          .getByRole('alert')
          .filter({ hasText: 'invalid agents' });
        await panelAlert.waitFor();
        await panelAlert
          .getByRole('button', {
            name: zh ? '打开设置' : 'open settings',
            exact: true,
          })
          .waitFor();
        assert.equal(
          await page.locator('.tasks-panel input[type=number]').count(),
          0,
          'limits are edited on the settings page, not in the tasks panel',
        );
        await page
          .getByRole('button', {
            name: zh ? '新建任务' : 'new task',
            exact: true,
          })
          .click();
        await page
          .getByLabel(zh ? '任务指令' : 'task instruction', { exact: true })
          .fill('recover real task creation');
        await page
          .getByLabel(zh ? '验收条件' : 'acceptance criteria', { exact: true })
          .fill('preserve the draft');
        const submit = page.getByRole('button', {
          name: zh ? '加入任务队列' : 'queue task',
          exact: true,
        });
        assert(await submit.isDisabled());
        if (output)
          await page.screenshot({ path: join(output, name + '-error.png') });
        const settingsSection = page.getByRole('region', {
          name: zh ? '并行任务' : 'parallel tasks',
          exact: true,
        });
        await settingsSection
          .getByRole('alert')
          .filter({ hasText: 'invalid agents' })
          .waitFor();
        await settingsSection
          .getByLabel(zh ? '同时运行的代理' : 'agents at once')
          .fill('4');
        await settingsSection
          .getByRole('button', {
            name: zh ? '保存' : 'save',
            exact: true,
          })
          .click();
        await page.waitForFunction(
          () => !document.querySelector('[role="alert"]'),
        );
        assert(await submit.isEnabled());
        const recovery = page.getByText(
          zh
            ? '并发上限已修复；准备好后请手动启动排队任务'
            : 'limits repaired; start queued tasks when ready',
          { exact: true },
        );
        await recovery.waitFor();
        assert.equal(
          await page.evaluate(
            () =>
              window.calls.filter((c) => c.payload.method === 'start').length,
          ),
          0,
        );
        await page
          .getByRole('button', {
            name: zh ? '启动就绪任务' : 'start ready tasks',
            exact: true,
          })
          .click();
        await recovery.waitFor({ state: 'hidden' });
        assert.equal(
          await page.evaluate(
            () =>
              window.calls.filter((c) => c.payload.method === 'start').length,
          ),
          1,
        );
        assert.equal(
          await page.locator('.task-create-form textarea').first().inputValue(),
          'recover real task creation',
        );
        const settings = await page.evaluate(() =>
          window.calls.filter(
            (c) => c.payload.method === 'settings' && c.payload.params.limits,
          ),
        );
        assert.equal(settings.length, 1);
        assert.deepEqual(settings[0].payload.params, {
          limits: { agents: 4, builds: 1, ui: 1, browsers: 1 },
        });
        await submit.click();
        await page.waitForFunction(() =>
          window.calls.some((c) => c.payload.method === 'enqueue'),
        );
        assert.equal(
          await page.evaluate(
            () =>
              window.calls.filter((c) => c.payload.method === 'enqueue').length,
          ),
          1,
        );
        assert.deepEqual(errors, []);
        if (output) {
          await page.screenshot({
            path: join(output, name + '-recovered.png'),
          });
          await writeFile(
            join(output, name + '-calls.json'),
            JSON.stringify(await page.evaluate(() => window.calls), null, 2),
          );
        }
        await page.close();
      }
  console.log(
    'PASS: task configuration recovery, 8 language/theme/width combinations',
  );
} finally {
  await browser?.close();
  await server.close();
}
