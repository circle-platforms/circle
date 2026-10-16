import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';
import { observePage, captureFailure } from './helpers/diagnostics.mjs';
import { readViewport, setViewport } from './helpers/viewport.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const appPath = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root);
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/interface');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-interface-'));
const note = join(temp, 'import.md');
await writeFile(note, '# imported by native host\nno execution');
const env = {
  ...process.env,
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'preview',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
    files: [note],
    exportPath: join(temp, 'export.md'),
  }),
};
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  chromiumSandbox: true,
  executablePath: process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
  args: [appPath],
  cwd: root,
  env,
});
const page = await application.firstWindow();
page.setDefaultTimeout(10000);
const errors = [];
observePage(page, errors);
await page
  .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
  .waitFor({ timeout: 30000 });
let viewportSizing;
if (process.env.CIRCLE_DESKTOP_CHECK_NARROW) {
  await page.waitForURL(/^circle:\/\/workbench/);
  viewportSizing = await setViewport(application, page, {
    width: 1024,
    height: 650,
  });
  await page.reload();
}
const checks = [];
const viewport = await readViewport(page);
const sourceCommands = (await import('../../../src/tui/slash_commands.ts'))
  .BUILTIN_SLASH;
const state = () =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem('circle.workbench.preview.v1') ?? 'null'),
  );
const route = async (path) => {
  await page.evaluate((value) => {
    location.hash = value;
  }, path);
  await page.waitForURL((url) => url.hash === '#' + path);
};
async function reset() {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => {
    location.hash = '/session/session1';
  });
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
}
const expected = {
  help: ['heading', 'commands & help'],
  hotkeys: ['dialog', 'keyboard shortcuts'],
  login: ['dialog', 'connection'],
  logout: ['dialog', 'connection'],
  trust: ['dialog', 'workspace trust'],
  settings: ['heading', 'settings'],
  themes: ['heading', 'settings'],
  variables: ['heading', 'settings'],
  secrets: ['heading', 'settings'],
  mcp: ['heading', 'mcp servers'],
  extensions: ['heading', 'extensions'],
  approvals: ['heading', 'approvals'],
  jobs: ['heading', 'activity'],
  new: ['heading', 'new session'],
  resume: ['heading', 'sessions'],
  continue: ['heading', 'Fix the reconnect race'],
  name: ['dialog', 'rename session'],
  session: ['dialog', 'session details'],
  models: ['heading', 'models'],
  compact: ['dialog', 'compact context'],
  skill: ['heading', 'skills'],
  tree: ['dialog', 'session tree'],
  fork: ['dialog', 'fork session'],
  clone: ['heading', 'copy · Fix the reconnect race'],
  effort: ['heading', 'models'],
  export: ['dialog', 'export session'],
  import: ['heading', 'import.md'],
  share: ['dialog', 'export session'],
  editor: ['dialog', 'draft editor'],
  exit: ['dialog', 'close session'],
};
let clipboard;
try {
  await page.getByRole('heading', { name: 'Fix the reconnect race' }).waitFor();
  clipboard = await application.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  for (const command of sourceCommands) {
    await reset();
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill('/' + command.name + ' ');
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .press('Enter');
    if (expected[command.name]) {
      const [role, name] = expected[command.name];
      await page.getByRole(role, { name, exact: true }).waitFor();
    } else {
      const snapshot = await state();
      if (command.name === 'plan')
        assert.equal(snapshot.sessions[0].readOnly, true);
      else if (command.name === 'yolo')
        assert.equal(snapshot.sessions[0].auto, true);
      else if (command.name === 'mode')
        assert.equal(snapshot.sessions[0].mode, 'accept-edits');
      else if (command.name === 'thinking')
        assert.equal(snapshot.sessions[0].showThinking, false);
      else if (command.name === 'details')
        await page
          .getByRole('heading', { name: 'raw output', exact: true })
          .first()
          .waitFor();
      else if (command.name === 'undo')
        assert.ok(snapshot.sessions[0].hiddenIds.length);
      else if (command.name === 'redo')
        await page
          .getByRole('status')
          .filter({ hasText: 'nothing to redo' })
          .waitFor();
      else if (command.name === 'init' || command.name === 'reload')
        assert.equal(snapshot.requests[0].kind, command.name);
      else if (command.name === 'copy') {
        await page.getByRole('status').filter({ hasText: 'copied' }).waitFor();
        assert.match(
          await application.evaluate(({ clipboard }) => clipboard.readText()),
          /sample data/,
        );
      } else if (command.name === 'unshare')
        assert.equal(snapshot.sessions[0].shared, false);
      else throw Error('missing UI assertion for ' + command.name);
    }
    checks.push('/' + command.name);
  }
  await reset();
  await page.getByRole('button', { name: 'toggle plan', exact: true }).click();
  assert.equal(await page.locator('.plan-items').count(), 0);
  await page.getByRole('button', { name: 'toggle plan', exact: true }).click();
  assert.equal(await page.locator('.plan-items').count(), 1);
  checks.push('plan folds in place without changing its records');
  // A long plan shows whole rows, with the step under way in sight
  const message = page.getByRole('textbox', { name: 'message', exact: true });
  await message.fill('x');
  await page.waitForFunction(() =>
    localStorage.getItem('circle.workbench.preview.v1'),
  );
  await message.fill('');
  await page.evaluate(() => {
    const key = 'circle.workbench.preview.v1';
    const saved = JSON.parse(localStorage.getItem(key));
    saved.sessions.find((row) => row.id === 'session1').todos = Array.from(
      { length: 7 },
      (_, index) => ({
        id: 'long' + index,
        text: 'Step ' + (index + 1),
        status: index < 5 ? 'completed' : index === 5 ? 'running' : 'pending',
      }),
    );
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await page.locator('.plan-items .running').waitFor();
  const plan = await page.evaluate(() => {
    const list = document.querySelector('.plan-items');
    // The list scrolls exactly its rows: whatever shows between its edges is a row
    const box = list.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      rows: [...list.children].map((row) => {
        const rect = row.getBoundingClientRect();
        return { status: row.className, top: rect.top, bottom: rect.bottom };
      }),
    };
  });
  const shown = plan.rows.filter(
    (row) => row.bottom > plan.top + 1 && row.top < plan.bottom - 1,
  );
  for (const row of shown)
    assert(
      row.top >= plan.top - 1 && row.bottom <= plan.bottom + 1,
      `a plan row is cut: ${JSON.stringify({ row, plan: [plan.top, plan.bottom] })}`,
    );
  assert(shown.some((row) => row.status === 'running'));
  assert(shown.length >= 3 && shown.length < 7, `rows shown: ${shown.length}`);
  checks.push(
    'a long plan shows whole rows and keeps the step under way in sight',
  );
  await reset();
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('keep this draft');
  await route('/page/models');
  await page.getByRole('heading', { name: 'models', exact: true }).waitFor();
  await route('/session/session1');
  assert.equal(
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue(),
    'keep this draft',
  );
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('steering update');
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .press('Enter');
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('follow-up update');
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .press('Control+q');
  assert.deepEqual(
    (await state()).sessions[0].queue.map((item) => item.kind),
    ['steering', 'follow-up'],
  );
  checks.push('draft persistence and separate queues');
  await reset();
  await route('/page/models');
  await page.getByRole('button', { name: 'connection', exact: true }).click();
  await page
    .getByLabel('api key', { exact: true })
    .fill('synthetic-api-key-not-stored');
  await page
    .getByRole('button', { name: 'save connection draft', exact: true })
    .click();
  assert.equal(
    JSON.stringify(await state()).includes('synthetic-api-key-not-stored'),
    false,
  );
  checks.push('connection secret excluded from stored state');
  await reset();
  if (
    !(await page
      .getByRole('button', { name: 'activity panel', exact: true })
      .isVisible())
  )
    await page
      .getByRole('button', { name: 'toggle inspector', exact: true })
      .click();
  await page
    .getByRole('button', { name: 'activity panel', exact: true })
    .click();
  await page
    .getByRole('button', { name: /execute needs your permission approval/ })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'allow once', exact: true })
    .click();
  const decision = await state();
  assert.equal(decision.interactions[0].status, 'recorded');
  assert.equal(decision.jobs[0].state, 'running');
  checks.push('approval records do not fabricate execution success');
  await reset();
  assert.equal(
    await page.getByRole('link', { name: 'knowledge', exact: true }).count(),
    0,
  );
  await route('/page/extensions');
  await page
    .getByRole('button', { name: 'interface components', exact: true })
    .click();
  // Three plain components, and the circle-server interface with the four platform
  // objects, all paired with a runtime extension the preview does not have, so off.
  assert.equal(await page.getByRole('checkbox').count(), 8);
  for (const id of ['knowledge', 'work', 'execution', 'methods'])
    assert.equal(
      await page
        .getByRole('checkbox', { name: `enable ${id} interface`, exact: true })
        .isChecked(),
      false,
    );
  assert.equal(
    await page
      .getByRole('checkbox', {
        name: 'enable circle-server interface',
        exact: true,
      })
      .isChecked(),
    false,
  );
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem('circle.workbench.platform-preview.v1'),
    ),
    null,
  );
  checks.push(
    'the Circle interface excludes the four deferred platform objects',
  );
  await reset();
  await route('/page/settings');
  // The default workspace section shows the fixture folder; the native picker
  // exists only in the live app, never in the frontend preview.
  const defaultWorkspace = page.locator('section.settings-block', {
    has: page.getByRole('heading', {
      name: 'default workspace',
      exact: true,
    }),
  });
  await defaultWorkspace.waitFor();
  assert.match(await defaultWorkspace.innerText(), /\/workspace\/orbit-api/);
  assert.equal(
    await defaultWorkspace
      .getByRole('button', { name: 'change…', exact: true })
      .count(),
    0,
  );
  checks.push(
    'the preview settings name the default workspace without a picker',
  );
  // The settings page explains itself: a pattern you can check a name against, a
  // workspace you can take away, and a key you change by pressing it.
  const trust = page.locator('section.settings-block', {
    has: page.getByRole('heading', { name: 'workspace trust', exact: true }),
  });
  const docsRow = trust
    .locator('.setting-row')
    .filter({ has: page.getByText('docs-site') });
  await docsRow.getByRole('button', { name: 'remove…', exact: true }).click();
  const removeDialog = page.getByRole('dialog', {
    name: 'remove docs-site?',
  });
  await removeDialog.getByText('/workspace/docs-site').waitFor();
  await removeDialog
    .getByRole('button', { name: 'cancel', exact: true })
    .click();
  await removeDialog.waitFor({ state: 'hidden' });
  assert.equal(await docsRow.count(), 1);
  await docsRow.getByRole('button', { name: 'remove…', exact: true }).click();
  await removeDialog
    .getByRole('button', { name: 'remove workspace', exact: true })
    .click();
  await docsRow.waitFor({ state: 'hidden' });
  assert.equal(
    await trust
      .locator('.setting-row')
      .filter({ has: page.getByText('orbit-api') })
      .getByRole('button', { name: 'remove…', exact: true })
      .isDisabled(),
    true,
  );
  checks.push(
    'a workspace is removed from settings through a confirmation, and the active one is not',
  );
  const protectedFiles = page.locator('section.settings-block', {
    has: page.getByRole('heading', { name: 'protected files', exact: true }),
  });
  const patternField = protectedFiles.getByRole('textbox', {
    name: 'new file pattern',
    exact: true,
  });
  const items = protectedFiles.getByRole('listitem');
  const patternsBefore = await items.count();
  await patternField.fill('secrets/*.key');
  await protectedFiles
    .getByRole('button', { name: 'add', exact: true })
    .click();
  await protectedFiles
    .getByText('a pattern is a file name, not a path')
    .waitFor();
  assert.equal(await items.count(), patternsBefore);
  await patternField.fill('.env');
  await protectedFiles
    .getByRole('button', { name: 'add', exact: true })
    .click();
  await protectedFiles
    .getByText('.env is on the always protected list')
    .waitFor();
  assert.equal(await items.count(), patternsBefore);
  await patternField.fill('*.crt');
  await protectedFiles
    .getByRole('button', { name: 'add', exact: true })
    .click();
  await items.filter({ hasText: '*.crt' }).waitFor();
  assert.equal(await items.count(), patternsBefore + 1);
  await protectedFiles
    .getByRole('textbox', { name: 'check a file name', exact: true })
    .fill('server.crt');
  await protectedFiles.getByText('server.crt is protected by *.crt').waitFor();
  await protectedFiles
    .getByRole('textbox', { name: 'check a file name', exact: true })
    .fill('notes.txt');
  await protectedFiles.getByText('notes.txt is not protected').waitFor();
  await protectedFiles
    .getByRole('button', { name: 'remove *.crt', exact: true })
    .click();
  assert.equal(await items.count(), patternsBefore);
  checks.push(
    'a file pattern is refused, added, checked against a name and removed',
  );
  const keyboard = page.locator('section.settings-block', {
    has: page.getByRole('heading', { name: 'keyboard', exact: true }),
  });
  const modelRow = keyboard
    .locator('.key-action')
    .filter({ has: page.getByText('choose a model') });
  await modelRow.getByRole('button', { name: 'change…', exact: true }).click();
  await page.keyboard.press('F3');
  await modelRow.getByText('F3').waitFor();
  await route('/session/session1');
  await page.getByRole('textbox', { name: 'message', exact: true }).press('F3');
  await page.getByRole('heading', { name: 'models', exact: true }).waitFor();
  checks.push('a key recorded in settings invokes its action');
  await route('/page/settings');
  await modelRow.getByRole('button', { name: 'reset', exact: true }).click();
  assert.equal(
    (await state()).settings.keybindings['model.select'] ?? null,
    null,
  );
  checks.push('a recorded key resets to its default');
  await keyboard
    .getByRole('button', { name: 'edit the bindings as JSON' })
    .click();
  await page
    .getByRole('textbox', { name: 'keybindings json', exact: true })
    .fill('{"nope":"x"}');
  await keyboard.getByRole('button', { name: 'apply', exact: true }).click();
  await keyboard.getByText('unknown key action: nope').waitFor();
  await page
    .getByRole('textbox', { name: 'keybindings json', exact: true })
    .fill('{"find":["ctrl+f","f4"]}');
  await keyboard.getByRole('button', { name: 'apply', exact: true }).click();
  const findRow = keyboard
    .locator('.key-action')
    .filter({ has: page.getByText('find in conversation') });
  await findRow.getByText('Ctrl+F / F4').waitFor();
  assert.deepEqual((await state()).settings.keybindings, {
    find: ['ctrl+f', 'f4'],
  });
  checks.push('bindings applied as JSON replace the recorded ones');
  await reset();
  await page.getByRole('button', { name: 'new session', exact: true }).click();
  await page
    .getByRole('heading', { name: 'new session', exact: true })
    .waitFor();
  const resetSessionId = new URL(page.url()).hash.split('/').at(-1);
  const resetDraft = 'preview reset regression draft';
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill(resetDraft);
  await page.waitForFunction(
    (draft) =>
      localStorage.getItem('circle.workbench.preview.v1')?.includes(draft),
    resetDraft,
  );
  const resetBefore = await state();
  const previewDialog = page.getByRole('dialog', {
    name: 'frontend preview',
    exact: true,
  });
  const openPreview = async () => {
    await page
      .getByRole('button', { name: 'frontend preview', exact: true })
      .click();
    await previewDialog.waitFor();
  };
  await openPreview();
  await previewDialog
    .getByRole('button', { name: 'reset sample data', exact: true })
    .click();
  await previewDialog
    .getByRole('button', { name: 'keep local data', exact: true })
    .click();
  assert.deepEqual(await state(), resetBefore);
  await previewDialog
    .getByRole('button', { name: 'close dialog', exact: true })
    .click();
  await openPreview();
  await previewDialog
    .getByRole('button', { name: 'reset sample data', exact: true })
    .waitFor();
  assert.equal(
    await previewDialog
      .getByRole('button', { name: 'confirm reset', exact: true })
      .count(),
    0,
  );
  await previewDialog
    .getByRole('button', { name: 'reset sample data', exact: true })
    .click();
  await previewDialog
    .getByRole('button', { name: 'close dialog', exact: true })
    .click();
  assert.deepEqual(await state(), resetBefore);
  await openPreview();
  await previewDialog
    .getByRole('button', { name: 'reset sample data', exact: true })
    .click();
  await previewDialog
    .getByRole('button', { name: 'confirm reset', exact: true })
    .click();
  await previewDialog.waitFor({ state: 'hidden' });
  await page.waitForURL((url) => url.hash === '#/session/session1');
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
  assert.equal(await state(), null);
  assert.equal(
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue(),
    '',
  );
  await page.reload();
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .waitFor();
  assert.equal(await state(), null);
  assert.equal(
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue(),
    '',
  );
  assert.notEqual(new URL(page.url()).hash.split('/').at(-1), resetSessionId);
  await openPreview();
  await previewDialog
    .getByRole('button', { name: 'reset sample data', exact: true })
    .waitFor();
  assert.equal(
    await previewDialog
      .getByRole('button', { name: 'confirm reset', exact: true })
      .count(),
    0,
  );
  await previewDialog
    .getByRole('button', { name: 'close dialog', exact: true })
    .click();
  checks.push(
    'preview reset cancel, confirmation, reopen and persisted data effects',
  );
  await reset();
  const narrowViewport = await setViewport(application, page, {
    width: 800,
    height: 650,
  });
  await page
    .getByRole('dialog', { name: 'inspector', exact: true })
    .waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: join(output, 'desktop-narrow.png') });
  checks.push('native window resizing keeps a bounded layout');
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        appPath,
        appPackaged: await page
          .evaluate(() => window.circleDesktop.info())
          .then((info) => info.packaged),
        sourceFiles: await sourceEvidence(),
        buildFiles: await rendererEvidence(root),
        commands: sourceCommands.length,
        viewport,
        viewportSizing,
        narrowViewport,
        checks,
        errors,
        scope:
          'native desktop UI and local preview behavior; no model or external platform service',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      commands: sourceCommands.length,
      checks: checks.length,
      errors,
    }),
  );
} catch (error) {
  await captureFailure(page, error, errors, output);
  throw error;
} finally {
  if (clipboard !== undefined)
    await application
      .evaluate(({ clipboard }, value) => clipboard.writeText(value), clipboard)
      .catch(() => {});
  await application.close();
  await rm(temp, { recursive: true, force: true });
}
