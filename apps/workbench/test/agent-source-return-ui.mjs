import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.resolvedUrls.local[0] + '#/session/session1');
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  const second = await page.evaluate(async () => {
    const { PreviewRuntime } = await import('/src/model/state.ts');
    const runtime = new PreviewRuntime(localStorage);
    let next;
    runtime.change((snapshot) => {
      next = snapshot.sessions.find((s) => s.id !== 'session1').id;
      const agent = snapshot.agents.find((a) => a.sessionId === 'session1');
      agent.name = 'source-child';
      agent.resourceSessionId = agent.id;
      agent.readOnly = true;
      agent.workspaceId = snapshot.sessions.find(
        (s) => s.id === 'session1',
      ).workspaceId;
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
    return next;
  });
  await page.reload();
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
  await page
    .getByRole('button', { name: 'activity panel', exact: true })
    .click();
  await page
    .locator('.activity-row')
    .filter({ hasText: 'source-child' })
    .click();
  const record = page.locator('.agent-record');
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
  await record.getByRole('button', { name: 'main', exact: true }).click();
  assert.equal(await message.inputValue(), 'PARENT_DRAFT_RETAIN');
  await page
    .locator('.activity-row')
    .filter({ hasText: 'source-child' })
    .click();
  await record.getByRole('button', { name: 'main', exact: true }).click();
  for (const [name, notice] of [
    ['unknown-child', 'source workspace is not available'],
    ['outside-child', 'source workspace is not available'],
  ]) {
    await page.locator('.activity-row').filter({ hasText: name }).click();
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
  await page
    .locator('.activity-row')
    .filter({ hasText: 'source-child' })
    .click();
  await openBySearch();
  await page
    .locator(`.sidebar .session-link[href="#/session/${second}"]`)
    .click();
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
    'parent/child source return, exact child reading position, parent draft and cross-session isolation passed',
  );
} finally {
  await browser?.close();
  await server.close();
}
