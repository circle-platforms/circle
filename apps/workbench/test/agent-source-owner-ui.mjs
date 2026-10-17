import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { WorkspaceDocuments } from '../../desktop/src/workspace/documents.ts';
import { LanguageService } from '../../desktop/src/workspace/language.ts';
const temp = await mkdtemp(join(tmpdir(), 'child-owner-')),
  parent = join(temp, 'parent'),
  child = join(temp, 'child');
await mkdir(parent);
await mkdir(child);
const original =
  'import { amount } from "./lib";\nconst childMarker = "CHILD";\nconsole.log(amount);\n';
await writeFile(join(parent, 'main.ts'), 'const parentMarker="PARENT";\n');
await writeFile(join(child, 'main.ts'), original);
await writeFile(join(child, 'lib.ts'), 'export const amount = 1;\n');
await writeFile(join(parent, 'lib.ts'), 'export const parentOnly = 99;\n');
await writeFile(join(child, 'plan.md'), 'CHILD PLAN\n');
const documents = new Map([
  ['child-session', new WorkspaceDocuments(child)],
  ['parent-session', new WorkspaceDocuments(parent)],
]);
for (const service of documents.values()) await service.refresh();
const languages = new Map([
  ['child-session', new LanguageService(child)],
  ['parent-session', new LanguageService(parent)],
]);
const journal = [],
  streams = new Set(),
  requests = [];
const sequences = new Map();
const changed = async (id) => {
  const snapshot = await documents.get(id).refresh();
  const seq = (sequences.get(id) ?? 0) + 1;
  sequences.set(id, seq);
  const event = {
    workspaceId: id === 'child-session' ? 'child-workspace' : 'workspace1',
    sessionId: id,
    service: 'documents',
    resourceId: 'files',
    epoch: 'source-owner',
    seq,
    cursor: { seq, offset: seq * 100 },
    at: new Date().toISOString(),
    data: { kind: 'files', snapshot },
  };
  journal.push(event);
  for (const stream of streams)
    stream.write('data: ' + JSON.stringify(event) + '\n\n');
};
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
  plugins: [
    {
      name: 'actual-owner-fixture',
      configureServer(server) {
        server.middlewares.use('/__owner_events', (req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(':ready\n\n');
          streams.add(res);
          req.on('close', () => streams.delete(res));
        });
        server.middlewares.use('/__owner', async (req, res) => {
          try {
            if (req.url.includes('external=')) {
              const id = req.url.includes('child')
                ? 'child-session'
                : 'parent-session';
              await writeFile(
                join(id === 'child-session' ? child : parent, 'main.ts'),
                id === 'child-session'
                  ? original + '// CHILD external\n'
                  : 'PARENT external\n',
              );
              await changed(id);
              res.end('{}');
              return;
            }
            let body = '';
            for await (const chunk of req) body += chunk;
            const command = JSON.parse(body),
              { service, method, params } = command.payload,
              id = command.sessionId;
            requests.push({ id, service, method, params });
            assert(documents.has(id));
            let data;
            if (service === 'events') {
              const events = journal.filter(
                (event) =>
                  event.workspaceId ===
                    (id === 'child-session'
                      ? 'child-workspace'
                      : 'workspace1') && event.seq > (params.after?.seq ?? 0),
              );
              data = {
                events,
                cursor: events.at(-1)?.cursor ??
                  params.after ?? { seq: 0, offset: 0 },
                hasMore: false,
              };
            } else if (service === 'language')
              data = languages.get(id).call(method, params);
            else if (method === 'read')
              data = await documents.get(id).read(params.path);
            else if (method === 'save') {
              data = await documents
                .get(id)
                .save(params.path, params.content, params.expectedRevision);
              await changed(id);
            } else if (method === 'applyEdits') {
              data = await documents.get(id).applyEdits(params.edits);
              await changed(id);
            } else throw Error('unexpected operation');
            res.setHeader('Content-Type', 'application/json');
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
let browser, page;
const errors = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(
    server.resolvedUrls.local[0] + 'test/agent-source-owner-ui.html',
  );
  const lines = page.locator('.native-code-editor .view-lines').first();
  await page.waitForFunction(() =>
    document.querySelector('.view-lines')?.textContent.includes('CHILD'),
  );
  assert(!(await lines.textContent().then((text) => text.includes('PARENT'))));
  await page.getByRole('button', { name: 'edit', exact: true }).click();
  await page
    .getByRole('button', { name: 'external child', exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector('.view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('CHILD external'),
  );
  const input = page.locator('.native-edit-context,textarea.inputarea').first();
  await input.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.insertText('x');
  await page.waitForFunction(() =>
    document.querySelector('.view-lines')?.textContent.endsWith('x'),
  );
  await page.getByText('unsaved changes', { exact: true }).waitFor();
  await page.keyboard.press('ControlOrMeta+s');
  const until = async (fn) => {
    const end = Date.now() + 8000;
    while (!(await fn())) {
      if (Date.now() > end) throw Error('actual child disk did not settle');
      await page.waitForTimeout(30);
    }
  };
  await until(async () =>
    (await readFile(join(child, 'main.ts'), 'utf8')).endsWith('x'),
  );
  assert.equal(
    await readFile(join(parent, 'main.ts'), 'utf8'),
    'const parentMarker="PARENT";\n',
  );
  await input.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ArrowLeft');
  for (let n = 0; n < 10; n++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('F12');
  await page
    .locator('.file-view-heading strong')
    .getByText('lib.ts', { exact: true })
    .waitFor();
  await page.waitForFunction(() =>
    document.querySelector('.view-lines')?.textContent?.includes('export'),
  );
  await input.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ArrowLeft');
  for (let n = 0; n < 14; n++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('F2');
  const rename = page.locator('input.rename-input');
  await rename.fill('total');
  await rename.press('Enter');
  await page.getByRole('button', { name: 'save all', exact: true }).click();
  await until(
    async () =>
      (await readFile(join(child, 'lib.ts'), 'utf8')).includes(
        'export const total',
      ) &&
      (await readFile(join(child, 'main.ts'), 'utf8')).includes(
        'import { total }',
      ),
  );
  assert.equal(
    await readFile(join(parent, 'lib.ts'), 'utf8'),
    'export const parentOnly = 99;\n',
  );
  await page
    .getByRole('button', { name: 'external parent', exact: true })
    .click();
  await page.waitForTimeout(100);
  assert(!(await lines.textContent()).includes('PARENT'));
  await page.getByRole('button', { name: 'read only', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'save', exact: true }).isDisabled(),
    true,
  );
  await input.focus();
  await page.keyboard.press('ControlOrMeta+s');
  assert.equal(
    (await readFile(join(child, 'main.ts'), 'utf8')).endsWith('x'),
    true,
  );
  const writesBeforeReadonlyPlan = requests.filter(
    (r) =>
      r.service === 'documents' && ['save', 'applyEdits'].includes(r.method),
  ).length;
  await page.getByRole('button', { name: 'open plan', exact: true }).click();
  await page
    .locator('.file-view-heading strong')
    .getByText('plan.md', { exact: true })
    .waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector('.view-lines')
      ?.textContent?.replaceAll('\u00a0', ' ')
      .includes('CHILD PLAN'),
  );
  assert.equal(
    await page.getByRole('button', { name: 'save', exact: true }).isDisabled(),
    true,
    'child readonly ownership does not inherit parent plan editing exemption',
  );
  await page.locator('.native-code-editor').click();
  await page.keyboard.press('ControlOrMeta+s');
  assert.equal(await readFile(join(child, 'plan.md'), 'utf8'), 'CHILD PLAN\n');
  assert.equal(
    requests.filter(
      (r) =>
        r.service === 'documents' && ['save', 'applyEdits'].includes(r.method),
    ).length,
    writesBeforeReadonlyPlan,
    'readonly plan does not dispatch any mutation',
  );
  assert(
    requests.some(
      (r) => r.service === 'language' && r.params.method === 'rename',
    ),
  );
  assert(
    requests.some(
      (r) => r.service === 'documents' && r.method === 'applyEdits',
    ),
  );
  assert(requests.some((r) => r.service === 'language'));
  assert(
    requests
      .filter((r) => r.service === 'documents' || r.service === 'language')
      .every((r) => r.id === 'child-session'),
    'all resource reads writes diagnostics stay bound to child session',
  );
  assert.deepEqual(errors, []);
  console.log(
    'actual independent child documents/LSP/watch/CAS/readonly use child owner; same-name parent stays isolated',
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        errors,
        requests,
        body: await page
          ?.locator('body')
          .innerText()
          .catch(() => ''),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  await server.close();
  for (const service of documents.values()) service.close();
  for (const service of languages.values()) service.dispose();
  await rm(temp, { recursive: true, force: true });
}
