import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// A link the model wrote to its plan folder opens there, never as a workspace path: the
// plan as the plan, another file it wrote there read only, and one that is not there says
// so in words.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const output = process.env.CIRCLE_COMPONENT_UI_EVIDENCE ?? 'artifacts';
await mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const [locale, theme] of [
    ['en', 'light'],
    ['zh-CN', 'dark'],
  ]) {
    const word = (en, zh) => (locale === 'zh-CN' ? zh : en);
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/plan-folder-links-ui.html?locale=${locale}&theme=${theme}`,
    );
    const answer = page.locator('[data-message-id="plan-folder-links"]');
    await answer.waitFor();
    const calls = () =>
      page.evaluate(() => window.planFolderFixture.calls.map((c) => c.call));
    const view = page.locator('.plan-view');
    // Another file the model wrote in the plan folder: read from the plan folder, shown
    // read only under its own name
    await answer.getByRole('link', { name: 'the review', exact: true }).click();
    await view
      .getByRole('region', { name: 'proposal-review.md', exact: true })
      .getByText('SYNTHETIC-REVIEW')
      .waitFor();
    assert.equal(
      await view.locator('.file-view-filename strong').textContent(),
      'proposal-review.md',
    );
    assert.equal(
      await view.locator('.file-source-folder').textContent(),
      word('plan folder, read only', '计划文件夹，只读'),
    );
    assert.equal(
      await view.locator('textarea, [contenteditable="true"]').count(),
      0,
      'nothing in the view edits the file',
    );
    assert.deepEqual(
      await page.evaluate(() =>
        window.planFolderFixture.calls.filter(
          (c) => c.call === 'documents.readPlanFolder',
        ),
      ),
      [
        {
          call: 'documents.readPlanFolder',
          params: { path: '/session_plans/proposal-review.md' },
        },
      ],
    );
    // The plan opens as the plan, from what Circle sent, without asking again
    await answer.getByRole('link', { name: 'the plan', exact: true }).click();
    await view
      .getByRole('region', { name: word('plan', '计划'), exact: true })
      .getByText('SYNTHETIC-PLAN')
      .waitFor();
    // A file that is not there says so, in words, beside what the controller said
    await answer.getByRole('link', { name: 'the draft', exact: true }).click();
    const alert = view.getByRole('alert');
    await alert.waitFor();
    assert.match(
      await alert.textContent(),
      word(/missing\.md could not be opened/, /missing\.md 无法打开/),
    );
    assert.match(await alert.textContent(), /does not exist/);
    // No plan folder link was ever taken for a workspace path
    assert.equal(
      (await calls()).filter((call) => call === 'documents.resolveSource')
        .length,
      0,
    );
    await page.screenshot({
      path: `${output}/plan-folder-links-${locale}-${theme}.png`,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'plan folder links: the plan opens as the plan, another plan folder file read only, a missing one says so, never as a workspace path, in English and Chinese',
  );
} finally {
  await browser?.close();
  await server.close();
}
