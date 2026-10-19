// The same isolated native journey runs against the development host and a package.
// Every model reply is scripted locally; no installed user profile is opened.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
  rm,
  stat,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setViewport } from './helpers/viewport.mjs';
import { readModelRequests } from './helpers/model-requests.mjs';
import { patience } from './helpers/patience.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const packaged = Boolean(process.env.CIRCLE_DESKTOP_EXECUTABLE);
const output = resolve(
  process.env.CIRCLE_UNIFIED_WORKBENCH_EVIDENCE_DIR ??
    join(
      root,
      'artifacts/unified-workbench',
      packaged ? 'packaged' : 'development',
      new Date().toISOString().replaceAll(':', '-'),
    ),
);
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-unified-workbench-'));
const data = join(temp, 'data');
const workspace = join(data, 'runtime-home', 'workspace');
await mkdir(workspace, { recursive: true });
const file = join(workspace, 'README.md');
const initial = '# isolated workbench\n\noriginal bytes\n';
const saved =
  '# unified native workbench\n\neditor buffer survived drawer navigation\n';
await writeFile(file, initial);
await writeFile(join(workspace, 'AGENTS.md'), '# synthetic local project\n');
// A real paged native catalog: two root files plus 9,999 committed text files.
const catalogCount = 10001;
const bulkDirectory = join(workspace, 'bulk');
await mkdir(bulkDirectory);
const bulkFiles = Array.from({ length: catalogCount - 2 }, (_, index) => ({
  path: `bulk/item-${String(index).padStart(5, '0')}.txt`,
  content: `native-paged-file=${String(index).padStart(5, '0')}\n`,
}));
for (let offset = 0; offset < bulkFiles.length; offset += 128)
  await Promise.all(
    bulkFiles
      .slice(offset, offset + 128)
      .map((item) => writeFile(join(workspace, item.path), item.content)),
  );
const catalogContent = new Map(
  bulkFiles.map((item) => [item.path, item.content]),
);
const rootBefore = await stat(workspace);

const external = join(temp, 'outside-workspace.txt');
const externalOriginal = 'EXPLICIT_EXTERNAL_READ_MARKER original\n';
const externalChanged = 'EXPLICIT_EXTERNAL_READ_MARKER verified\n';
await writeFile(external, externalOriginal);
const exec = promisify(execFile);
const git = async (...args) =>
  (
    await exec('git', ['-C', workspace, ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    })
  ).stdout;
await git('init', '--initial-branch=main');
await git('config', 'user.name', 'Synthetic Circle QA');
await git('config', 'user.email', 'synthetic@example.invalid');
await git('add', '--', 'README.md', 'AGENTS.md', 'bulk');
await git('commit', '-m', 'Create isolated baseline');
const commit = (await git('rev-parse', 'HEAD')).trim();
const originalIndex = (await git('write-tree')).trim();
const requestsPath = join(temp, 'model-requests.jsonl');
const fixture = join(temp, 'model.json');
await writeFile(
  fixture,
  JSON.stringify({
    requestsPath,
    replies: [
      {
        message: {
          id: 'unified-native-answer',
          role: 'assistant',
          content: 'isolated workbench ready',
        },
      },
      {
        message: {
          id: 'external-read',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'external-read-call',
              name: 'read_file',
              args: { file_path: external },
            },
          ],
        },
      },
      {
        message: {
          id: 'external-edit',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'external-edit-call',
              name: 'edit_file',
              args: {
                file_path: external,
                old_string: 'original',
                new_string: 'verified',
              },
            },
          ],
        },
      },
      {
        message: {
          id: 'external-done',
          role: 'assistant',
          content: 'external grant tool turn complete',
        },
      },
      {
        message: {
          id: 'revoked-access',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'revoked-read-call',
              name: 'read_file',
              args: { file_path: external },
            },
            {
              id: 'revoked-edit-call',
              name: 'edit_file',
              args: {
                file_path: external,
                old_string: 'verified',
                new_string: 'SHOULD_NOT_WRITE',
              },
            },
          ],
        },
      },
      {
        message: {
          id: 'revoked-done',
          role: 'assistant',
          content: 'revoked grant tool turn complete',
        },
      },
    ],
  }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
    externalFileSelections: [
      { filePaths: [external] },
      { canceled: true, filePaths: [] },
    ],
  }),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixture,
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
const errors = [];
const check = (name) => {
  checks.push(name);
  console.log('ok', name);
};
let application, page, sessionId, appPid;
let phase = 'launch';
let failure;
let receipt = {
  packaged,
  output,
  checks,
  errors,
  workspaceIsolated: true,
  productionDataAccess: false,
  model: 'local ScriptedModel fixture',
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
try {
  application = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
  });
  appPid = application.process().pid;
  receipt.identity = await application.evaluate(({ app }) => ({
    appPath: app.getAppPath(),
    executablePath: process.execPath,
    packaged: app.isPackaged,
  }));
  receipt.buildHashes = {};
  const built = receipt.identity.appPath;
  for (const file of built.endsWith('.asar')
    ? [built]
    : [
        'dist/main.cjs',
        'dist/preload.cjs',
        'dist/runtime-worker.mjs',
        'dist/renderer/index.html',
      ].map((name) => join(built, name))) {
    receipt.buildHashes[file] = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  }
  page = await application.firstWindow();
  page.setDefaultTimeout(patience(15000));
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  await setViewport(application, page, { width: 1440, height: 950 });
  const state = async () =>
    (await page.evaluate(() => window.circleDesktop.runtimeState())).snapshot;
  sessionId = (await state()).activeSessionId;
  phase = 'scripted-turn';
  const composer = page.getByRole('textbox', { name: 'message', exact: true });
  await composer.fill('verify the isolated native workbench');
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await page.getByText('isolated workbench ready', { exact: true }).waitFor();
  sessionId = (await state()).activeSessionId;
  const session = (await state()).sessions.find(
    (item) => item.id === sessionId,
  );
  receipt.sessionId = sessionId;
  receipt.workspaceId = session.workspaceId;
  assert.equal(
    await realpath(
      (await state()).workspaces.find((item) => item.id === session.workspaceId)
        ?.path,
    ),
    await realpath(workspace),
  );
  check(
    'live native renderer/preload/worker turn uses the scripted model and isolated workspace',
  );
  await composer.fill('unsent conversation draft');
  const composerNode = await composer.elementHandle();
  const mode = (name) =>
    page.getByRole('button', { name: `${name} panel`, exact: true });
  const open = async (name) => {
    const button = mode(name);
    if ((await button.getAttribute('aria-pressed')) !== 'true')
      await button.click();
  };
  phase = 'overview';
  // The overview is a column of its own beside the conversation; the top bar names it
  // and each mode of the work drawer
  await open('overview');
  const overview = page.getByRole('complementary', {
    name: 'overview',
    exact: true,
  });
  await overview
    .getByRole('region', { name: 'environment', exact: true })
    .waitFor();
  await overview.getByRole('region', { name: /^context\b/ }).waitFor();
  for (const name of [
    'overview',
    'files',
    'changes',
    'browser',
    'subagents',
    'terminal',
  ])
    assert.equal(await mode(name).count(), 1);
  const drawer = page.locator('.work-drawer');
  check(
    'the overview sits beside the conversation and the top bar names each mode of the work drawer',
  );
  phase = 'file-drawer';
  await open('files');
  // Renderer completion comes from its actual paged native list, not a test runtime.
  await drawer
    .locator('.file-listing-status')
    .getByText(`${catalogCount} files loaded`, { exact: true })
    .waitFor();
  assert.equal(
    await drawer
      .locator('.file-listing-status')
      .getByText('loading file list…', { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await drawer
      .locator('.file-listing-status')
      .getByText('file list is incomplete', { exact: true })
      .count(),
    0,
  );
  await drawer.locator('.tree-file').filter({ hasText: 'README.md' }).click();
  const editor = drawer.locator('.native-code-editor').first();
  await editor.locator('.view-lines').first().waitFor();
  assert.equal(
    await page.locator('.main-stack > .file-view').count(),
    0,
    'file details belong to drawer',
  );
  const editorNode = await editor.elementHandle();
  await editor.locator('.view-lines').first().click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+a' : 'Control+a',
  );
  await page.keyboard.insertText(saved);
  await drawer.getByText('unsaved changes', { exact: true }).waitFor();
  assert.equal(
    await readFile(file, 'utf8'),
    initial,
    'unsaved buffer is not a filesystem write',
  );
  check(
    'real granted workspace file opens in drawer; editing keeps disk unchanged before save',
  );
  phase = 'native-catalog-paging';
  const catalog = await page.evaluate(async (workspaceId) => {
    let cursor;
    const files = [];
    const pages = [];
    let workspaceHandle;
    do {
      const part = await window.circleDesktop.listWorkspace(
        workspaceId,
        cursor,
      );
      if (!part) throw Error('native catalog is unavailable');
      workspaceHandle = part.id;
      pages.push({
        count: part.files.length,
        complete: part.complete,
        truncated: part.truncated,
        hasContinuation: !!part.nextCursor,
      });
      files.push(...part.files);
      cursor = part.nextCursor;
    } while (cursor);
    return { files, pages, workspaceHandle };
  }, session.workspaceId);
  assert.equal(catalog.files.length, catalogCount);
  assert.equal(
    new Set(catalog.files.map((item) => item.path)).size,
    catalogCount,
  );
  assert.ok(catalog.pages.length > 1);
  assert.ok(
    catalog.pages.every((part) => part.count <= 2000 && !part.truncated),
  );
  assert.equal(catalog.pages.at(-1).complete, true);
  assert.equal(catalog.pages.at(-1).hasContinuation, false);
  const lateFile = catalog.files.find(
    (item, index) => index >= 9000 && catalogContent.has(item.path),
  );
  assert.ok(
    lateFile,
    'the chosen actual file must occur beyond native page four',
  );
  const expectedLateContent = catalogContent.get(lateFile.path);
  assert.equal(await editorNode.evaluate((node) => node.isConnected), true);
  await drawer.getByText('unsaved changes', { exact: true }).waitFor();
  assert.equal(await readFile(file, 'utf8'), initial);
  assert.equal(await composer.inputValue(), 'unsent conversation draft');
  assert.equal((await git('write-tree')).trim(), originalIndex);
  const rootAfterPaging = await stat(workspace);
  assert.equal(
    `${rootAfterPaging.dev}:${rootAfterPaging.ino}`,
    `${rootBefore.dev}:${rootBefore.ino}`,
  );
  assert.equal(
    (await readModelRequests(requestsPath, { requireComplete: true })).length,
    1,
  );
  receipt.nativeCatalog = {
    count: catalog.files.length,
    pages: catalog.pages,
    latePath: lateFile.path,
    lateOrdinal: catalog.files.indexOf(lateFile),
    complete: true,
    truncated: false,
    retainedUnsavedEditor: true,
    retainedComposerDraft: true,
    indexUnchanged: true,
    workspaceRootIdentityUnchanged: true,
  };
  check(
    'real native catalog pages all10,001 committed files through preload/main; editor draft, root identity and Git index survive',
  );
  phase = 'drawer-continuity';
  // The full view and back, the overview put away and shown again, and another mode
  // shown in the drawer: the composer, its draft and the unsaved editor are the same
  await drawer.getByRole('button', { name: 'full view', exact: true }).click();
  await drawer
    .getByRole('button', { name: 'exit full view', exact: true })
    .click();
  assert.equal(await composer.inputValue(), 'unsent conversation draft');
  assert.equal(await composerNode.evaluate((node) => node.isConnected), true);
  assert.equal(await editorNode.evaluate((node) => node.isConnected), true);
  // A wide file can have made the overview step aside: show it and put it away, or the
  // other way round
  const overviewShown =
    (await mode('overview').getAttribute('aria-pressed')) === 'true';
  for (const shown of overviewShown ? [false, true] : [true, false]) {
    await mode('overview').click();
    await overview.waitFor({ state: shown ? 'visible' : 'detached' });
  }
  await open('changes');
  await drawer.locator('.changes-mode').waitFor();
  await open('files');
  assert.equal(await editorNode.evaluate((node) => node.isConnected), true);
  assert.equal(await composerNode.evaluate((node) => node.isConnected), true);
  await drawer.getByText('unsaved changes', { exact: true }).waitFor();
  check(
    'full view, the overview and mode changes retain composer DOM, draft and unsaved editor instance',
  );
  phase = 'index-resize';
  // The full view has room for the tree beside the open file
  await drawer.getByRole('button', { name: 'full view', exact: true }).click();
  const resizeIndex = drawer.getByRole('separator', {
    name: 'resize context index',
    exact: true,
  });
  await resizeIndex.press('Home');
  const indexMinimum = Number(await resizeIndex.getAttribute('aria-valuenow'));
  await resizeIndex.press('ArrowLeft');
  assert.equal(
    Number(await resizeIndex.getAttribute('aria-valuenow')),
    indexMinimum + 16,
  );
  const beforeIndexDrag = await drawer.evaluate(
    (node) => node.getBoundingClientRect().width,
  );
  const resizeBounds = await resizeIndex.boundingBox();
  await page.mouse.move(
    resizeBounds.x + resizeBounds.width / 2,
    resizeBounds.y + 40,
  );
  await page.mouse.down();
  await page.mouse.move(resizeBounds.x - 32, resizeBounds.y + 40, { steps: 4 });
  await page.mouse.up();
  const nativeIndexWidth = Number(
    await resizeIndex.getAttribute('aria-valuenow'),
  );
  assert.ok(nativeIndexWidth > indexMinimum + 16);
  assert.equal(
    await drawer.evaluate((node) => node.getBoundingClientRect().width),
    beforeIndexDrag,
  );
  await drawer
    .getByRole('button', { name: 'exit full view', exact: true })
    .click();
  assert.equal(await editorNode.evaluate((node) => node.isConnected), true);
  assert.equal(await composer.inputValue(), 'unsent conversation draft');
  receipt.contextIndex = {
    keyboardStep: 16,
    pointerWidth: nativeIndexWidth,
    independentDrawerWidth: true,
    retainedEditorAndDraft: true,
  };
  check(
    'native context-index pointer/keyboard resizing keeps drawer width, editor instance and composer draft',
  );
  phase = 'save';
  await drawer.getByRole('button', { name: 'save', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.file-view-state.dirty'),
  );
  assert.equal(await readFile(file, 'utf8'), saved);
  assert.equal((await git('diff', '--cached')).trim(), '');
  receipt.file = {
    path: 'README.md',
    before: createHash('sha256').update(initial).digest('hex'),
    after: createHash('sha256').update(saved).digest('hex'),
    actualBytesMatch: true,
    gitIndexUnchanged: true,
  };
  check(
    'explicit save writes exact bytes while leaving the Git index untouched',
  );
  phase = 'native-late-file-navigation';
  // The tree is beside the open file while the drawer has room for both (the overview
  // shown above made it give way); otherwise the file has the drawer, and the tree comes
  // back when the file closes
  const nativeTree = drawer.getByRole('tree', { name: 'files', exact: true });
  const showTree = async () => {
    if (!(await nativeTree.isVisible()))
      await drawer
        .getByRole('button', { name: 'close file', exact: true })
        .click();
    await nativeTree.waitFor();
  };
  await showTree();
  await nativeTree.getByRole('treeitem', { name: 'bulk', exact: true }).click();
  await nativeTree.press('End');
  const maximumMountedNativeRows = await nativeTree
    .getByRole('treeitem')
    .count();
  assert.ok(
    maximumMountedNativeRows < 100,
    'native10k catalog keeps bounded mounted tree rows',
  );
  const nativeFilter = drawer.getByRole('textbox', {
    name: 'filter files',
    exact: true,
  });
  await nativeFilter.fill(lateFile.path);
  await nativeTree
    .getByRole('treeitem', { name: lateFile.path, exact: true })
    .click();
  await page.waitForFunction(
    (expected) =>
      [
        ...document.querySelectorAll(
          '.work-drawer .native-code-editor .view-lines',
        ),
      ].some((node) => node.textContent.includes(expected)),
    expectedLateContent.trim(),
  );
  const grantedLateRead = await page.evaluate(
    ({ workspaceHandle, fileId }) =>
      window.circleDesktop.readWorkspaceFile(workspaceHandle, fileId),
    { workspaceHandle: catalog.workspaceHandle, fileId: lateFile.id },
  );
  assert.equal(grantedLateRead.content, expectedLateContent);
  assert.equal(grantedLateRead.truncated, false);
  assert.equal(
    await readFile(join(workspace, lateFile.path), 'utf8'),
    expectedLateContent,
  );
  assert.equal((await git('write-tree')).trim(), originalIndex);
  assert.equal(await composer.inputValue(), 'unsent conversation draft');
  assert.equal(
    (await readModelRequests(requestsPath, { requireComplete: true })).length,
    1,
  );
  receipt.nativeCatalog.lateFileSelectedAndOpened = true;
  receipt.nativeCatalog.lateFileActualBytesMatch = true;
  receipt.nativeCatalog.maximumMountedRows = maximumMountedNativeRows;
  check(
    'an actual file beyond native page four opens its exact disk bytes from bounded file index without a model request',
  );
  // Return to the saved baseline document for the remaining changes/theme journeys.
  await showTree();
  await nativeFilter.fill('README.md');
  await nativeTree
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .click();
  await drawer
    .locator('.file-view')
    .getByText('README.md', { exact: true })
    .first()
    .waitFor();
  // The open file can have the drawer to itself again, and the filter with the tree
  if (await nativeFilter.isVisible()) await nativeFilter.fill('');
  // The Git panel and its history went with the window's staging and committing: the
  // changes mode is one list of what differs from the last commit, and authors nothing.
  phase = 'changes';
  await open('changes');
  const changesMode = drawer.locator('.changes-mode');
  await changesMode
    .getByRole('button', { name: 'all uncommitted', exact: true })
    .click();
  const savedRow = changesMode
    .getByRole('list', { name: 'changed files', exact: true })
    .getByRole('button', { name: /README\.md/ });
  await savedRow.click();
  assert.equal(await savedRow.locator('.overview-letter').innerText(), 'M');
  await changesMode
    .locator('.changes-diff')
    .getByText('editor buffer survived drawer navigation')
    .first()
    .waitFor();
  await changesMode
    .getByRole('button', { name: 'open file', exact: true })
    .waitFor();
  assert.equal((await git('diff', '--cached')).trim(), '');
  assert.equal((await git('write-tree')).trim(), originalIndex);
  assert.equal((await git('rev-parse', 'HEAD')).trim(), commit);
  assert.equal(await readFile(file, 'utf8'), saved);
  receipt.changes = {
    commit,
    listedModified: true,
    differenceShown: true,
    diskUnchanged: true,
    indexUnchanged: true,
  };
  check(
    'the changes mode lists the saved file as changed since the last commit, with its difference, and stages nothing',
  );
  phase = 'themes';
  for (const theme of ['dark', 'light']) {
    await page.evaluate(() => {
      location.hash = '/page/settings';
    });
    await page.locator('.settings-index').waitFor();
    const settingsSearch = page.locator('.settings-index input');
    await settingsSearch.fill('appearance');
    await page.locator('.settings-index-list button').first().click();
    await page
      .getByRole('group', { name: 'theme', exact: true })
      .getByRole('button', { name: theme, exact: true })
      .click();
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    await page.screenshot({
      path: join(output, `settings-${theme}.png`),
      animations: 'disabled',
    });
    await page.evaluate((id) => {
      location.hash = `/session/${id}`;
    }, sessionId);
    await composer.waitFor();
    assert.equal(await composer.inputValue(), 'unsent conversation draft');
    await open('files');
    await editor.locator('.view-lines').first().waitFor();
    // A mode has no title bar: the open file's heading names it
    assert.equal(
      await drawer
        .locator('.file-view-heading')
        .evaluate((node) => getComputedStyle(node).visibility),
      'visible',
    );
    await page.screenshot({
      path: join(output, `drawer-${theme}.png`),
      animations: 'disabled',
    });
    // The full view has room for the tree beside the open file
    await drawer
      .getByRole('button', { name: 'full view', exact: true })
      .click();
    const indexOverlap = await drawer
      .locator('.drawer-context-index')
      .evaluate((index) => {
        const bounds = index.getBoundingClientRect();
        return [
          ...index.querySelectorAll(
            '.panel-header-name, .panel-header-actions',
          ),
        ]
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              (rect.left < bounds.left ||
                rect.right > bounds.right ||
                rect.top < bounds.top ||
                rect.bottom > bounds.bottom)
            );
          })
          .map((node) => node.className);
      });
    assert.deepEqual(
      indexOverlap,
      [],
      'local index chrome must stay inside its index instead of overlapping document controls',
    );
    await page.screenshot({
      path: join(output, `drawer-index-${theme}.png`),
      animations: 'disabled',
    });
    await drawer
      .getByRole('button', { name: 'exit full view', exact: true })
      .click();
  }
  check(
    'native settings index navigates appearance and dark/light themes; session draft survives navigation',
  );
  phase = 'explicit-external-file-grant';
  const nativeCommand = async (name, payload = {}, owner = sessionId) => {
    const reply = await page.evaluate(
      ({ name, payload, owner }) =>
        window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name,
          sessionId: owner,
          payload,
        }),
      { name, payload, owner },
    );
    assert.equal(reply.ok, true, `${name}: ${JSON.stringify(reply)}`);
    return reply;
  };
  const other = await nativeCommand('new-session');
  assert.equal(other.ok, true);
  const otherSessionId = other.data.sessionId;
  // An empty unnamed session is intentionally disposable; name this genuine peer
  // before leaving it so the ownership check targets an existing runtime.
  await page.evaluate((id) => {
    location.hash = `/session/${id}`;
  }, otherSessionId);
  await nativeCommand(
    'rename-session',
    { id: otherSessionId, title: 'external grant isolation peer' },
    otherSessionId,
  );
  assert.ok(
    (await state()).sessions.some(
      (row) =>
        row.id === otherSessionId &&
        row.title === 'external grant isolation peer',
    ),
  );

  assert.equal(
    (await nativeCommand('select-session', { id: sessionId }, otherSessionId))
      .ok,
    true,
  );
  await page.evaluate((id) => {
    location.hash = `/session/${id}`;
  }, sessionId);
  await composer.waitFor();
  assert.ok(
    (await state()).sessions.some((row) => row.id === otherSessionId),
    'the foreign-session registry belongs to a live retained session',
  );
  const grant = await page.evaluate(
    (id) => window.circleDesktop.requestExternalFileGrant(id, 'readwrite'),
    sessionId,
  );
  assert.ok(grant?.id);
  assert.equal(grant.sessionId, sessionId);
  assert.equal(await realpath(grant.path), await realpath(external));
  assert.equal(grant.access, 'readwrite');
  const listed = await nativeCommand('list-external-file-grants');
  assert.equal(listed.ok, true);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].id, grant.id);
  assert.deepEqual(
    (await nativeCommand('list-external-file-grants', {}, otherSessionId)).data,
    [],
  );
  assert.equal(
    (
      await nativeCommand(
        'revoke-external-file-grant',
        { id: grant.id },
        otherSessionId,
      )
    ).data.revoked,
    false,
  );
  assert.equal(
    (await nativeCommand('list-external-file-grants')).data[0].id,
    grant.id,
    'another session cannot see or revoke the live grant',
  );
  const noModelRequests = (
    await readModelRequests(requestsPath, { requireComplete: true })
  ).length;
  assert.equal(
    noModelRequests,
    1,
    'native chooser grant and listing cannot send a model request',
  );
  const sendToolTurn = async (prompt, finalText) => {
    await composer.fill(prompt);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
    const answer = page.getByText(finalText, { exact: true });
    const allow = page
      .getByRole('button', { name: 'allow once', exact: true })
      .first();
    for (let count = 0; count < 6; count++) {
      await Promise.race([answer.waitFor(), allow.waitFor()]);
      if (await answer.isVisible()) break;
      await allow.click();
    }
    await answer.waitFor();
  };
  await sendToolTurn(
    'Read then edit the explicitly granted synthetic external file.',
    'external grant tool turn complete',
  );
  assert.equal(await readFile(external, 'utf8'), externalChanged);
  const afterGrant = (await state()).sessions.find(
    (row) => row.id === sessionId,
  );
  const readReceipt = afterGrant.messages.find(
    (row) => row.tool?.id === 'external-read-call',
  )?.tool;
  const editReceipt = afterGrant.messages.find(
    (row) => row.tool?.id === 'external-edit-call',
  )?.tool;
  assert.equal(readReceipt?.status, 'success');
  assert.match(readReceipt.output, /EXPLICIT_EXTERNAL_READ_MARKER original/);
  assert.equal(editReceipt?.status, 'success');
  check(
    'OS-picker exact-file grant reaches actual native read_file/edit_file tools and writes only the selected external file',
  );
  const revoked = await nativeCommand('revoke-external-file-grant', {
    id: grant.id,
  });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.data.revoked, true);
  assert.deepEqual((await nativeCommand('list-external-file-grants')).data, []);
  await sendToolTurn(
    'Try reading and editing the revoked synthetic external file; report both tool outcomes.',
    'revoked grant tool turn complete',
  );
  assert.equal(
    await readFile(external, 'utf8'),
    externalChanged,
    'revoked read/edit cannot alter the external file',
  );
  const afterRevoke = (await state()).sessions.find(
    (row) => row.id === sessionId,
  );
  for (const id of ['revoked-read-call', 'revoked-edit-call']) {
    const tool = afterRevoke.messages.find((row) => row.tool?.id === id)?.tool;
    assert.ok(tool, id);
    assert.ok(
      ['error', 'rejected'].includes(tool.status),
      JSON.stringify(tool),
    );
  }
  assert.deepEqual(
    (await nativeCommand('list-external-file-grants', {}, otherSessionId)).data,
    [],
  );
  assert.equal(
    (
      await nativeCommand(
        'revoke-external-file-grant',
        { id: grant.id },
        otherSessionId,
      )
    ).data.revoked,
    false,
  );
  assert.equal(
    (await nativeCommand('select-session', { id: sessionId }, otherSessionId))
      .ok,
    true,
  );
  await page.evaluate((id) => {
    location.hash = `/session/${id}`;
  }, sessionId);
  await composer.waitFor();
  const cancelled = await page.evaluate(
    (id) => window.circleDesktop.requestExternalFileGrant(id, 'read'),
    sessionId,
  );
  assert.equal(cancelled, null);
  assert.deepEqual((await nativeCommand('list-external-file-grants')).data, []);
  await composer.fill('unsent conversation draft');
  receipt.externalFile = {
    exactPath: external,
    grantedSession: sessionId,
    access: grant.access,
    readToolSucceeded: true,
    editToolSucceeded: true,
    revokedReadAndEditDenied: true,
    crossSessionListEmpty: true,
    cancellationCreatedNoGrant: true,
    actualBytes: createHash('sha256')
      .update(await readFile(external))
      .digest('hex'),
  };
  check(
    'revocation blocks real model read/edit effects; other-session registry stays empty and cancelled picker grants nothing',
  );
  const requests = await readModelRequests(requestsPath, {
    requireComplete: true,
  });
  assert.equal(
    requests.length,
    6,
    'only the initial turn and two explicit scripted external-tool turns may request the model',
  );
  receipt.modelRequests = requests.length;
  assert.deepEqual(errors, []);
  phase = 'complete';
} catch (error) {
  failure = error;
  receipt.failure = { phase, message: String(error), stack: error.stack };
  if (page && !page.isClosed())
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
} finally {
  await application?.close().catch((error) => {
    receipt.closeFailure = String(error);
    failure ??= error;
  });
  receipt.process = { pid: appPid, exited: !appPid || !alive(appPid) };
  if (!receipt.process.exited)
    failure ??= Error('native application process did not exit');
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      { ...receipt, phase, status: failure ? 'failed' : 'passed' },
      null,
      2,
    ) + '\n',
  );
  await rm(temp, { recursive: true, force: true });
}
if (failure) throw failure;
assert.equal(
  receipt.process.exited,
  true,
  'native application process must exit',
);
console.log(
  `unified workbench ${packaged ? 'packaged' : 'development'}: ${checks.length} checks passed; ${output}`,
);
