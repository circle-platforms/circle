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
  const expected = await page.evaluate(async () => {
    const { PreviewRuntime } = await import('/src/model/state.ts');
    const runtime = new PreviewRuntime(localStorage);
    let expected;
    runtime.change((snapshot) => {
      const base = snapshot.sessions.find((row) => row.id === 'session1');
      const workspace = snapshot.workspaces.find(
        (row) => row.id === base.workspaceId,
      );
      const agent = snapshot.agents[0];
      for (const [suffix, name, access] of [
        ['01', 'Login implementation', 'write'],
        ['02', 'Login review', 'readonly'],
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
            id: 'task-' + suffix,
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
    return expected;
  });
  await page.reload();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  for (const name of ['Login implementation', 'Login review'])
    await page
      .locator('.project-name')
      .getByText('agent workspace: ' + name, { exact: true })
      .waitFor();
  assert.doesNotMatch(
    await page.locator('.project-list').innerText(),
    /a0b1c2d3e4f56789012345/,
  );
  const ids = await page
    .locator('.sidebar .session-link')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('href').split('/').at(-1)),
    );
  assert.deepEqual(
    [...ids].sort(),
    [...expected].sort(),
    'all existing and task session routes remain visible',
  );
  for (const id of ['child-01', 'child-02']) {
    const link = page.locator(`.sidebar .session-link[href="#/session/${id}"]`);
    assert.equal(
      await link.locator('span').textContent(),
      'shared task title',
      'session title stays unchanged; no guessed role',
    );
    await link.click();
    await page.waitForFunction((id) => location.hash === '#/session/' + id, id);
    assert.equal(
      await page.locator('.sidebar .session-link.active').getAttribute('href'),
      '#/session/' + id,
    );
  }
  console.log(
    'actual Sidebar generated workspace labels, duplicate session titles and all exact session routes preserved',
  );
} finally {
  await browser?.close();
  await server.close();
}
