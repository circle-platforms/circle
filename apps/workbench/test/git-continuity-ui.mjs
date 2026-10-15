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
            const data = await git.call(p.method, p.params);
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
  const commit = page.getByRole('button', {
    name: 'commit selected staged files',
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
} finally {
  await browser?.close();
  await server.close();
  await rm(repo, { recursive: true, force: true });
}
