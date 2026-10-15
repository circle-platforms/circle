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
  const sections = page.locator('.project-list > .project');
  await sections
    .nth(0)
    .getByRole('button', { name: 'recent', exact: true })
    .waitFor();
  const activeLinks = page.locator('.sidebar a.session-link.active');
  const hrefs = await activeLinks.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('href')),
  );
  assert.ok(hrefs.length >= 2);
  assert.equal(new Set(hrefs).size, 1);
  const projectName = await sections
    .nth(1)
    .locator('.project-name')
    .innerText();
  const recentActive = sections.nth(0).locator('a.session-link.active');
  assert.equal((await recentActive.innerText()).includes(projectName), false);
  await recentActive.hover();
  const hover = page.locator('.session-hover');
  await hover.waitFor();
  assert.match(await hover.innerText(), new RegExp(projectName));
  assert.match(await hover.innerText(), /updated /);
  const flickered = await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 350) {
      if (!document.querySelector('.session-hover')) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return false;
  });
  assert.equal(flickered, false);
  const renameCommand = page.getByRole('textbox', {
    name: 'message',
    exact: true,
  });
  await renameCommand.fill('/name ');
  await hover.waitFor();
  await renameCommand.press('Enter');
  await page
    .getByRole('dialog', { name: 'rename session', exact: true })
    .waitFor();
  assert.equal(await hover.count(), 0);
  await page.keyboard.press('Escape');
  await page
    .getByRole('heading', { name: 'Fix the reconnect race', exact: true })
    .hover();
  assert.equal(await hover.count(), 0);
  await recentActive.focus();
  await hover.waitFor();
  assert.equal(
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'work without a project', exact: true })
      .count(),
    0,
  );
  checks.push(
    'the open session stays highlighted in recent and in its project',
  );
  checks.push(
    'a recent row shows only its title, and hover or focus shows the project and time',
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
  // Three plain components, and the hub interface with the four platform
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
        name: 'enable hub interface',
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
  await page
    .getByRole('textbox', { name: 'keybindings json', exact: true })
    .fill('{"model.select":"f3"}');
  await page
    .getByRole('button', { name: 'save key preferences', exact: true })
    .click();
  await route('/session/session1');
  await page.getByRole('textbox', { name: 'message', exact: true }).press('F3');
  await page.getByRole('heading', { name: 'models', exact: true }).waitFor();
  checks.push('custom key binding invokes its configured action');
  await reset();
  const beforeNew = await state();
  await page.getByRole('button', { name: 'new session', exact: true }).click();
  await page
    .getByRole('heading', {
      name: 'what should we build in orbit-api?',
      exact: true,
    })
    .waitFor();
  assert.equal(new URL(page.url()).hash, '#/home');
  // Sample data stays in memory until a view writes it. Home must not add a row.
  const afterNew = await state();
  assert.equal(afterNew?.sessions.length ?? 3, beforeNew?.sessions.length ?? 3);
  assert.equal(
    afterNew?.activeSessionId ?? 'session1',
    beforeNew?.activeSessionId ?? 'session1',
  );
  checks.push('new session opens home without creating an empty session');
  const thinking = page.getByRole('button', {
    name: 'thinking depth',
    exact: true,
  });
  await thinking.waitFor();
  await page
    .getByRole('button', { name: 'approval mode', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'model', exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'attach files', exact: true })
    .waitFor();
  assert.match(await thinking.innerText(), /^high\b/);
  await page.getByRole('button', { name: 'new session', exact: true }).click();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'message',
  );
  checks.push('new session focuses the composer when home is already open');
  await page
    .getByRole('button', { name: 'approval mode', exact: true })
    .click();
  const modeMenu = page.locator('.mode-menu');
  await modeMenu.waitFor();
  assert.equal(await modeMenu.getAttribute('data-side'), 'bottom');
  await page.getByRole('menuitem', { name: /^manual/ }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'message',
  );
  await thinking.click();
  const effortMenu = page.locator('.dropdown.footbar-menu');
  await effortMenu.waitFor();
  assert.equal(await effortMenu.getAttribute('data-side'), 'bottom');
  await page.getByRole('menuitem', { name: 'minimal', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'message',
  );
  checks.push(
    'home menus open downward and escape returns focus to the composer',
  );
  await thinking.click();
  await page.getByRole('menuitem', { name: 'extra high', exact: true }).click();
  assert.match(await thinking.innerText(), /extra high/);
  checks.push('home composer has the session controls');
  const projectButton = page.getByRole('button', {
    name: 'choose a project',
    exact: true,
  });
  await projectButton.click();
  const projectMenu = page.locator('.project-menu');
  await projectMenu.waitFor();
  assert.equal(await projectMenu.getAttribute('data-side'), 'bottom');
  await page
    .getByRole('textbox', { name: 'search projects', exact: true })
    .fill('zzznomatch');
  await projectMenu
    .getByRole('status')
    .getByText('no matching projects')
    .waitFor();
  await projectMenu
    .getByRole('menuitem', { name: 'open folder', exact: true })
    .waitFor();
  await projectMenu
    .getByRole('menuitem', { name: 'no project', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'message',
  );
  checks.push(
    'a project search with no matches keeps open folder and no project',
  );
  const heldDraft = page.getByRole('textbox', { name: 'message', exact: true });
  await heldDraft.fill('hold this');
  await projectButton.click();
  await page.getByRole('menuitem', { name: 'docs-site', exact: true }).click();
  await page
    .getByRole('heading', {
      name: 'what should we build in docs-site?',
      exact: true,
    })
    .waitFor();
  await route('/session/session1');
  await page.getByRole('button', { name: 'new session', exact: true }).click();
  await page
    .getByRole('heading', {
      name: 'what should we build in docs-site?',
      exact: true,
    })
    .waitFor();
  assert.equal(await heldDraft.inputValue(), 'hold this');
  assert.match(await thinking.innerText(), /extra high/);
  checks.push(
    'leaving home and opening new session keeps the draft, project and thinking depth',
  );
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  const trustDialog = page.getByRole('dialog', {
    name: 'workspace trust',
    exact: true,
  });
  await trustDialog.waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement?.textContent?.includes('trust in preview') ??
      false,
  );
  await trustDialog
    .getByRole('button', { name: 'trust in preview', exact: true })
    .click();
  await page.getByRole('heading', { name: 'hold this', exact: true }).waitFor();
  const trusted = await state();
  const trustedSession = trusted.sessions.find((session) =>
    session.messages.some((item) => item.text === 'hold this'),
  );
  const trustedWorkspace = trusted.workspaces.find(
    (item) => item.id === trustedSession.workspaceId,
  );
  assert.equal(trustedWorkspace.name, 'docs-site');
  assert.equal(trustedWorkspace.trusted, true);
  checks.push(
    'trusting a project focuses the confirm button and sends the waiting message',
  );
  await page.getByRole('button', { name: 'new session', exact: true }).click();
  await page
    .getByRole('button', { name: 'choose a project', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'no project', exact: true }).click();
  const homeMessage = page.getByRole('textbox', {
    name: 'message',
    exact: true,
  });
  await homeMessage.click();
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.getAttribute('aria-label') ?? '',
    ),
    'message',
  );
  await page.keyboard.type('focused');
  assert.equal(await homeMessage.inputValue(), 'focused');
  assert.equal(
    await page
      .getByRole('textbox', { name: 'search projects', exact: true })
      .count(),
    0,
  );
  checks.push('choosing no project returns focus to the composer');
  await page.getByRole('button', { name: 'search', exact: true }).click();
  const searchDialog = page.getByRole('dialog', {
    name: 'search',
    exact: true,
  });
  await searchDialog.waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'global search',
  );
  await page.keyboard.type('buffer');
  // The dialog hides the composer from the accessibility tree. Read it directly.
  const composerValue = () =>
    page.evaluate(
      () =>
        document.querySelector('textarea[aria-label="message"]')?.value ?? '',
    );
  assert.equal(await composerValue(), 'focused');
  await searchDialog.getByText('pending buffer').waitFor();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('zzznomatch');
  await searchDialog
    .getByRole('heading', { name: 'no results', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await searchDialog.waitFor({ state: 'hidden' });
  assert.equal(await composerValue(), 'focused');
  checks.push(
    'search focuses its box, finds an assistant reply, and shows no results',
  );
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await page.getByRole('heading', { name: 'focused', exact: true }).waitFor();
  const started = await state();
  const created = started.sessions.find((session) =>
    session.messages.some((item) => item.text === 'focused'),
  );
  assert.equal(created.effort, 'xhigh');
  const workspace = started.workspaces.find(
    (item) => item.id === created.workspaceId,
  );
  assert.equal(workspace.kind, 'scratch');
  checks.push('the first message keeps the thinking depth chosen on home');
  await route('/session/session1');
  await page
    .getByRole('button', { name: 'Fix the reconnect race', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'rename', exact: true }).click();
  const renameBox = page.getByRole('textbox', {
    name: 'session name',
    exact: true,
  });
  await renameBox.waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'session name',
  );
  assert.equal(await renameBox.inputValue(), 'Fix the reconnect race');
  assert.equal(
    await renameBox.evaluate(
      (node) =>
        node.selectionStart === 0 && node.selectionEnd === node.value.length,
    ),
    true,
  );
  await page.keyboard.press('Escape');
  checks.push('rename focuses the name and selects it');
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
  assert.equal(new URL(page.url()).hash, '#/session/session1');
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
