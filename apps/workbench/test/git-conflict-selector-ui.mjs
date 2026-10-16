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
  const longName =
    'nested/中文目录/very-long-file-name-that-must-wrap-without-hiding-controls.txt';
  await mkdir(join(root, 'nested', '中文目录'), { recursive: true });
  await writeFile(join(root, longName), 'untracked preview fixture\n');
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
  const matrix = [];
  for (const width of [380, 760])
    for (const language of ['en', 'zh-CN'])
      for (const theme of ['dark', 'light']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          ({ language, id }) => {
            window.__gitLanguage(language);
            window.__gitSetSession(id);
          },
          { language, id: `matrix-${width}-${language}-${theme}` },
        );
        const openLabel = language === 'en' ? 'open file' : '打开文件';
        const currentRow = nativeGitFileRow(page, name);
        await currentRow
          .getByRole('button', { name: openLabel, exact: true })
          .waitFor();
        await page.evaluate((theme) => window.__gitTheme(theme), theme);
        for (const filename of [name, longName]) {
          const actualRow = nativeGitFileRow(page, filename);
          await actualRow.waitFor();
          assert.equal(
            await actualRow.locator('.change-file span').innerText(),
            filename,
          );
          const geometry = await actualRow.evaluate((element) => {
            const row = element.getBoundingClientRect();
            return {
              direction: getComputedStyle(element).flexDirection,
              overflow: element.scrollWidth > element.clientWidth,
              controls: [...element.querySelectorAll('input,code,button')].map(
                (control) => {
                  const rect = control.getBoundingClientRect();
                  return {
                    left: rect.left - row.left,
                    right: rect.right - row.left,
                    bottom: rect.bottom - row.top,
                    width: rect.width,
                  };
                },
              ),
              width: row.width,
              height: row.height,
            };
          });
          assert.equal(geometry.direction, 'row');
          assert.equal(geometry.overflow, false);
          for (const box of geometry.controls) {
            assert(box.width > 0);
            assert(box.left >= -1 && box.right <= geometry.width + 1);
            assert(box.bottom <= geometry.height + 1);
          }
          const checkbox = actualRow.getByRole('checkbox', {
            name: filename,
            exact: true,
          });
          await checkbox.focus();
          await page.keyboard.press('Space');
          assert.equal(await checkbox.isChecked(), true);
          await page.keyboard.press('Space');
          assert.equal(await checkbox.isChecked(), false);
          await actualRow
            .getByRole('button', { name: openLabel, exact: true })
            .focus();
          await page.keyboard.press('Enter');
          assert.equal(await page.evaluate(() => window.__gitOpened), filename);
        }
        if (output) {
          await mkdir(output, { recursive: true });
          await page.screenshot({
            path: join(output, `${width}-${language}-${theme}.png`),
          });
        }
        matrix.push({
          width,
          language,
          theme,
          passed: true,
          actualRows: 2,
          keyboardSelectionAndOpen: true,
          unclipped: true,
        });
      }
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
          matrix,
        },
        null,
        2,
      ),
    );
  }
  assert.equal(
    (await git.snapshot()).entries.find((entry) => entry.path === name)?.index,
    'U',
  );
  console.log(
    'actual conflict selector and 8 width/language/theme matrices passed with keyboard selection/open and unclipped file rows',
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
