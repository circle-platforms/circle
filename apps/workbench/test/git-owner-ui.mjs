import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { GitWorkspaceService } from '../../desktop/src/workspace/git.ts';
const directory = await mkdtemp(join(tmpdir(), 'circle-git-owner-'));
const output =
  process.env.CIRCLE_GIT_OWNER_EVIDENCE ??
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-git-owner-evidence-')));
await mkdir(output, { recursive: true });
const repos = new Map(),
  calls = [];
let hold = false,
  release,
  holdStatus = false,
  releaseStatus;
for (const id of ['a', 'b']) {
  const path = join(directory, id);
  await mkdir(path);
  const git = new GitWorkspaceService(path);
  repos.set(id, git);
  await git.git(['init', '-b', 'owner-' + id]);
  await writeFile(join(path, 'base.txt'), 'base ' + id);
  await git.git(['add', 'base.txt']);
  await git.git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Baseline',
  ]);
  await writeFile(join(path, 'dirty-' + id + '.txt'), 'owned ' + id);
}
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
  plugins: [
    {
      name: 'actual-owned-git',
      configureServer(server) {
        server.middlewares.use('/owner-fixture', (_req, res) =>
          res.end(
            JSON.stringify({
              workspaces: [...repos].map(([id, git]) => ({
                id,
                name: 'project ' + id,
                path: git.root,
                branch: 'owner-' + id,
                trusted: true,
                kind: 'project',
                origin: 'native',
                instructions: [],
              })),
            }),
          ),
        );
        server.middlewares.use('/owner-command', async (req, res) => {
          let body = '';
          for await (const chunk of req) body += chunk;
          const command = JSON.parse(body);
          calls.push(command);
          try {
            const p = command.payload;
            let data;
            if (p.service === 'git')
              data = await repos
                .get(command.sessionId)
                .call(p.method, p.params);
            else if (p.service === 'terminal' && p.method === 'list') data = [];
            else if (p.service === 'delivery') {
              if (
                p.method === 'status' &&
                command.sessionId === 'a' &&
                holdStatus
              ) {
                await new Promise((r) => (releaseStatus = r));
                throw Error('late status failure a');
              }
              if (p.method === 'publish') {
                if (hold) await new Promise((r) => (release = r));
                throw Error('owned publish failure ' + command.sessionId);
              }
              data = p.method === 'checks' ? [] : { pullRequest: null };
            } else throw Error('unexpected service');
            res.end(JSON.stringify({ ok: true, data }));
          } catch (error) {
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          }
        });
      },
    },
  ],
});
await server.listen();
let browser, page;
const receipt = {};
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.goto(
    server.resolvedUrls.local[0] + 'test/git-owner-ui.html#/session/a',
  );
  await page
    .getByRole('button', { name: 'changes panel', exact: true })
    .click();
  await page.locator('#inspector-changes-tab-git').click();
  let git = page.locator('.native-git:visible');
  await page.waitForFunction(
    () =>
      document.querySelector('.native-git')?.getAttribute('data-branch') ===
      'owner-a',
  );
  await git
    .getByRole('textbox', { name: 'commit message', exact: true })
    .fill('commit draft A');
  let delivery = git.locator('.native-delivery');
  await delivery.locator(':scope > summary').click();
  await delivery
    .getByRole('textbox', { name: 'PR title', exact: true })
    .fill('draft A');
  await delivery
    .getByRole('textbox', { name: 'PR description', exact: true })
    .fill('body A');
  await delivery
    .getByRole('button', { name: 'publish draft PR', exact: true })
    .click();
  await delivery
    .getByRole('alert')
    .filter({ hasText: 'owned publish failure a' })
    .waitFor();
  if (process.env.CIRCLE_GIT_OWNER_CASE !== 'state') {
    const before = calls.length;
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'new session', exact: true })
      .click();
    const home = page.locator('.home');
    await home.waitFor();
    await home
      .getByRole('button', { name: 'choose a project', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'project b', exact: true })
      .click();
    await page.waitForFunction(() => location.hash.includes('workspace=b'));
    await page.screenshot({ path: join(output, 'home-other-project.png') });
    assert.equal(
      await delivery
        .getByRole('button', { name: 'publish draft PR', exact: true })
        .isEnabled(),
      false,
      'Home cannot mutate the previous owner through its retained panel',
    );
    assert(
      (await page.locator('.inspector [role=status]').innerText()).includes(
        repos.get('a').root,
      ),
    );
    assert.equal(
      await delivery
        .getByRole('textbox', { name: 'PR title', exact: true })
        .inputValue(),
      'draft A',
    );
    assert.equal(
      calls
        .slice(before)
        .some(
          (c) =>
            c.payload.service === 'delivery' && c.payload.method === 'publish',
        ),
      false,
    );
  }
  const select = async (id) => {
    await page
      .locator(`.sidebar .session-link[href="#/session/${id}"]`)
      .first()
      .click();
    await page.waitForFunction((id) => location.hash === '#/session/' + id, id);
    await page.waitForFunction(
      (id) =>
        document.querySelector('.native-git')?.getAttribute('data-branch') ===
        'owner-' + id,
      id,
    );
  };
  await select('b');
  const ownerStatusDeadline = Date.now() + 8000;
  while (
    !calls.some(
      (command) =>
        command.sessionId === 'b' &&
        command.payload.service === 'delivery' &&
        command.payload.method === 'status',
    )
  ) {
    assert(Date.now() < ownerStatusDeadline);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    await git
      .getByRole('textbox', { name: 'commit message', exact: true })
      .inputValue(),
    '',
  );
  await git.getByRole('checkbox', { name: 'dirty-b.txt', exact: true }).check();
  await git
    .getByRole('button', { name: 'stage selected', exact: true })
    .click();
  const stageDeadline = Date.now() + 8000;
  while (
    (await repos.get('b').git(['diff', '--cached', '--name-only'])).trim() !==
    'dirty-b.txt'
  ) {
    assert(Date.now() < stageDeadline);
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(
    (await repos.get('a').git(['diff', '--cached', '--name-only'])).trim(),
    '',
  );
  await git
    .getByRole('button', { name: 'unstage selected', exact: true })
    .click();
  const unstageDeadline = Date.now() + 8000;
  while (
    (await repos.get('b').git(['diff', '--cached', '--name-only'])).trim() !==
    ''
  ) {
    assert(Date.now() < unstageDeadline);
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(
    await delivery
      .getByRole('textbox', { name: 'PR title', exact: true })
      .inputValue(),
    '',
  );
  assert.equal(
    await delivery
      .getByRole('textbox', { name: 'PR description', exact: true })
      .inputValue(),
    '',
  );
  assert.equal(await delivery.getByRole('alert').count(), 0);
  await delivery
    .getByRole('textbox', { name: 'PR title', exact: true })
    .fill('draft B');
  await select('a');
  assert.equal(
    await git
      .getByRole('textbox', { name: 'commit message', exact: true })
      .inputValue(),
    'commit draft A',
  );
  assert.equal(
    await delivery
      .getByRole('textbox', { name: 'PR title', exact: true })
      .inputValue(),
    'draft A',
  );
  assert.equal(
    await delivery
      .getByRole('textbox', { name: 'PR description', exact: true })
      .inputValue(),
    'body A',
  );
  hold = true;
  await delivery
    .getByRole('button', { name: 'publish draft PR', exact: true })
    .click();
  const heldDeadline = Date.now() + 8000;
  while (!release) {
    assert(Date.now() < heldDeadline);
    await new Promise((r) => setTimeout(r, 5));
  }
  await select('b');
  const pendingResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/owner-command') &&
      response.request().postDataJSON()?.payload.method === 'publish',
  );
  release();
  await (await pendingResponse).finished();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await delivery
      .getByRole('textbox', { name: 'PR title', exact: true })
      .inputValue(),
    'draft B',
  );
  assert.equal(
    await delivery.getByRole('alert').count(),
    0,
    'late A errors cannot appear in B',
  );
  await select('a');
  holdStatus = true;
  await delivery
    .getByRole('button', { name: 'refresh status', exact: true })
    .click();
  const statusDeadline = Date.now() + 8000;
  while (!releaseStatus) {
    assert(Date.now() < statusDeadline);
    await new Promise((r) => setTimeout(r, 5));
  }
  await select('b');
  const statusResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/owner-command') &&
      response.request().postDataJSON()?.sessionId === 'a' &&
      response.request().postDataJSON()?.payload.method === 'status',
  );
  releaseStatus();
  await (await statusResponse).finished();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await delivery.getByRole('alert').count(),
    0,
    'late original-owner status errors cannot enter the new owner',
  );
  hold = false;
  holdStatus = false;
  await select('a');
  const longBody =
    Array.from(
      { length: 600 },
      (_, index) => `line ${index + 1}: 中文 PR recovery text`,
    ).join('\n') + '\n';
  await delivery
    .getByRole('textbox', { name: 'PR description', exact: true })
    .fill(longBody);
  const inspectDrafts = async () => {
    assert.equal(
      await git
        .getByRole('textbox', { name: 'commit message', exact: true })
        .inputValue(),
      'commit draft A',
    );
    assert.equal(
      await delivery
        .getByRole('textbox', { name: 'PR title', exact: true })
        .inputValue(),
      'draft A',
    );
    assert.equal(
      await delivery
        .getByRole('textbox', { name: 'PR description', exact: true })
        .inputValue(),
      longBody,
    );
  };
  const reopenGit = async () => {
    const toggle = page.getByRole('button', {
      name: 'changes panel',
      exact: true,
    });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    await page.locator('#inspector-changes-tab-git').click();
    git = page.locator('.native-git:visible');
    delivery = git.locator('.native-delivery');
    if (!(await delivery.evaluate((node) => node.open)))
      await delivery.locator(':scope > summary').click();
    await git
      .getByRole('textbox', { name: 'commit message', exact: true })
      .waitFor();
  };
  await page
    .getByRole('button', { name: 'changes panel', exact: true })
    .click();
  await reopenGit();
  await inspectDrafts();
  await page
    .getByRole('button', { name: 'terminal panel', exact: true })
    .click();
  await page
    .locator('.inspector-title')
    .getByRole('button', { name: 'full view', exact: true })
    .click();
  await page.locator('.inspector-full .inspector').waitFor();
  await page
    .locator('.inspector-title')
    .getByRole('button', { name: 'exit full view', exact: true })
    .click();
  await reopenGit();
  await inspectDrafts();
  await page.reload();
  await reopenGit();
  await inspectDrafts();
  assert.equal(
    await delivery.getByRole('alert').count(),
    0,
    'errors are not restored as drafts',
  );
  const persistedProfile = await page.context().storageState();
  await page.context().close();
  const restoredContext = await browser.newContext({
    storageState: persistedProfile,
    viewport: { width: 1400, height: 900 },
  });
  page = await restoredContext.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(
    server.resolvedUrls.local[0] + 'test/git-owner-ui.html#/session/a',
  );
  await reopenGit();
  await inspectDrafts();
  const saved = await page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith('circle.workbench.owner-draft.v1:'))
      .map(([, value]) => JSON.parse(value)),
  );
  assert(saved.length >= 4);
  for (const item of saved)
    assert.deepEqual(Object.keys(item).sort(), [
      'field',
      'owner',
      'text',
      'version',
    ]);
  await page.evaluate(() => {
    window.__restoreOwnerStorage = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('circle.workbench.owner-draft.v1:'))
        throw new DOMException('fixture quota', 'QuotaExceededError');
      return window.__restoreOwnerStorage.call(this, key, value);
    };
  });
  await delivery
    .getByRole('textbox', { name: 'PR title', exact: true })
    .fill('unsaved current input');
  assert.equal(
    await delivery
      .getByRole('textbox', { name: 'PR title', exact: true })
      .inputValue(),
    'unsaved current input',
  );
  await delivery
    .getByRole('status')
    .filter({ hasText: 'local draft storage is unavailable' })
    .waitFor();
  await select('b');
  assert.equal(
    await delivery
      .getByRole('textbox', { name: 'PR title', exact: true })
      .inputValue(),
    'draft B',
  );
  assert.equal(
    await delivery
      .getByRole('status')
      .filter({ hasText: 'local draft storage is unavailable' })
      .count(),
    0,
  );
  await select('a');
  assert.equal(
    await delivery
      .getByRole('textbox', { name: 'PR title', exact: true })
      .inputValue(),
    'unsaved current input',
  );
  await delivery
    .getByRole('status')
    .filter({ hasText: 'local draft storage is unavailable' })
    .waitFor();
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__restoreOwnerStorage;
    delete window.__restoreOwnerStorage;
  });
  await delivery
    .getByRole('textbox', { name: 'PR title', exact: true })
    .fill('saved after recovery');
  assert.equal(
    await delivery
      .getByRole('status')
      .filter({ hasText: 'local draft storage is unavailable' })
      .count(),
    0,
  );
  await select('b');
  if (!(await delivery.evaluate((node) => node.open)))
    await delivery.locator(':scope > summary').click();
  assert.equal(
    await delivery
      .getByRole('textbox', { name: 'PR title', exact: true })
      .inputValue(),
    'draft B',
  );
  receipt.draftRecovery = {
    reload: true,
    newRendererContextFromPersistedProfile: true,
    fullView: true,
    closePanel: true,
    bodyLines: 600,
    quotaFailureKeepsInputAndWarns: true,
    noBusyErrorOrCredentialsPersisted: true,
  };
  for (const [id, repo] of repos) {
    assert.equal(
      (await repo.git(['diff', '--cached', '--name-only'])).trim(),
      '',
    );
    assert.equal(
      await readFile(join(repo.root, 'dirty-' + id + '.txt'), 'utf8'),
      'owned ' + id,
    );
    assert.equal(
      (await repo.git(['branch', '--show-current'])).trim(),
      'owner-' + id,
    );
  }
  assert.equal(
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue(),
    'composer b',
  );
  receipt.passed = true;
  receipt.calls = calls.map((c) => ({
    owner: c.sessionId,
    service: c.payload.service,
    method: c.payload.method,
  }));
  await page.screenshot({ path: join(output, 'second-owner.png') });
} catch (error) {
  receipt.passed = false;
  receipt.error = String(error);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
  await browser?.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
