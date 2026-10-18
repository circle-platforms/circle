import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
if (!process.env.CIRCLE_AGENT_SOURCE_WIDTH) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  for (const theme of ['dark', 'light']) {
    for (const width of [1280, 375]) {
      const result = await promisify(execFile)(
        process.execPath,
        [...process.execArgv, fileURLToPath(import.meta.url)],
        {
          env: {
            ...process.env,
            CIRCLE_AGENT_SOURCE_WIDTH: String(width),
            CIRCLE_AGENT_SOURCE_THEME: theme,
          },
          timeout: 60000,
        },
      );
      console.log(`${theme} ${width}: ${result.stdout.trim()}`);
    }
  }
  process.exit(0);
}
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
  plugins: [
    {
      name: 'source-return-preapp-seed',
      configureServer(server) {
        server.middlewares.use(
          '/__source_return_seed',
          (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end(
              '<!doctype html><html><body>source return fixture seed</body></html>',
            );
          },
        );
      },
    },
  ],
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
  const page = await browser.newPage({
    viewport: {
      width: Number(process.env.CIRCLE_AGENT_SOURCE_WIDTH ?? 1280),
      height: 900,
    },
  });
  await page.addInitScript(() =>
    localStorage.setItem('circle.workbench.language', 'en'),
  );
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.resolvedUrls.local[0] + '__source_return_seed');
  assert.equal(
    await page.locator('.workbench').count(),
    0,
    'seed writes before any App runtime mounts',
  );
  const { second, childId } = await page.evaluate(async (theme) => {
    const { PreviewRuntime } = await import('/src/model/state.ts');
    const runtime = new PreviewRuntime(localStorage);
    let next;
    let childId;
    runtime.change((snapshot) => {
      snapshot.settings.theme = theme;
      next = snapshot.sessions.find((s) => s.id !== 'session1').id;
      const agent = snapshot.agents.find((a) => a.sessionId === 'session1');
      agent.name = 'source-child';
      childId = agent.id;
      const childSession = structuredClone(
        snapshot.sessions.find((s) => s.id === 'session1'),
      );
      childSession.id = agent.id;
      childSession.name = 'source child conversation';
      snapshot.sessions.push(childSession);
      agent.resourceSessionId = agent.id;
      agent.readOnly = true;
      agent.workspaceId = snapshot.sessions.find(
        (s) => s.id === 'session1',
      ).workspaceId;
      agent.task = {
        id: 'source-child-task',
        attempt: 1,
        state: 'failed',
        access: 'write',
        baseline: 'a'.repeat(40),
      };
      agent.messages = Array.from({ length: 100 }, (_, i) => ({
        id: 'child-source-' + i,
        parentId: null,
        role: 'assistant',
        at: '10:24',
        text: `Child evidence ${i}: [README source](README.md#L2)`,
      }));
    });
    runtime.change((snapshot) => {
      const source = snapshot.agents.find((a) => a.name === 'source-child');
      const unknown = structuredClone(source);
      unknown.id = 'unknown-agent';
      unknown.name = 'unknown-child';
      delete unknown.workspaceId;
      const outside = structuredClone(source);
      outside.id = 'outside-agent';
      outside.name = 'outside-child';
      outside.workspaceId = 'independent-child-worktree';
      snapshot.agents.push(unknown, outside);
    });
    return { second: next, childId };
  }, process.env.CIRCLE_AGENT_SOURCE_THEME ?? 'dark');
  await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const openBySearch = async () => {
    await page.keyboard.press('ControlOrMeta+p');
    const input = page.getByRole('textbox', {
      name: 'global search',
      exact: true,
    });
    await input.fill('README.md');
    await input.press('Enter');
    await page
      .locator('.file-view-heading strong')
      .getByText('README.md', { exact: true })
      .waitFor();
  };
  const openAgent = async (name) => {
    const toggle = page.getByRole('button', {
      name: 'activity panel',
      exact: true,
    });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    await page.locator('.activity-row').filter({ hasText: name }).click();
  };
  const chooseSession = async (id) => {
    const selector = `.sidebar [data-row-key="recent:${id}"] .session-link[href="#/session/${id}"]`;
    if (!(await page.locator(selector).isVisible()))
      await page
        .getByRole('button', { name: 'show or hide the sidebar', exact: true })
        .click();
    await page.locator(selector + ':visible').click();
  };
  const close = () =>
    page
      .locator('.file-view')
      .getByRole('button', { name: 'close file', exact: true })
      .click();
  const message = page.getByRole('textbox', { name: 'message', exact: true });
  await message.fill('PARENT_DRAFT_RETAIN');
  await openBySearch();
  await close();
  assert.equal(await message.inputValue(), 'PARENT_DRAFT_RETAIN');
  assert.equal(
    await page.locator('.agent-record').count(),
    0,
    'parent source returns to parent',
  );
  await openAgent('source-child');
  const record = page.locator('.agent-record');
  await record
    .locator('header .status')
    .getByText('failed', { exact: true })
    .waitFor();
  await record
    .locator('header strong')
    .getByText('source-child', { exact: true })
    .waitFor();
  const link = record
    .getByRole('link', { name: 'README source', exact: true })
    .nth(60);
  await link.scrollIntoViewIfNeeded();
  const body = record.locator('.agent-record-body');
  const before = await body.evaluate((node) => {
    window.childRecordNode = node;
    return node.scrollTop;
  });
  assert.ok(before > 0);
  await link.click();
  await page
    .locator('.file-view-heading strong')
    .getByText('README.md', { exact: true })
    .waitFor();
  await close();
  await record
    .locator('header strong')
    .getByText('source-child', { exact: true })
    .waitFor();
  assert.equal(
    await body.evaluate((node) => node === window.childRecordNode),
    true,
    'source navigation preserves child DOM',
  );
  assert.ok(
    Math.abs((await body.evaluate((node) => node.scrollTop)) - before) <= 2,
    'source close restores child reading position',
  );
  await record
    .getByRole('button', { name: 'open task conversation', exact: true })
    .click();
  await page.waitForURL((url) => url.hash === `#/session/${childId}`);
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  assert.equal(await page.locator('.agent-record').count(), 0);
  await chooseSession('session1');
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  assert.equal(await message.inputValue(), 'PARENT_DRAFT_RETAIN');
  await openAgent('source-child');
  await record.getByRole('button', { name: 'main', exact: true }).click();
  for (const [name, notice] of [
    ['unknown-child', 'source workspace is not available'],
    ['outside-child', 'source workspace is not available'],
  ]) {
    await openAgent(name);
    await page
      .locator('.agent-record')
      .getByRole('link', { name: 'README source', exact: true })
      .first()
      .click();
    await page.getByText(notice, { exact: true }).waitFor();
    assert.equal(
      await page.locator('.file-view').count(),
      0,
      'unverified child cannot read parent same-name file',
    );
    await openBySearch();
    await close();
    assert.equal(
      await record.locator('header strong').textContent(),
      name,
      'parent quick-open keeps the child return origin but does not use its refused resource owner',
    );

    await page
      .locator('.agent-record')
      .getByRole('button', { name: 'main', exact: true })
      .click();
  }
  await openAgent('source-child');
  await openBySearch();
  await chooseSession(second);
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  assert.equal(
    await page.locator('.agent-record').count(),
    0,
    'other session cannot inherit child agent',
  );
  assert.equal(
    await page.locator('.file-view').count(),
    0,
    'other session cannot inherit source file',
  );
  assert.deepEqual(errors, []);
  console.log(
    'pre-App seed loaded actual child; parent/child source return, exact child reading position, parent draft and cross-session isolation passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
