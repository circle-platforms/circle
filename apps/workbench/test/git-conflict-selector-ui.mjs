import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspaceService } from '../../desktop/src/workspace/git.ts';
import { nativeGitFileRow } from '../../desktop/test/helpers/native-git-journey.mjs';
const root = await mkdtemp(join(tmpdir(), 'circle-conflict-selector-'));
const git = new GitWorkspaceService(root);
const output = process.env.CIRCLE_UI_EVIDENCE;
let server, browser;
try {
  await git.git(['init', '-b', 'main']);
  await git.git(['config', 'user.name', 'Fixture']);
  await git.git(['config', 'user.email', 'fixture@example.invalid']);
  const name = 'git-journey-conflict.txt';
  await writeFile(join(root, name), 'base\n');
  await git.git(['add', '--', name]);
  await git.git(['commit', '-m', 'Base']);
  await git.git(['switch', '-c', 'codex/side']);
  await writeFile(join(root, name), 'side\n');
  await git.git(['add', '--', name]);
  await git.git(['commit', '-m', 'Side']);
  await git.git(['switch', '-c', 'codex/feature', 'main']);
  await writeFile(join(root, name), 'feature\n');
  await git.git(['add', '--', name]);
  await git.git(['commit', '-m', 'Feature']);
  await assert.rejects(git.git(['merge', 'codex/side']));
  assert.equal(
    (await git.snapshot()).entries.find((e) => e.path === name)?.index,
    'U',
  );
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
    plugins: [
      {
        name: 'actual-git-service-bridge',
        configureServer(host) {
          host.middlewares.use('/test-git-command', async (req, res) => {
            let body = '';
            for await (const chunk of req) body += chunk;
            const { payload } = JSON.parse(body);
            try {
              assert.equal(payload.service, 'git');
              res.end(
                JSON.stringify({
                  ok: true,
                  data: await git.call(payload.method, payload.params),
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
  const page = await browser.newPage({ viewport: { width: 600, height: 900 } });
  await page.goto(server.resolvedUrls.local[0] + 'test/git-continuity-ui.html');
  const panel = page.locator('.native-git');
  await panel.getByRole('checkbox', { name, exact: true }).waitFor();
  const old = panel
    .locator('.change-entry')
    .filter({ has: panel.getByRole('checkbox', { name, exact: true }) });
  assert.equal(
    await old.count(),
    0,
    'old panel-prefixed inner locator cannot match its row',
  );
  const row = nativeGitFileRow(page, name);
  assert.equal(
    await row.count(),
    1,
    'exact conflict filename resolves its actual row',
  );
  await row.getByRole('button', { name: 'open file', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__gitOpened), name);
  assert.equal(
    (await git.snapshot()).entries.find((e) => e.path === name)?.index,
    'U',
    'opening preserves the actual unresolved index',
  );
  if (output) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, 'actual-conflict-row.png') });
    await writeFile(
      join(output, 'receipt.json'),
      JSON.stringify(
        {
          kind: 'headless real Git service bridge and actual GitPanel; no native GUI',
          oldSelectorMatches: 0,
          correctedSelectorMatches: 1,
          openedExactPath: name,
          unresolvedIndexPreserved: true,
        },
        null,
        2,
      ),
    );
  }
  console.log(
    'actual conflict row: old selector 0, corrected exact filename 1, open callback correct, unresolved index preserved',
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
