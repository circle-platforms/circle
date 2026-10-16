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
const rules = '# isolated project instructions\nfollow the rules\n';
writeFileSync(join(workspace, 'AGENTS.md'), rules);
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
const journal = [];
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
    cursor: { seq, offset: seq * 100 },
    at: new Date().toISOString(),
    data,
  };
  journal.push(payload);
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
  language.invalidate(changes.map(([, path]) => path));
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
  if (
    !['main.ts', 'lib.ts', 'moved.ts', 'tsconfig.json', 'AGENTS.md'].includes(
      path,
    )
  )
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
              if (request.url.includes('badconfig=1')) {
                writeFileSync(
                  join(workspace, 'tsconfig.json'),
                  '{"compilerOptions":{"target":,}}',
                );
                await changed([['added', 'tsconfig.json']]);
                response.end('{}');
                return;
              }
              if (request.url.includes('goodconfig=1')) {
                writeFileSync(
                  join(workspace, 'tsconfig.json'),
                  JSON.stringify({
                    compilerOptions: {
                      target: 'ES2022',
                      module: 'ESNext',
                      moduleResolution: 'Bundler',
                    },
                    include: ['*.ts'],
                  }),
                );
                await changed([['changed', 'tsconfig.json']]);
                response.end('{}');
                return;
              }
              let body = '';
              for await (const chunk of request) body += chunk;
              const command = JSON.parse(body),
                { service, method, params } = command.payload;
              let data;
              if (service === 'events' && method === 'replay') {
                const events = journal
                  .filter((event) => event.seq > (params.after?.seq ?? 0))
                  .slice(0, params.limit ?? 256);
                data = {
                  events,
                  cursor: events.at(-1)?.cursor ??
                    params.after ?? { seq: 0, offset: 0 },
                  hasMore: journal.some(
                    (event) =>
                      event.seq >
                      (events.at(-1)?.seq ?? params.after?.seq ?? 0),
                  ),
                };
              } else if (service === 'language')
                data = language.call(method, params);
              else if (service === 'documents' && method === 'read') {
                if (params.path === 'AGENTS.md')
                  await new Promise((resolve) => setTimeout(resolve, 200));
                data = documents
                  ? await documents.read(params.path)
                  : readDocument(params.path);
              } else if (service === 'documents' && method === 'save') {
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
                await new Promise((resolve) => setTimeout(resolve, 400));
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
  await page
    .getByRole('button', { name: 'repeat source location', exact: true })
    .click();
  await page
    .locator('.monaco-editor')
    .evaluate((node) => (window.sourceLocationEditor = node));
  await page
    .getByRole('button', { name: 'repeat source location', exact: true })
    .click();
  assert.equal(
    await page
      .locator('.monaco-editor')
      .evaluate((node) => node === window.sourceLocationEditor),
    true,
    'repeated source location must not destroy active editor widgets',
  );

  await page
    .getByRole('button', { name: 'other source location', exact: true })
    .click();
  assert.equal(
    await page
      .locator('.monaco-editor')
      .evaluate((node) => node === window.sourceLocationEditor),
    true,
    'new source locations reposition without view disposal',
  );
  await page.waitForFunction(() => {
    const input = document.querySelector(
      '.native-edit-context, textarea.inputarea',
    );
    const state = input.editContext ?? input;
    return state.selectionStart === 0 && state.selectionEnd === 5;
  });
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
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--code-size', '16px'),
  );
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.view-lines')).fontSize ===
      '16px',
  );
  assert.equal(
    await page.evaluate(() => {
      const editor = document.querySelector('.monaco-editor');
      const probe = document.createElement('span');
      editor.append(probe);
      probe.style.backgroundColor = 'var(--vscode-menu-background)';
      const actual = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = 'var(--surface)';
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return actual === expected;
    }),
    true,
    'Monaco popup surface follows the original Circle palette',
  );
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--code-size', '13px'),
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
  // EditContext input and React's onChange projection settle asynchronously.
  // Capture the already-confirmed dirty content, never a pre-input output.
  await page.waitForFunction(
    () =>
      document
        .querySelector('output[aria-label="content"]')
        ?.textContent.includes('// language undo') &&
      document
        .querySelector('.native-code-editor .view-lines')
        ?.textContent.replaceAll('\u00a0', ' ')
        .includes('// language undo'),
  );
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page
    .locator('.monaco-editor')
    .evaluate((node) => (window.localeEditorView = node));
  const editorBeforeLocale = await page
    .locator('output[aria-label="content"]')
    .textContent();
  await page.waitForFunction(() => {
    const node = document.querySelector(
      '.native-code-editor .native-edit-context, .native-code-editor textarea.inputarea',
    );
    const state = node?.editContext ?? node;
    return state && state.selectionStart !== state.selectionEnd;
  });
  const rangeBeforeLocale = await page
    .locator('.native-edit-context, textarea.inputarea')
    .first()
    .evaluate((node) =>
      node.editContext
        ? [node.editContext.selectionStart, node.editContext.selectionEnd]
        : [node.selectionStart, node.selectionEnd],
    );
  assert.notEqual(rangeBeforeLocale[0], rangeBeforeLocale[1]);

  await page
    .getByRole('button', { name: 'toggle language', exact: true })
    .click();
  assert.equal(
    await page
      .locator('.monaco-editor')
      .evaluate((node) => node === window.localeEditorView),
    true,
    'locale switch keeps active Monaco view',
  );
  assert.equal(
    await page.locator('output[aria-label="content"]').textContent(),
    editorBeforeLocale,
  );
  assert.deepEqual(
    await page
      .locator('.native-edit-context, textarea.inputarea')
      .first()
      .evaluate((node) =>
        node.editContext
          ? [node.editContext.selectionStart, node.editContext.selectionEnd]
          : [node.selectionStart, node.selectionEnd],
      ),
    rangeBeforeLocale,
  );
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
  const switched = await browser.newPage();
  switched.on('pageerror', (error) => errors.push(error.message));
  await switched.goto(
    `${server.resolvedUrls.local[0]}test/editor-ui.html?viewer=1`,
  );
  await switched.getByRole('button', { name: 'edit', exact: true }).click();
  const appendTo = async (text) => {
    await switched.locator('.native-code-editor .view-lines').first().click();
    await switched.keyboard.press(`${modifier}+End`);
    await switched.keyboard.insertText(text);
  };
  const diskUntil = async (path, predicate) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (predicate(readFileSync(join(workspace, path), 'utf8'))) return;
      await switched.waitForTimeout(20);
    }
    throw Error(
      `disk timeout ${path}: ${readFileSync(join(workspace, path), 'utf8')}`,
    );
  };
  await appendTo('x');
  await switched.keyboard.press(`${modifier}+s`);
  await diskUntil('main.ts', (text) => text.endsWith('x'));
  await switched.keyboard.press(`${modifier}+z`);
  await switched.keyboard.press(`${modifier}+s`);
  await diskUntil('main.ts', (text) => text === initial);
  await appendTo('// dirty file A\n');
  await switched
    .getByRole('button', { name: 'open rules', exact: true })
    .click();
  await switched.getByText('loading file', { exact: true }).waitFor();
  assert.equal(
    await switched.locator('.native-code-editor').count(),
    0,
    'pending B must not mount an A-seeded editor',
  );
  await switched
    .locator('.file-view-heading strong')
    .getByText('AGENTS.md', { exact: true })
    .waitFor();
  await switched.waitForFunction(() =>
    document
      .querySelector('.native-code-editor .view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('isolated project instructions'),
  );
  assert.ok(
    !(
      await switched
        .locator('.native-code-editor .view-lines')
        .first()
        .textContent()
    ).includes('import'),
  );
  await switched.getByRole('button', { name: 'edit', exact: true }).click();
  await appendTo('rules B saved\n');
  await switched.keyboard.press(`${modifier}+s`);
  await diskUntil('AGENTS.md', (text) => text.includes('rules B saved'));
  await switched
    .getByRole('button', { name: 'open main', exact: true })
    .click();
  await switched.waitForFunction(() =>
    document
      .querySelector('.native-code-editor .view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('dirty file A'),
  );
  await switched.keyboard.press(`${modifier}+s`);
  await diskUntil('main.ts', (text) => text.includes('dirty file A'));
  await switched.getByText('disk and buffer match', { exact: true }).waitFor();
  assert.doesNotMatch(
    readFileSync(join(workspace, 'main.ts'), 'utf8'),
    /isolated project instructions|rules B saved/,
  );
  assert.doesNotMatch(
    readFileSync(join(workspace, 'AGENTS.md'), 'utf8'),
    /import|dirty file A/,
  );
  await switched.close();
  writeFileSync(join(workspace, 'main.ts'), initial);
  writeFileSync(join(workspace, 'AGENTS.md'), rules);
  await changed([
    ['changed', 'main.ts'],
    ['changed', 'AGENTS.md'],
  ]);
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
  await viewer
    .getByRole('button', { name: 'break project config', exact: true })
    .click();
  await viewer.locator('.editor-project-diagnostics summary').waitFor();
  assert.equal(
    await viewer.locator('.editor-project-diagnostics').getAttribute('open'),
    null,
  );
  await viewer.locator('.editor-project-diagnostics summary').click();
  await viewer
    .getByRole('button', { name: 'tsconfig.json', exact: true })
    .first()
    .click();
  await viewer
    .locator('.file-view-heading strong')
    .getByText('tsconfig.json', { exact: true })
    .waitFor();
  await viewer
    .getByRole('button', { name: 'fix project config', exact: true })
    .click();
  await viewer
    .locator('.editor-project-diagnostics summary')
    .waitFor({ state: 'hidden' });
  await viewer.close();
  assert.deepEqual(errors, []);
  console.log(
    'Monaco input/Undo/Redo/save/diff/remount/themes/draft recovery, live menu locale, clean/dirty watcher, move/delete recovery passed; document backend: ' +
      (documents ? 'WorkspaceDocuments' : 'standalone fixture adapter'),
  );
} catch (error) {
  console.error(
    'language project at failure',
    language.call('request', { method: 'project' }),
  );
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages())
      console.error(
        'page alerts',
        await page.locator('[role=alert]').allTextContents(),
      );
  throw error;
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  await server.close();
  documents?.close();
  language.dispose();
  rmSync(workspace, { recursive: true, force: true });
}
