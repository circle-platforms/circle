import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// An open file shows where it differs from the last commit beside its line numbers, and
// the file's heading offers the full view next to closing it.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-gutter-marks-')));
await mkdir(output, { recursive: true });
const lines = (count) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n') +
  '\n';
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const [theme, language] of [
    ['light', 'en'],
    ['dark', 'zh-CN'],
  ]) {
    const page = await browser.newPage({
      viewport: { width: 900, height: 700 },
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/gutter-marks-ui.html?theme=${theme}&language=${language}`,
    );
    const zh = language === 'zh-CN';
    const mark = (kind) => page.locator(`.monaco-editor .change-mark-${kind}`);
    const count = async (kind) => mark(kind).count();
    // The rows of the editor, top to bottom: a mark sits on the row of its line.
    const rowTops = () =>
      page
        .locator('.monaco-editor .view-lines .view-line')
        .evaluateAll((rows) =>
          rows
            .map((row) => Math.round(row.getBoundingClientRect().top))
            .sort((a, b) => a - b),
        );
    const tops = (kind) =>
      mark(kind).evaluateAll((nodes) =>
        nodes
          .map((node) => Math.round(node.getBoundingClientRect().top))
          .sort((a, b) => a - b),
      );

    // Lines 3 and 4 changed, line 5 is new and a line went after 11: two orange rows, a
    // blue one and a red triangle on the row after the gap.
    await mark('deleted').first().waitFor({ state: 'attached' });
    // the rows are laid out: the editor has measured its font
    await page.waitForFunction(() => {
      const rows = [
        ...document.querySelectorAll('.monaco-editor .view-lines .view-line'),
      ];
      return (
        rows.length >= 14 &&
        rows.every((row) => row.getBoundingClientRect().top > 0)
      );
    });
    assert.equal(await count('changed'), 2);
    assert.equal(await count('added'), 1);
    assert.equal(await count('deleted'), 1);
    const rows = await rowTops();
    assert.deepEqual(await tops('changed'), [rows[2], rows[3]]);
    assert.deepEqual(await tops('added'), [rows[4]]);
    // the line after the gap is the 13th of the file as it stands: the hunk above added one
    assert.deepEqual(await tops('deleted'), [rows[12]]);
    // the colours are the interface's own: attention, accent and negative
    const colour = (variable) =>
      page.evaluate((variable) => {
        const probe = document.createElement('i');
        probe.style.color = `var(${variable})`;
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      }, variable);
    const paint = (kind, property) =>
      mark(kind)
        .first()
        .evaluate(
          (node, property) =>
            getComputedStyle(node, '::before').getPropertyValue(property),
          property,
        );
    assert.equal(
      await paint('changed', 'background-color'),
      await colour('--attention'),
    );
    assert.equal(
      await paint('added', 'background-color'),
      await colour('--accent'),
    );
    assert.equal(
      await paint('deleted', 'border-left-color'),
      await colour('--negative'),
    );
    await page.screenshot({ path: `${output}/marks-${theme}-${language}.png` });

    // Text typed above moves the marks with their lines until it is saved.
    const lineHeight = rows[1] - rows[0];
    await page.evaluate(() => window.gutterFixture.toTop());
    await page.keyboard.type('// above\n');
    await page
      .getByText(zh ? '未保存的修改' : 'unsaved changes', { exact: true })
      .waitFor();
    // the editor paints its marks on the next frame: wait for them where they belong
    await page.waitForFunction(
      (expected) =>
        JSON.stringify(
          [...document.querySelectorAll('.monaco-editor .change-mark-changed')]
            .map((node) => Math.round(node.getBoundingClientRect().top))
            .sort((a, b) => a - b),
        ) === JSON.stringify(expected),
      [rows[2] + lineHeight, rows[3] + lineHeight],
    );
    assert.equal(await count('added'), 1);
    assert.equal(
      (await page.evaluate(() => window.gutterFixture.calls)).filter(
        (call) => call.service === 'git',
      ).length,
      1,
      'the patch is read once for the file as it stands on disk',
    );
    // Saving writes the file; the patch is read again for the new text.
    await page.evaluate(() => {
      window.gutterFixture.failPatch(false);
    });
    await page.locator('.monaco-editor .view-lines').first().click();
    await page
      .getByRole('button', { name: zh ? '保存' : 'save', exact: true })
      .click();
    await page
      .getByText(zh ? '所有修改已保存' : 'all changes saved', { exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        window.gutterFixture.calls.filter((call) => call.service === 'git')
          .length === 2,
    );

    // The file changes on disk (the model's edit): its new patch replaces the marks.
    await page.evaluate((content) => {
      window.gutterFixture.update(
        `diff --git a/main.ts b/main.ts
--- a/main.ts
+++ b/main.ts
@@ -1,1 +1,1 @@
-old 1
+line 1
`,
        content,
      );
    }, lines(14));
    await page.waitForFunction(
      () =>
        window.gutterFixture.calls.filter((call) => call.service === 'git')
          .length === 3,
    );
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.monaco-editor .change-mark-changed')
          .length === 1 &&
        document.querySelectorAll('.monaco-editor .change-mark-added')
          .length === 0 &&
        document.querySelectorAll('.monaco-editor .change-mark-deleted')
          .length === 0,
    );
    // A file that matches the last commit has no marks, and a folder that is not a
    // repository says nothing about it in the file.
    await page.evaluate((content) => {
      window.gutterFixture.update('', content);
    }, lines(14));
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.monaco-editor [class*="change-mark-"]')
          .length === 0,
    );
    await page.evaluate((content) => {
      window.gutterFixture.failPatch(true);
      window.gutterFixture.update('', content);
    }, lines(14));
    await page.waitForFunction(
      () =>
        window.gutterFixture.calls.filter((call) => call.service === 'git')
          .length === 5,
    );
    assert.equal(await page.locator('.editor-notice').count(), 0);

    // The heading ends with the full view and closing the file.
    const names = await page
      .locator('.file-view-heading button')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('aria-label')),
      );
    assert.deepEqual(
      names,
      zh ? ['完整视图', '关闭文件'] : ['full view', 'close file'],
    );
    await page
      .locator('.file-view-heading')
      .getByRole('button', { name: zh ? '完整视图' : 'full view', exact: true })
      .click();
    assert.deepEqual(
      await page.evaluate(() => window.gutterFixture.wholeCalls),
      ['whole'],
    );
    // a file opens as the file itself, not as a difference
    assert.equal(await page.locator('.monaco-diff-editor').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
console.log('change marks: ok');
