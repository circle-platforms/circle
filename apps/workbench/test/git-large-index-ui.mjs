import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspaceService } from '../../desktop/src/workspace/git.ts';
import { validateWorkspaceRequest } from '../../desktop/src/workspace-protocol.ts';

// The scale sample is a real immutable Git commit. Its 10k files stay clean,
// so native snapshots need to fingerprint only the two explicitly dirty files.
const repo = await mkdtemp(join(tmpdir(), 'circle-git-large-index-'));
const git = new GitWorkspaceService(repo);
const calls = [];
let server, browser;
try {
  await git.git(['init', '-b', 'main']);
  await git.git(['config', 'core.autocrlf', 'false']);
  const content = 'baseline\n',
    subject = 'Large baseline\n';
  const paths = [
    'first.txt',
    'second.txt',
    ...Array.from(
      { length: 10000 },
      (_, i) =>
        `bulk/group-${String(Math.floor(i / 250)).padStart(2, '0')}/file-${String(i).padStart(5, '0')}.txt`,
    ),
  ];
  await git.git(
    ['fast-import', '--quiet'],
    `blob\nmark :1\ndata ${Buffer.byteLength(content)}\n${content}\ncommit refs/heads/main\ncommitter Circle Test <fixture@example.invalid> 1700000000 +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\n${paths.map((path) => `M 100644 :1 ${path}`).join('\n')}\n\ndone\n`,
  );
  await git.git(['reset', '--hard', 'HEAD']);
  await writeFile(join(repo, 'first.txt'), 'FIRST\n');
  await writeFile(join(repo, 'second.txt'), 'SECOND\n');
  const originalHead = (await git.git(['rev-parse', 'HEAD'])).trim();
  const beforeHistoryIndex = await readFile(join(repo, '.git/index'));
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, hmr: false },
    logLevel: 'error',
    plugins: [
      {
        name: 'real-large-git-fixture',
        configureServer(host) {
          host.middlewares.use('/test-git-command', async (req, res) => {
            let body = '';
            for await (const chunk of req) body += chunk;
            const command = JSON.parse(body);
            calls.push(command);
            try {
              const request = validateWorkspaceRequest(command.payload);
              assert.equal(request.service, 'git');
              res.end(
                JSON.stringify({
                  ok: true,
                  data: await git.call(request.method, request.params),
                }),
              );
            } catch (error) {
              res.end(JSON.stringify({ ok: false, error: String(error) }));
            }
          });
        },
      },
    ],
  });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'test/git-continuity-ui.html');
  const panel = page.locator('.native-git');
  const idle = () =>
    page.waitForFunction(
      () =>
        document.querySelector('.native-git')?.getAttribute('aria-busy') ===
        'false',
    );
  const first = page.getByRole('checkbox', { name: 'first.txt', exact: true });
  await first.check();
  await page
    .getByRole('textbox', { name: 'commit message', exact: true })
    .fill('keep my draft');
  const index = panel.locator('[data-context-index-resource="git"]');
  const resizer = index.getByRole('separator', {
    name: 'resize context index',
  });
  const initialWidth = Number(await resizer.getAttribute('aria-valuenow'));
  const beforeResizeCalls = calls.length;
  await resizer.focus();
  await resizer.press('ArrowLeft');
  const keyboardWidth = Number(await resizer.getAttribute('aria-valuenow'));
  assert.equal(keyboardWidth, initialWidth + 16);
  const handle = await resizer.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 15);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 64, handle.y + 15, {
    steps: 4,
  });
  await page.mouse.up();
  const preferredWidth = Number(await resizer.getAttribute('aria-valuenow'));
  assert.ok(
    preferredWidth > keyboardWidth,
    'pointer drag changes the index, not the outer drawer',
  );
  assert.equal(
    calls.length,
    beforeResizeCalls,
    'resizing makes no runtime call',
  );
  assert.equal(await first.isChecked(), true);
  assert.equal(
    await page
      .getByRole('textbox', { name: 'commit message', exact: true })
      .inputValue(),
    'keep my draft',
  );
  await page.evaluate(() => window.__gitSetSession('another-owner'));
  await idle();
  assert.equal(
    Number(await resizer.getAttribute('aria-valuenow')),
    initialWidth,
    'another owner gets its own preference',
  );
  await page.evaluate(() => window.__gitSetSession('continuity'));
  await idle();
  assert.equal(
    Number(await resizer.getAttribute('aria-valuenow')),
    preferredWidth,
  );
  assert.equal(await first.isChecked(), true);
  const historyStart = calls.length;
  await panel
    .locator('summary')
    .filter({ hasText: /^commits$/ })
    .click();
  await panel
    .locator('.native-git-commits button')
    .filter({ hasText: 'Large baseline' })
    .click();
  await idle();
  assert.equal(await panel.getAttribute('data-commit'), originalHead);
  await panel
    .getByRole('note')
    .filter({ hasText: 'select a file to inspect this large comparison' })
    .waitFor();
  const tree = panel.getByRole('tree', { name: 'changed files' });
  assert.ok(
    (await tree.getByRole('treeitem').count()) < 45,
    '10k actual changed files use bounded row DOM',
  );
  assert.ok(
    (await panel.locator('*').count()) < 600,
    'whole-comparison view does not mount 70k diff lines',
  );
  await tree.focus();
  const beforeArrows = calls.length;
  await tree.press('End');
  const active = await tree.getAttribute('aria-activedescendant');
  assert.equal(
    await page.locator(`[id="${active}"]`).getAttribute('data-path'),
    'second.txt',
  );
  assert.equal(
    await page.locator(`[id="${active}"]`).getAttribute('aria-setsize'),
    '3',
  );
  assert.equal(
    calls.length,
    beforeArrows,
    'arrow navigation never reads or mutates files',
  );
  assert.ok((await tree.getByRole('treeitem').count()) < 45);
  await tree.press('Home');
  await tree.press('ArrowLeft');
  assert.equal(
    await tree.getByRole('treeitem').count(),
    3,
    'folding removes descendants from the visible model',
  );
  const filter = panel.getByRole('searchbox', { name: 'filter changed files' });
  const beforeFilter = calls.length;
  await filter.fill('file-09999');
  const target = tree.getByRole('treeitem', {
    name: 'bulk/group-39/file-09999.txt',
    exact: true,
  });
  await target.waitFor();
  assert.equal(await target.getAttribute('aria-level'), '3');
  assert.equal(calls.length, beforeFilter, 'filtering remains local');
  await tree.getByRole('treeitem', { name: 'bulk', exact: true }).click();
  await filter.fill('');
  assert.equal(
    await tree.getByRole('treeitem').count(),
    3,
    'filtering retains the prior collapsed folders',
  );
  await filter.fill('file-09999');
  await target.click();
  await idle();
  assert.match(
    await panel.getByLabel('git diff', { exact: true }).innerText(),
    /\+baseline/,
  );
  assert.match(await target.innerText(), /\+1/);
  assert.equal(
    await panel.getByRole('checkbox').count(),
    0,
    'historical files remain readonly',
  );
  const toggle = panel
    .locator('header.inspector-heading')
    .getByRole('button', { name: 'change index', exact: true });
  const beforeToggle = calls.length;
  await toggle.click();
  assert.equal(await index.isVisible(), false);
  await toggle.click();
  assert.equal(await filter.inputValue(), 'file-09999');
  assert.equal(
    Number(await resizer.getAttribute('aria-valuenow')),
    preferredWidth,
  );
  assert.equal(calls.length, beforeToggle);
  await page.setViewportSize({ width: 500, height: 1000 });
  await page.waitForFunction(() =>
    document
      .querySelector('[data-context-index-resource="git"]')
      ?.hasAttribute('data-index-overlay'),
  );
  assert.equal(await filter.inputValue(), 'file-09999');
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[data-context-index-resource="git"]')
        ?.hasAttribute('data-index-overlay'),
  );
  assert.deepEqual(
    await readFile(join(repo, '.git/index')),
    beforeHistoryIndex,
  );
  assert.equal((await git.git(['rev-parse', 'HEAD'])).trim(), originalHead);
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'FIRST\n');
  assert.equal(await readFile(join(repo, 'second.txt'), 'utf8'), 'SECOND\n');
  assert.ok(
    calls
      .slice(historyStart)
      .every((call) => ['history', 'commitDiff'].includes(call.payload.method)),
    'historical navigation uses only readonly methods',
  );
  await panel.getByRole('button', { name: 'unstaged', exact: true }).click();
  await idle();
  await filter.fill('');
  assert.equal(
    await first.isChecked(),
    true,
    'virtualized historical browsing retains only explicit operation paths',
  );
  await tree.getByRole('treeitem', { name: 'second.txt', exact: true }).click();
  await idle();
  assert.equal(await first.isChecked(), true);
  assert.equal(
    await page
      .getByRole('checkbox', { name: 'second.txt', exact: true })
      .isChecked(),
    false,
  );
  await panel
    .getByRole('button', { name: 'stage selected', exact: true })
    .click();
  await idle();
  assert.equal(
    (await git.git(['diff', '--cached', '--name-only'])).trim(),
    'first.txt',
  );
  assert.equal(await git.git(['show', ':first.txt']), 'FIRST\n');
  assert.equal(await git.git(['show', ':second.txt']), 'baseline\n');
  assert.deepEqual(
    calls
      .filter((call) => call.payload.method === 'stage')
      .map((call) => call.payload.params.paths),
    [['first.txt']],
  );
  assert.deepEqual(errors, []);
  console.log(
    'real 10,002-file Git commit: bounded tree DOM, keyboard/filter/folding, isolated resizing, readonly history and explicit stage targets passed',
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(repo, { recursive: true, force: true });
}
