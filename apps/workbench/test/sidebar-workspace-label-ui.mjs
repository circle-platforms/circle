import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.addInitScript(() =>
    localStorage.setItem('circle.workbench.language', 'en'),
  );
  await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const fixture = await page.evaluate(async () => {
    const { PreviewRuntime } = await import('/src/model/state.ts');
    const runtime = new PreviewRuntime(localStorage);
    let expected;
    runtime.change((snapshot) => {
      const base = snapshot.sessions.find((row) => row.id === 'session1');
      const workspace = snapshot.workspaces.find(
        (row) => row.id === base.workspaceId,
      );
      const agent = snapshot.agents[0];
      for (const [suffix, name, access, taskId, role] of [
        ['01', 'Login implementation', 'write', 'task-01', 'worker'],
        ['02', 'Login audit', 'readonly', 'task-02', 'worker'],
        [
          '03',
          'review: Login implementation',
          'readonly',
          'task-01',
          'reviewer',
        ],
      ]) {
        const id = 'child-' + suffix,
          workspaceId = 'worktree-' + suffix;
        const directory = 'a0b1c2d3e4f56789012345' + suffix + '-1';
        snapshot.workspaces.push({
          ...workspace,
          id: workspaceId,
          name: directory,
          path: '/isolated/task-worktrees/' + directory,
        });
        snapshot.sessions.push({
          ...structuredClone(base),
          id,
          workspaceId,
          title: 'shared task title',
          readOnly: access === 'readonly',
        });
        snapshot.agents.push({
          ...structuredClone(agent),
          id,
          sessionId: base.id,
          name,
          workspaceId,
          resourceSessionId: id,
          readOnly: access === 'readonly',
          task: {
            role,
            id: taskId,
            attempt: 1,
            state: 'running',
            access,
            baseline: 'abc',
          },
        });
      }
      expected = snapshot.sessions
        .filter((row) => !row.archivedAt)
        .map((row) => row.id);
    });
    return {
      expected,
      seed: localStorage.getItem('circle.workbench.preview.v1'),
    };
  });
  const expected = fixture.expected;
  assert.equal(typeof fixture.seed, 'string');
  // The mounted application's pagehide saves its own older view. Seed the next
  // document before its real PreviewRuntime is constructed, after that save.
  await page.addInitScript((seed) => {
    localStorage.setItem('circle.workbench.preview.v1', seed);
  }, fixture.seed);
  await page.reload();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  // Task worktrees are not folders, and their generated names never show.
  const projectList = await page.locator('.project-list').innerText();
  assert.doesNotMatch(projectList, /a0b1c2d3e4f56789012345/);
  assert.doesNotMatch(projectList, /isolated copy|agent workspace/);
  assert.equal(
    await page.locator('.project-header[title*="task-worktrees"]').count(),
    0,
    'no folder group for a task worktree',
  );
  const tasks = ['child-01', 'child-02'];
  const top = expected.filter((id) => !id.startsWith('child-'));
  const recent = page.locator('.sidebar .project').filter({
    has: page.getByRole('button', { name: 'recent', exact: true }),
  });
  const moreRecent = recent.getByRole('button', {
    name: /^show \d+ more$/,
  });
  if (await moreRecent.count()) await moreRecent.click();
  const routes = (locator) =>
    locator.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('href').split('/').at(-1)),
    );
  const workspaceRows =
    '.sidebar .session-row:not([data-row-key^="recent:"]):not(.task-row)';
  assert.deepEqual(
    [...(await routes(page.locator(workspaceRows).getByRole('link')))].sort(),
    [...top].sort(),
    'every conversation stays in its folder; task conversations fold under their owner',
  );
  assert.deepEqual(
    [
      ...(await routes(
        recent.locator('.session-row:not(.task-row)').getByRole('link'),
      )),
    ].sort(),
    [...top].sort(),
    'recent lists the conversations, not their tasks',
  );
  assert.equal(
    await page.locator('.sidebar .task-row').count(),
    0,
    'tasks start folded while their owner is open',
  );
  // The owner row in its folder folds its two tasks; the reviewer is not a third.
  const folder = page
    .locator('.sidebar .project')
    .filter({
      hasNot: page.getByRole('button', { name: 'recent', exact: true }),
    })
    .filter({ has: page.locator('[data-row-key$=":session1"]') });
  const toggle = folder.getByRole('button', { name: '2 tasks', exact: true });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  const taskRows = folder.locator('.session-tasks .task-row');
  assert.deepEqual(
    [...(await routes(taskRows.getByRole('link')))].sort(),
    tasks,
    'the worker of each task is listed; its reviewer stays out of the sidebar',
  );
  assert.equal(
    await page.locator('.sidebar [href="#/session/child-03"]').count(),
    0,
  );
  for (const [id, name] of [
    ['child-01', 'Login implementation'],
    ['child-02', 'Login audit'],
  ]) {
    const link = taskRows
      .getByRole('link', { name, exact: true })
      .and(page.locator(`[href="#/session/${id}"]`));
    assert.equal(
      await link.locator('span').first().textContent(),
      name,
      'a task row names its task, not a short id',
    );
    assert.equal(
      await page.evaluate(
        (id) =>
          JSON.parse(
            localStorage.getItem('circle.workbench.preview.v1'),
          ).sessions.find((row) => row.id === id).title,
        id,
      ),
      'shared task title',
      'the session title stays unchanged',
    );
    await link.click();
    await page.waitForFunction((id) => location.hash === '#/session/' + id, id);
    // The sidebar marks the opened task once it has rendered the new route.
    await folder
      .locator(`.task-row .session-link.active[href="#/session/${id}"]`)
      .waitFor();
    assert.equal(
      await folder.locator('.task-row .session-link.active').count(),
      1,
    );
    // Recent opens its own task list while one of its tasks is the open session.
    assert.equal(
      await recent
        .locator('.task-row .session-link.active')
        .getAttribute('href'),
      '#/session/' + id,
      'recent and folder rows reflect the same selected route',
    );
  }
  // The reviewer's conversation still opens by its route.
  await page.evaluate(() => (location.hash = '#/session/child-03'));
  await page.waitForFunction(() => location.hash === '#/session/child-03');
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  console.log(
    'actual Sidebar folds task conversations under their owner, hides task worktrees and reviewers, and keeps every session route',
  );
} finally {
  await browser?.close();
  await server.close();
}
