import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Task limits that could not be read are repaired on the settings page; the queued tasks
// of the folder then wait for the person, who starts them there.
const output = process.env.CIRCLE_COMPONENT_UI_EVIDENCE;
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
  for (const [language, theme] of [
    ['en', 'light'],
    ['zh-CN', 'dark'],
  ]) {
    const page = await browser.newPage({
      viewport: { width: 900, height: 600 },
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/task-limits-recovery-ui.html?language=${language}&theme=${theme}`,
    );
    const zh = language === 'zh-CN';
    const section = page.getByRole('region', {
      name: zh ? '并行任务' : 'parallel tasks',
      exact: true,
    });
    await section
      .getByRole('alert')
      .filter({ hasText: 'invalid agents' })
      .waitFor();
    const start = section.getByRole('button', {
      name: zh ? '启动就绪任务' : 'start ready tasks',
      exact: true,
    });
    assert.equal(await start.count(), 0, 'nothing to start while broken');
    // repair: save a value
    await section
      .getByLabel(zh ? '同时运行的代理' : 'agents at once')
      .fill('3');
    await section
      .getByRole('button', { name: zh ? '保存' : 'save', exact: true })
      .click();
    await start.waitFor();
    assert.equal(await section.getByRole('alert').count(), 0);
    if (output) {
      await mkdir(output, { recursive: true });
      await page.screenshot({
        path: join(output, `${language}-${theme}-repaired.png`),
      });
    }
    // the person starts the queued tasks of this folder, and the note goes
    await start.click();
    await start.waitFor({ state: 'detached' });
    const calls = await page.evaluate(() => window.calls);
    assert.deepEqual(calls.filter((call) => call.method === 'start').length, 1);
    assert.deepEqual(calls.find((call) => call.params?.limits)?.params.limits, {
      agents: 3,
      builds: 1,
      ui: 1,
      browsers: 1,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
console.log('task limits recovery: ok');
