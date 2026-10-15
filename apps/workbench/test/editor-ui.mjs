import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LanguageService } from '../../desktop/src/workspace/language.ts';
const workspace = mkdtempSync(join(tmpdir(), 'circle-editor-ui-'));
const initial =
  'import { amount } from "./lib";\nconst label = "amount";\nconsole.log(amount, label);\n';
writeFileSync(join(workspace, 'main.ts'), initial);
writeFileSync(join(workspace, 'lib.ts'), 'export const amount = 1;\n');
const language = new LanguageService(workspace);
const readDocument = (path) => {
  if (!['main.ts', 'lib.ts'].includes(path)) throw Error('outside fixture');
  const content = readFileSync(join(workspace, path), 'utf8');
  return {
    path,
    content,
    revision: createHash('sha256').update(content).digest('hex'),
  };
};
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  plugins: [
    {
      name: 'circle-editor-test-adapter',
      configureServer(server) {
        server.middlewares.use(
          '/__editor_workspace',
          async (request, response) => {
            try {
              if (request.url.includes('external=1')) {
                writeFileSync(
                  join(workspace, 'main.ts'),
                  initial + '// external write\n',
                );
                response.end('{}');
                return;
              }
              let body = '';
              for await (const chunk of request) body += chunk;
              const command = JSON.parse(body),
                { service, method, params } = command.payload;
              let data;
              if (service === 'language') data = language.call(method, params);
              else if (service === 'documents' && method === 'read')
                data = readDocument(params.path);
              else if (service === 'documents' && method === 'save') {
                const current = readDocument(params.path);
                if (current.revision !== params.expectedRevision)
                  throw Error('file changed on disk');
                writeFileSync(join(workspace, params.path), params.content);
                data = readDocument(params.path);
              } else throw Error('unsupported fixture operation');
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ ok: true, data }));
            } catch (error) {
              response.end(JSON.stringify({ ok: false, error: error.message }));
            }
          },
        );
      },
    },
  ],
  root,
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}test/editor-ui.html`);
  await page.locator('.monaco-editor').waitFor();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.locator('.view-lines').first().click();
  await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.type('// human edit');
  await page.waitForFunction(() =>
    document
      .querySelector('output[aria-label="content"]')
      .textContent.includes('// human edit'),
  );
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(
    () =>
      !document
        .querySelector('output[aria-label="content"]')
        .textContent.includes('// human edit'),
  );
  await page.keyboard.press(`${modifier}+Shift+z`);
  await page.waitForFunction(() =>
    document
      .querySelector('output[aria-label="content"]')
      .textContent.includes('// human edit'),
  );
  await page.keyboard.press(`${modifier}+s`);
  await page.waitForFunction(
    () =>
      document.querySelector('output[aria-label="saves"]').textContent === '1',
  );
  await page.getByRole('button', { name: 'toggle diff', exact: true }).click();
  await page.locator('.monaco-diff-editor').waitFor();
  await page.getByRole('button', { name: 'toggle diff', exact: true }).click();
  await page
    .getByRole('button', { name: 'toggle editor', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'toggle editor', exact: true })
    .click();
  await page.locator('.monaco-editor').waitFor();
  await page.locator('.view-lines').first().click();
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(
    () =>
      !document
        .querySelector('output[aria-label="content"]')
        .textContent.includes('// human edit'),
  );
  await page.getByRole('button', { name: 'toggle theme', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.theme === 'light' &&
      document.querySelector('.monaco-editor.vs'),
  );
  await page.getByRole('button', { name: 'toggle theme', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.theme === 'dark' &&
      document.querySelector('.monaco-editor.vs-dark'),
  );
  await page.locator('.view-lines').first().click();
  await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.type('// restored after reload');
  await page.reload();
  await page.waitForFunction(() =>
    document
      .querySelector('output[aria-label="content"]')
      ?.textContent.includes('// restored after reload'),
  );
  const chinese = await browser.newPage();
  await chinese.goto(
    `${server.resolvedUrls.local[0]}test/editor-ui.html?lang=zh-CN`,
  );
  await chinese.locator('.monaco-editor').waitFor();
  await chinese.locator('.view-lines').first().click({ button: 'right' });
  await chinese.getByRole('menuitem', { name: /^复制/ }).waitFor();
  await chinese.close();
  const viewer = await browser.newPage();
  viewer.on('pageerror', (error) => errors.push(error.message));
  await viewer.goto(
    `${server.resolvedUrls.local[0]}test/editor-ui.html?viewer=1`,
  );
  await viewer.getByRole('button', { name: 'edit', exact: true }).click();
  await viewer.locator('.view-lines').first().click();
  await viewer.keyboard.press(`${modifier}+End`);
  await viewer.keyboard.type('// human draft');
  await viewer
    .getByRole('button', { name: 'external write', exact: true })
    .click();
  await viewer.waitForTimeout(100);
  await viewer
    .getByRole('button', { name: 'save to disk', exact: true })
    .click();
  await viewer
    .getByRole('button', { name: 'review disk changes', exact: true })
    .waitFor();
  assert.match(
    readFileSync(join(workspace, 'main.ts'), 'utf8'),
    /external write/,
  );
  assert.doesNotMatch(
    readFileSync(join(workspace, 'main.ts'), 'utf8'),
    /human draft/,
  );
  await viewer
    .getByRole('button', { name: 'review disk changes', exact: true })
    .click();
  await viewer.locator('.monaco-diff-editor').waitFor();
  await viewer
    .getByRole('button', { name: 'save to disk', exact: true })
    .click();
  await viewer.getByText('disk and buffer match', { exact: true }).waitFor();
  assert.match(readFileSync(join(workspace, 'main.ts'), 'utf8'), /human draft/);
  await viewer.close();
  assert.deepEqual(errors, []);
  console.log(
    'Monaco input, undo, redo, save key, diff, remount history live themes and persisted draft recovery passed',
  );
} finally {
  await browser?.close();
  await server.close();
  language.dispose();
  rmSync(workspace, { recursive: true, force: true });
}
