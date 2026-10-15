import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  unlinkSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
} from 'node:fs';
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
const documentsModule =
  process.env.CIRCLE_EDITOR_DOCUMENT_SERVICE ??
  fileURLToPath(
    new URL('../../desktop/src/workspace/documents.ts', import.meta.url),
  );
if (process.env.CIRCLE_EDITOR_DOCUMENT_SERVICE && !existsSync(documentsModule))
  throw Error('requested document service module does not exist');
const documents = existsSync(documentsModule)
  ? new (await import(pathToFileURL(documentsModule).href)).WorkspaceDocuments(
      workspace,
    )
  : null;
const streams = new Set();
let seq = 0,
  externalWrites = 0;
const event = (data) => {
  const payload = {
    workspaceId: 'fixture',
    sessionId: 'fixture',
    service: 'documents',
    resourceId: 'files',
    epoch: 'editor-fixture',
    seq: ++seq,
    at: new Date().toISOString(),
    data,
  };
  for (const stream of streams)
    stream.write(`data: ${JSON.stringify(payload)}\n\n`);
};
const files = () =>
  readdirSync(workspace)
    .filter((name) => name.endsWith('.ts'))
    .map((path) => ({
      id: path,
      path,
      mtime: statSync(join(workspace, path)).mtimeMs,
      size: statSync(join(workspace, path)).size,
    }));
const changed = async (changes) => {
  if (documents) {
    const snapshot = await documents.refresh();
    event({ kind: 'files', snapshot });
  } else
    event({
      kind: 'files',
      snapshot: {
        version: seq + 1,
        files: files(),
        changes: changes.map(([kind, path]) => ({
          kind,
          file: { id: path, path, mtime: 0, size: 0 },
        })),
        truncated: false,
      },
    });
};
if (documents) await documents.refresh();
const readDocument = (path) => {
  if (!['main.ts', 'lib.ts', 'moved.ts'].includes(path))
    throw Error('outside fixture');
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
        server.middlewares.use('/__editor_events', (request, response) => {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          response.write(': ready\n\n');
          streams.add(response);
          request.on('close', () => streams.delete(response));
        });
        server.middlewares.use(
          '/__editor_workspace',
          async (request, response) => {
            try {
              if (request.url.includes('external=1')) {
                writeFileSync(
                  join(workspace, 'main.ts'),
                  initial + `// external write ${++externalWrites}\n`,
                );
                await changed([['changed', 'main.ts']]);
                response.end('{}');
                return;
              }
              if (request.url.includes('rename=1')) {
                renameSync(
                  join(workspace, 'main.ts'),
                  join(workspace, 'moved.ts'),
                );
                await changed([
                  ['removed', 'main.ts'],
                  ['added', 'moved.ts'],
                ]);
                response.end('{}');
                return;
              }
              if (request.url.includes('delete=1')) {
                unlinkSync(join(workspace, 'moved.ts'));
                await changed([['removed', 'moved.ts']]);
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
                data = documents
                  ? await documents.read(params.path)
                  : readDocument(params.path);
              else if (service === 'documents' && method === 'save') {
                if (documents)
                  data = await documents.save(
                    params.path,
                    params.content,
                    params.expectedRevision,
                  );
                else {
                  const current = existsSync(join(workspace, params.path))
                    ? readDocument(params.path)
                    : null;
                  if ((current?.revision ?? null) !== params.expectedRevision)
                    throw Error('file changed on disk');
                  writeFileSync(join(workspace, params.path), params.content);
                  data = readDocument(params.path);
                }
                await changed([['changed', params.path]]);
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
  await page.locator('.view-lines').first().click();
  await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.type('// language undo');
  await page
    .getByRole('button', { name: 'toggle language', exact: true })
    .click();
  await page.locator('.view-lines').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^复制/ }).waitFor();
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'toggle language', exact: true })
    .click();
  await page.locator('.view-lines').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Copy/ }).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(
    () =>
      !document
        .querySelector('output[aria-label="content"]')
        .textContent.includes('// language undo'),
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
  await viewer
    .getByRole('button', { name: 'external write', exact: true })
    .click();
  await viewer.waitForFunction(() =>
    document
      .querySelector('.view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('external write 1'),
  );
  await viewer.getByText('disk and buffer match', { exact: true }).waitFor();
  await viewer.locator('.view-lines').first().click();
  await viewer.keyboard.press(`${modifier}+End`);
  await viewer.keyboard.type('// human draft');
  await viewer
    .getByRole('button', { name: 'external write', exact: true })
    .click();
  await viewer
    .getByText('file changed on disk; buffer kept', { exact: true })
    .waitFor();
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
  if (process.env.CIRCLE_EDITOR_EVIDENCE_DIR) {
    mkdirSync(process.env.CIRCLE_EDITOR_EVIDENCE_DIR, { recursive: true });
    await viewer.screenshot({
      path: join(process.env.CIRCLE_EDITOR_EVIDENCE_DIR, 'editor-conflict.png'),
    });
  }
  await viewer
    .getByRole('button', { name: 'review disk changes', exact: true })
    .click();
  await viewer.locator('.monaco-diff-editor').waitFor();
  await viewer
    .getByRole('button', { name: 'save to disk', exact: true })
    .click();
  await viewer.getByText('disk and buffer match', { exact: true }).waitFor();
  assert.match(readFileSync(join(workspace, 'main.ts'), 'utf8'), /human draft/);
  await viewer
    .getByRole('button', { name: 'external rename', exact: true })
    .click();
  await viewer
    .getByRole('button', {
      name: 'open possible moved file: moved.ts',
      exact: true,
    })
    .click();
  await viewer
    .locator('.file-view-heading strong')
    .getByText('moved.ts', { exact: true })
    .waitFor();
  await viewer.getByRole('button', { name: 'edit', exact: true }).click();
  await viewer.locator('.view-lines').first().click();
  await viewer.keyboard.press(`${modifier}+End`);
  await viewer.keyboard.type('// recovered deleted draft');
  await viewer
    .getByRole('button', { name: 'external delete', exact: true })
    .click();
  await viewer
    .getByText('file removed on disk; buffer kept', { exact: true })
    .waitFor();
  assert.equal(existsSync(join(workspace, 'moved.ts')), false);
  await viewer
    .getByRole('button', { name: 'restore file from buffer', exact: true })
    .click();
  await viewer.getByText('disk and buffer match', { exact: true }).waitFor();
  assert.match(
    readFileSync(join(workspace, 'moved.ts'), 'utf8'),
    /recovered deleted draft/,
  );
  if (process.env.CIRCLE_EDITOR_EVIDENCE_DIR)
    await viewer.screenshot({
      path: join(
        process.env.CIRCLE_EDITOR_EVIDENCE_DIR,
        'editor-recovered.png',
      ),
    });
  await viewer.close();
  assert.deepEqual(errors, []);
  console.log(
    'Monaco input/Undo/Redo/save/diff/remount/themes/draft recovery, live menu locale, clean/dirty watcher, move/delete recovery passed; document backend: ' +
      (documents ? 'WorkspaceDocuments' : 'standalone fixture adapter'),
  );
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  await server.close();
  documents?.close();
  language.dispose();
  rmSync(workspace, { recursive: true, force: true });
}
