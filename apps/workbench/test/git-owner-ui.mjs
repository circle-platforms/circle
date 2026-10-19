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
let holdGitStatus = false,
  releaseGitStatus;
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
  server: { host: '127.0.0.1', port: 0, hmr: false },
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
            if (p.service === 'git' && p.method === 'status' && holdGitStatus)
              await new Promise((r) => (releaseGitStatus = r));
            if (p.service === 'git')
              data = await repos
                .get(command.sessionId)
                .call(p.method, p.params);
            else if (p.service === 'terminal' && p.method === 'list') data = [];
            else throw Error('unexpected service');
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
  // A file chosen while a refresh is still running opens once it finishes.
  holdGitStatus = true;
  await git
    .getByRole('button', { name: 'refresh', exact: true })
    .first()
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('.native-git')?.getAttribute('aria-busy') ===
      'true',
  );
  await git
    .getByRole('tree', { name: 'changed files', exact: true })
    .getByRole('treeitem', { name: 'dirty-a.txt', exact: true })
    .click();
  assert.equal(
    await git
      .getByLabel('git diff', { exact: true })
      .filter({ hasText: 'owned a' })
      .count(),
    0,
    'the diff waits for the running refresh',
  );
  holdGitStatus = false;
  releaseGitStatus();
  await git
    .getByLabel('git diff', { exact: true })
    .filter({ hasText: 'owned a' })
    .waitFor();
  receipt.fileChosenWhileBusyOpens = true;
  const commitMessage = () =>
    git.getByRole('textbox', { name: 'commit message', exact: true });
  await commitMessage().fill('commit draft A');
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
      await commitMessage().isEnabled(),
      false,
      'Home cannot mutate the previous owner through its retained panel',
    );
    assert.equal(await commitMessage().inputValue(), 'commit draft A');
    assert(
      (
        await page
          .locator('.inspector')
          .getByRole('status')
          .filter({ hasText: repos.get('a').root })
          .innerText()
      ).includes(repos.get('a').root),
    );
    assert.equal(
      calls
        .slice(before)
        .some(
          (c) =>
            c.payload.service === 'git' &&
            !['status', 'snapshot', 'diff', 'branches', 'history'].includes(
              c.payload.method,
            ),
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
  assert.equal(await commitMessage().inputValue(), '');
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
  await select('a');
  assert.equal(await commitMessage().inputValue(), 'commit draft A');
  const longMessage = Array.from(
    { length: 600 },
    (_, index) => `part ${index + 1}: 中文 commit recovery text`,
  ).join(' ');
  await commitMessage().fill(longMessage);
  const inspectDrafts = async () => {
    assert.equal(await commitMessage().inputValue(), longMessage);
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
    await commitMessage().waitFor();
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
  assert(saved.length >= 1);
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
  const storageWarning = () =>
    git
      .getByRole('status')
      .filter({ hasText: 'local draft storage is unavailable' });
  await commitMessage().fill('unsaved current input');
  assert.equal(await commitMessage().inputValue(), 'unsaved current input');
  await storageWarning().waitFor();
  await select('b');
  assert.equal(await commitMessage().inputValue(), '');
  assert.equal(await storageWarning().count(), 0);
  await select('a');
  assert.equal(await commitMessage().inputValue(), 'unsaved current input');
  await storageWarning().waitFor();
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__restoreOwnerStorage;
    delete window.__restoreOwnerStorage;
  });
  await commitMessage().fill('saved after recovery');
  assert.equal(await storageWarning().count(), 0);
  await select('b');
  assert.equal(await commitMessage().inputValue(), '');
  receipt.draftRecovery = {
    reload: true,
    newRendererContextFromPersistedProfile: true,
    fullView: true,
    closePanel: true,
    messageParts: 600,
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
