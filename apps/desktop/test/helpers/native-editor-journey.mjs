import { openNativeProjectFile } from './native-project-file.mjs';
// Called by the serialized desktop suite with an already launched, isolated app.
// This driver never launches or focuses a second application.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { patience } from './patience.mjs';
import { saveWithShortcut } from './native-editor-save.mjs';
const main = 'editor-main.ts',
  library = 'editor-lib.ts';
const source =
  'import { amount } from "./editor-lib";\nconst label = "amount";\nconsole.log(amount, label);\n';
const marker = '.circle-editor-journey.json';
export async function createNativeEditorFixture(workspace) {
  await mkdir(workspace, { recursive: true });
  for (const name of [main, library, marker]) {
    try {
      await access(join(workspace, name));
      throw Error(`editor fixture already exists: ${name}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await writeFile(join(workspace, main), source);
  await writeFile(join(workspace, library), 'export const amount = 1;\n');
  await writeFile(
    join(workspace, marker),
    JSON.stringify({ version: 1, main, library }),
  );
  return { main, library };
}
export async function runNativeEditorJourney({
  page,
  workspace,
  sessionId,
  output,
}) {
  const ownership = JSON.parse(await readFile(join(workspace, marker), 'utf8'));
  assert.equal(ownership.version, 1);
  assert.equal(ownership.main, main);
  const checks = [];
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const call = (service, method, params) =>
    page.evaluate(
      async ({ sessionId, service, method, params }) => {
        const reply = await window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name: 'workspace-service',
          sessionId,
          payload: { service, method, params },
        });
        if (!reply.ok) throw Error(reply.error);
        return reply.data;
      },
      { sessionId, service, method, params },
    );
  const until = async (predicate, label) => {
    const deadline = Date.now() + patience(15000);
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await page.waitForTimeout(50);
    }
    throw Error(`native editor timed out: ${label}`);
  };
  const screenshot = async (name) => {
    if (output) {
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: join(output, `${name}.png`) });
    }
  };
  const disk = (path) => readFile(join(workspace, path), 'utf8');
  const open = async (path) => {
    await openNativeProjectFile(page, path);
    await page
      .locator('.file-view-heading strong')
      .getByText(path, { exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'edit', exact: true }).click();
    await page.locator('.native-code-editor .view-lines').first().waitFor();
  };
  const append = async (text) => {
    await page.locator('.native-code-editor .view-lines').first().click();
    await page.keyboard.press(`${modifier}+End`);
    const beforeInput = await page
      .locator('.native-code-editor .view-lines')
      .first()
      .textContent();
    await page.keyboard.insertText(text);
    await until(
      () =>
        page
          .locator('.native-code-editor .view-lines')
          .first()
          .evaluate(
            (node, { inserted, beforeInput }) =>
              node.textContent !== beforeInput &&
              node.textContent
                .replaceAll('\u00a0', ' ')
                .includes(inserted.trim()),
            { inserted: text, beforeInput },
          ),
      'inserted text reaches the active Monaco model',
    );
    await page.getByText('unsaved changes', { exact: true }).waitFor();
  };
  const save = async () =>
    page.getByRole('button', { name: 'save', exact: true }).click();
  const initial = await call('documents', 'read', { path: main });
  assert.equal(initial.content, source);
  assert.ok(initial.revision);
  checks.push('real native document read');
  await open(main);
  await append('x');
  await saveWithShortcut(
    page,
    modifier,
    async () => (await disk(main)).endsWith('x'),
    'CmdS actual disk effect',
  );
  await page.keyboard.press(`${modifier}+z`);
  await until(
    () =>
      page
        .locator('.native-code-editor .view-lines')
        .first()
        .evaluate(
          (node, original) =>
            node.textContent.replace(/\s/g, '') === original.replace(/\s/g, ''),
          source,
        ),
    'Undo reaches Monaco before CmdS',
  );
  await page.getByText('unsaved changes', { exact: true }).waitFor();
  await saveWithShortcut(
    page,
    modifier,
    async () => (await disk(main)) === source,
    'Undo then CmdS actual disk effect',
  );
  checks.push('native UI edit, CmdS and retained Undo');
  await writeFile(join(workspace, main), source + '// external clean\n');
  await until(
    () =>
      page
        .locator('.native-code-editor .view-lines')
        .evaluate((node) =>
          node.textContent.replaceAll('\u00a0', ' ').includes('external clean'),
        ),
    'clean model external refresh',
  );
  await page.getByText('all changes saved', { exact: true }).waitFor();
  await append('// protected human draft\n');
  await writeFile(join(workspace, main), source + '// competing external\n');
  await page
    .getByRole('button', { name: 'review disk changes', exact: true })
    .waitFor();
  assert.match(await disk(main), /competing external/);
  assert.doesNotMatch(await disk(main), /protected human draft/);
  await screenshot('native-editor-conflict');
  await page
    .getByRole('button', { name: 'review disk changes', exact: true })
    .click();
  await page.locator('.monaco-diff-editor').waitFor();
  await save();
  await until(
    async () => (await disk(main)).includes('protected human draft'),
    'reviewed CAS save',
  );
  checks.push('real watcher clean refresh and dirty conflict preservation');
  await screenshot('native-editor-final');
  return {
    checks,
    initialRevision: initial.revision,
    finalMain: await call('documents', 'read', { path: main }),
    finalLibrary: await call('documents', 'read', { path: library }),
  };
}
