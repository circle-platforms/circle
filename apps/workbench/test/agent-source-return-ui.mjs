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
  const { second, taskId } = await page.evaluate(async (theme) => {
    const { PreviewRuntime } = await import('/src/model/state.ts');
    const runtime = new PreviewRuntime(localStorage);
    let next;
    let taskId;
    runtime.change((snapshot) => {
      snapshot.settings.theme = theme;
      next = snapshot.sessions.find((s) => s.id !== 'session1');
      // A subagent of the parent conversation, reading the parent's workspace through
      // its own session as the runtime projects one. It finished, and failed.
      const agent = snapshot.agents.find((a) => a.sessionId === 'session1');
      agent.name = 'source-child';
      agent.resourceSessionId = agent.id;
      agent.readOnly = true;
      agent.workspaceId = snapshot.sessions.find(
        (s) => s.id === 'session1',
      ).workspaceId;
      agent.status = 'completed';
      agent.activity = 'failed';
      agent.messages = Array.from({ length: 100 }, (_, i) => ({
        id: 'child-source-' + i,
        parentId: null,
        role: 'assistant',
        at: '10:24',
        text: `Child evidence ${i}: [README source](README.md#L2)`,
      }));
      // A task the parent started is not one of the drawer's subagents: its record
      // is a conversation of its own.
      const task = structuredClone(agent);
      task.id = taskId = 'source-task';
      task.name = 'source-task';
      task.resourceSessionId = task.id;
      task.task = {
        id: 'source-child-task',
        attempt: 1,
        state: 'failed',
        access: 'write',
        baseline: 'a'.repeat(40),
      };
      const childSession = structuredClone(
        snapshot.sessions.find((s) => s.id === 'session1'),
      );
      childSession.id = task.id;
      childSession.title = 'source child conversation';
      snapshot.sessions.push(childSession);
      snapshot.agents.push(task);
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
      // The parent's subagent call names each subagent it started: the conversation
      // links to each of them.
      const call = snapshot.sessions
        .find((s) => s.id === 'session1')
        .messages.find((m) => m.tool?.agentId === source.id).tool;
      call.agentIds = [source.id, unknown.id, outside.id];
    });
    return { second: { id: next.id, title: next.title }, taskId };
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
  // A subagent opens in the drawer's subagents mode, its conversation beside the list.
  const record = page.locator('.agent-detail');
  const recordName = record.locator('.agent-title > span');
  const openAgent = async (name) => {
    const toggle = page.getByRole('button', {
      name: 'subagents panel',
      exact: true,
    });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    await page
      .locator('.agent-row')
      .filter({
        has: page.locator('.agent-row-name').getByText(name, { exact: true }),
      })
      .click();
    await recordName.getByText(name, { exact: true }).waitFor();
  };
  // Closing a file leaves the drawer on the files tree; the parent conversation's call
  // that started a subagent leads back to it.
  const backToAgent = async (name) => {
    const links = page.locator('.transcript .tool-agent-links');
    if (!(await links.count()))
      await page
        .locator('.transcript .tool-summary')
        .filter({ hasText: 'ran a subagent' })
        .click();
    await links.getByRole('button').filter({ hasText: name }).click();
    await recordName.getByText(name, { exact: true }).waitFor();
  };
  // The × in the subagent's heading takes it out of the drawer.
  const closeAgent = async () => {
    await record
      .getByRole('button', { name: 'close subagent', exact: true })
      .click();
    await record.waitFor({ state: 'detached' });
  };
  // A document in the drawer folds the sidebar to give it room; search reaches any
  // conversation, a task's own included.
  const searchSession = async (title, id) => {
    await page.keyboard.press('ControlOrMeta+k');
    await page
      .getByRole('textbox', { name: 'global search', exact: true })
      .fill(title);
    await page
      .locator('.search-results button')
      .filter({ has: page.locator('strong').getByText(title, { exact: true }) })
      .click();
    await page.waitForURL((url) => url.hash === `#/session/${id}`);
    await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  };
  const origin = () =>
    page.locator('.file-view .file-source-origin').textContent();
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
  const parentOrigin = await origin();
  await close();
  assert.equal(await message.inputValue(), 'PARENT_DRAFT_RETAIN');
  assert.equal(await record.count(), 0, 'parent source returns to parent');
  await openAgent('source-child');
  // The actual seeded child, as the list shows it: finished, and failed.
  const row = page.locator('.agent-row[aria-current="true"]');
  assert.equal(
    await row.locator('.agent-row-name').textContent(),
    'source-child',
  );
  assert.equal(await row.getAttribute('title'), 'failed');
  assert.equal(
    await row.locator('xpath=ancestor::section[1]/h3').textContent(),
    'finished',
  );
  const link = record
    .getByRole('link', { name: 'README source', exact: true })
    .nth(60);
  await link.scrollIntoViewIfNeeded();
  const body = record.locator('.agent-transcript');
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
  assert.equal(
    await origin(),
    'agent source: source-child',
    "the child's source is read through the child's own session",
  );
  await close();
  await backToAgent('source-child');
  assert.equal(
    await body.evaluate((node) => node === window.childRecordNode),
    true,
    'source navigation preserves child DOM',
  );
  assert.ok(
    Math.abs((await body.evaluate((node) => node.scrollTop)) - before) <= 2,
    'the way back to the child restores its reading position',
  );
  // The conversation of a task the parent started, with the child still open.
  await searchSession('source child conversation', taskId);
  assert.equal(await record.count(), 0);
  await chooseSession('session1');
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  assert.equal(await message.inputValue(), 'PARENT_DRAFT_RETAIN');
  await openAgent('source-child');
  await closeAgent();
  for (const [name, notice] of [
    ['unknown-child', 'source workspace is not available'],
    ['outside-child', 'source workspace is not available'],
  ]) {
    await openAgent(name);
    const childView = await body.elementHandle();
    await record
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
    assert.equal(
      await origin(),
      parentOrigin,
      "parent quick-open does not use the child's refused resource owner",
    );
    await close();
    await backToAgent(name);
    assert.equal(
      await body.evaluate((node, kept) => node === kept, childView),
      true,
      'parent quick-open keeps the child return origin',
    );
    await closeAgent();
  }
  await openAgent('source-child');
  await openBySearch();
  await searchSession(second.title, second.id);
  assert.equal(
    await record.count(),
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
    'pre-App seed loaded actual child; parent/child source owners, exact child reading position, parent draft and cross-session isolation passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
