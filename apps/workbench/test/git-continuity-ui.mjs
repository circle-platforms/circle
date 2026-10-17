import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspaceService } from '../../desktop/src/workspace/git.ts';
const repo = await mkdtemp(join(tmpdir(), 'circle-git-continuity-'));
const git = new GitWorkspaceService(repo, {
  identity: { name: 'Circle Test', email: 'test@example.invalid' },
});
await git.git(['init']);
await git.git(['config', 'user.name', 'Circle Test']);
await git.git(['config', 'user.email', 'test@example.invalid']);
await writeFile(join(repo, 'baseline.txt'), 'baseline');
await git.git(['add', 'baseline.txt']);
await git.git(['commit', '-m', 'Create baseline']);
await writeFile(join(repo, 'first.txt'), 'first change');
const requests = [];
const gates = [];
const deferStatus = () => {
  let release, entered;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = { release, entered, promise, seen };
  gates.push(gate);
  return gate;
};
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
  plugins: [
    {
      name: 'real-git-fixture',
      configureServer(server) {
        server.middlewares.use('/test-git-command', async (req, res) => {
          let body = '';
          for await (const chunk of req) body += chunk;
          const command = JSON.parse(body);
          requests.push(command);
          try {
            const p = command.payload;
            if (p.service !== 'git') throw Error('only git allowed');
            const gate = p.method === 'status' ? gates.shift() : undefined;
            const data = await git.call(p.method, p.params);
            if (gate) {
              gate.entered();
              await gate.promise;
              if (gate.error) throw Error(gate.error);
            }
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
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(`${server.resolvedUrls.local[0]}test/git-continuity-ui.html`);
  assert.equal(
    await page
      .locator('.native-git')
      .getByRole('heading', { name: 'git workspace', exact: true })
      .count(),
    0,
    'embedded Git inherits the existing inspector title',
  );
  assert.ok(
    (await page.locator('.native-git button.button').count()) > 0,
    'existing common buttons are reused',
  );
  assert.equal(
    await page
      .locator('.native-git')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgba(0, 0, 0, 0)',
    'no independent Git background',
  );
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => window.__gitTheme(theme), theme);
    assert.equal(
      await page
        .locator('.native-git')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgba(0, 0, 0, 0)',
    );
  }
  const commit = page.getByRole('button', {
    name: 'commit selected',
    exact: true,
  });
  const stage = page.getByRole('button', {
    name: 'stage selected',
    exact: true,
  });
  const message = page.getByRole('textbox', {
    name: 'commit message',
    exact: true,
  });
  const panel = page.locator('.native-git');
  const refresh = panel
    .getByRole('button', { name: 'refresh', exact: true })
    .first();
  await page
    .getByRole('checkbox', { name: 'first.txt', exact: true })
    .waitFor();
  await git.git(['switch', '-c', 'codex/deferred']);
  const delayed = deferStatus();
  await refresh.click();
  await delayed.seen;
  assert.equal(await panel.getAttribute('aria-busy'), 'true');
  assert.equal(await refresh.isDisabled(), true);
  assert.equal(await panel.getByRole('status').count(), 1);
  assert.notEqual(await panel.getAttribute('data-branch'), 'codex/deferred');
  delayed.release();
  await page.waitForFunction(
    () =>
      document.querySelector('.native-git')?.getAttribute('data-branch') ===
        'codex/deferred' &&
      document.querySelector('.native-git')?.getAttribute('aria-busy') ===
        'false',
  );
  const oldSession = deferStatus();
  await refresh.click();
  await oldSession.seen;
  await git.git(['switch', '-c', 'codex/current']);
  const newSession = deferStatus();
  await page.evaluate(() => window.__gitSetSession('current'));
  await newSession.seen;
  oldSession.release();
  await page.waitForTimeout(50);
  assert.equal(
    await panel.getAttribute('aria-busy'),
    'true',
    'old completion cannot clear newer busy',
  );
  newSession.release();
  await page.waitForFunction(
    () =>
      document.querySelector('.native-git')?.getAttribute('data-branch') ===
        'codex/current' &&
      document.querySelector('.native-git')?.getAttribute('aria-busy') ===
        'false',
  );
  const failedRefresh = deferStatus();
  failedRefresh.error = 'fixture refresh failed';
  await refresh.click();
  await failedRefresh.seen;
  failedRefresh.release();
  await page
    .getByRole('alert')
    .filter({ hasText: 'fixture refresh failed' })
    .waitFor();
  assert.equal(await refresh.isEnabled(), true);
  await refresh.click();
  await page.getByRole('alert').waitFor({ state: 'detached' });
  console.log(
    'deferred refresh exposes busy/errors and drops stale session snapshots',
  );
  await page.getByRole('checkbox', { name: 'first.txt', exact: true }).check();
  await stage.click();
  await message.fill('First UI commit');
  await commit.click();
  await page
    .getByRole('checkbox', { name: 'first.txt', exact: true })
    .waitFor({ state: 'detached' });
  await writeFile(join(repo, 'second.txt'), 'second change');
  await page
    .getByRole('button', { name: 'refresh', exact: true })
    .first()
    .click();
  await page.getByRole('checkbox', { name: 'second.txt', exact: true }).check();
  await stage.click();
  await message.fill('Second UI commit');
  await commit.click();
  await page
    .getByRole('checkbox', { name: 'second.txt', exact: true })
    .waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(
    (await git.git(['log', '-2', '--pretty=%s'])).trim(),
    'Second UI commit\nFirst UI commit',
  );
  const commits = requests.filter(
    (command) => command.payload.method === 'commit',
  );
  assert.deepEqual(
    commits.map((command) => command.payload.params.paths),
    [['first.txt'], ['second.txt']],
  );
  assert.equal((await git.snapshot()).entries.length, 0);
  console.log('real React + Git: two consecutive explicit-file commits passed');
  for (const [language, friendly, details] of [
    [
      'en',
      'open this workspace in Circle desktop, then refresh',
      'technical details',
    ],
    ['zh-CN', '在 Circle 桌面端打开此工作区后刷新', '技术详情'],
  ]) {
    await page.evaluate(
      ({ language }) => {
        window.circleDesktop = undefined;
        window.__gitLanguage(language);
        window.__gitSetSession('disconnected-' + language);
      },
      { language },
    );
    const alert = panel.getByRole('alert');
    await alert.getByText(friendly, { exact: true }).waitFor();
    assert.equal(
      await alert.locator('details pre').isVisible(),
      false,
      'raw transport detail starts collapsed',
    );
    await alert.getByText(details, { exact: true }).click();
    assert.equal(await alert.locator('details pre').isVisible(), true);
    assert.match(
      await alert.locator('details pre').innerText(),
      /native workspace services are not connected/,
    );
    assert.equal(
      await panel
        .getByText(
          'git includes manual and agent changes; session changes remain in Changes',
          { exact: true },
        )
        .count(),
      0,
    );
  }
  console.log(
    'disconnected preview has localized next action and expandable original error',
  );
} finally {
  await browser?.close();
  await server.close();
  await rm(repo, { recursive: true, force: true });
}
