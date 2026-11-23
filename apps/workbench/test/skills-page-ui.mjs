import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-skills-page-ui-')));
await mkdir(output, { recursive: true });
let browser;
const receipts = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      for (const width of [375, 1280]) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.setDefaultTimeout(5000);
        const name = `${language}-${theme}-${width}`;
        await page.goto(
          `${server.resolvedUrls.local[0]}test/skills-page-ui.html?language=${language}&theme=${theme}`,
        );
        await page.getByRole('heading', { name: 'demo-skill' }).waitFor();
        const detail = page.locator('.catalog-detail');
        const notes = await detail.locator('.panel-note').allTextContents();
        const combined = notes.join('\n');

        if (language === 'zh-CN') {
          assert.match(combined, /允许的工具：Read, Bash\(git status\)/);
          assert.match(combined, /禁用的工具：Write/);
          assert.match(
            combined,
            /demo-skill 的 allowed-tools BadTool\(\)：不是工具名称 · 未生效/,
          );
          assert.match(
            combined,
            /demo-skill 在 allowed-tools 中写了不存在的工具：FakeTool · 未生效/,
          );
          assert.match(
            combined,
            /demo-skill 的 allowed-tools Write\(\/tmp\)：只有 execute 接受模式 · 未生效/,
          );
          assert.match(
            combined,
            /demo-skill 的 disallowed-tools Bash\(rm\)：禁用的是整个工具，不能只禁用其中部分调用 · 未生效/,
          );
          assert.match(
            combined,
            /demo-skill 的 disallowed-tools compact_conversation：该工具始终提供 · 未生效/,
          );
          assert.doesNotMatch(
            combined,
            /not applied|not a tool name|do not exist in|only execute takes a pattern|always offered/i,
          );
        } else {
          assert.match(combined, /allowed-tools: Read, Bash\(git status\)/);
          assert.match(combined, /disallowed-tools: Write/);
          assert.match(combined, /not applied/);
        }

        // S8: legacySkillPacks banner surfaces in both languages without breaking detail notes.
        const pageNotes = await page
          .locator('section.page > [role="status"].panel-note')
          .allTextContents();
        const legacyText = pageNotes.join('\n');
        assert.match(legacyText, /legacy-hub-pack/);
        if (language === 'zh-CN') {
          assert.match(legacyText, /早期安装的 Hub 扩展包/);
          assert.match(legacyText, /应用数据文件夹/);
        } else {
          assert.match(legacyText, /earlier installs in ~\/\.agents\/skills/);
        }

        await page.screenshot({
          path: join(output, `${name}.png`),
        });
        assert.deepEqual(errors, []);
        receipts.push(name);
        await page.close();
      }
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify({ cases: receipts }, null, 2),
  );
  console.log(JSON.stringify({ cases: receipts.length, output }));
} finally {
  await browser?.close();
  await server.close();
}
