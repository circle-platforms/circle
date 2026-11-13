// The real desktop app uses the selected checkout for both model tools and terminal tabs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { waitDesktopReady } from './helpers/desktop-readiness.mjs';
import { readModelRequests } from './helpers/model-requests.mjs';
import { closeNativeSettings } from './helpers/native-settings.mjs';
import { patience } from './helpers/patience.mjs';
import { setViewport } from './helpers/viewport.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const packaged = Boolean(process.env.CIRCLE_DESKTOP_EXECUTABLE);
const output = resolve(
  process.env.WORKTREE_MENU_SCREENSHOTS ??
    join(
      root,
      '../../outputs/worktree-menu',
      packaged ? 'packaged' : 'development',
    ),
);
await mkdir(output, { recursive: true });
const temp = await realpath(
  await mkdtemp(join(tmpdir(), 'circle-worktree-menu-')),
);
const project = join(temp, 'orbit');
const destination = join(temp, 'orbit-editor-selection');
const data = join(temp, 'data');
const home = join(data, 'runtime-home');
const shellConfig = join(temp, 'shell-config');
const requests = join(temp, 'requests.jsonl');
const fixture = join(temp, 'model.json');
const base = 'feat/keyboard-navigation';
const target = 'fix/editor-selection';
const beforeMessage = '检查键盘导航的改动。';
const beforeAnswer = '已在工作树中检查键盘导航。';
const afterMessage = '继续检查编辑器选择。';
const afterAnswer = '已在当前工作树中检查编辑器选择。';
const reusedAnswer = '已使用已有工作树。';
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'cli-home'),
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'zh-CN',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({ workspace: project }),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixture,
  GIT_CONFIG_GLOBAL: join(temp, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  ...(process.platform === 'darwin' ? { ZDOTDIR: shellConfig } : {}),
};
delete env.ELECTRON_RUN_AS_NODE;
if (packaged && process.platform !== 'win32')
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Circle Fixture',
      '-c',
      'user.email=circle-fixture@example.invalid',
      ...args,
    ],
    {
      cwd,
      env,
      encoding: 'utf8',
    },
  ).trim();
const countWorktrees = () =>
  git(project, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length;
const writeSource = (cwd, bytes) => writeFile(join(cwd, 'source.txt'), bytes);
const commitSource = (cwd, message) => {
  git(cwd, 'add', 'source.txt');
  git(cwd, 'commit', '-qm', message);
};
const reply = (id, content, read = false) => ({
  message: {
    id,
    role: 'assistant',
    content,
    ...(read
      ? {
          tool_calls: [
            {
              id: id + '-read',
              name: 'read_file',
              args: { file_path: 'source.txt' },
            },
          ],
        }
      : {}),
  },
});

let app;
let page;
let popout;
let passed = false;
const errors = [];
try {
  await mkdir(project);
  await mkdir(home, { recursive: true });
  if (process.platform === 'darwin') {
    await mkdir(shellConfig);
    await writeFile(join(shellConfig, '.zshrc'), "PROMPT='%1~ %% '\n");
  }
  git(project, 'init', '-qb', 'main');
  await writeSource(project, 'original main bytes\n');
  commitSource(project, 'Start the Orbit repository');
  git(project, 'switch', '-qc', base);
  await writeSource(project, 'selected starting branch bytes\n');
  commitSource(project, 'Add keyboard navigation');
  git(project, 'switch', '-q', 'main');
  for (const branch of [
    'docs/editor-shortcuts',
    'feat/command-palette',
    'feat/keyboard-shortcuts',
    'feat/search-palette',
    'fix/sidebar-focus',
  ])
    git(project, 'branch', branch);
  git(project, 'worktree', 'add', '-qb', target, destination, 'main');
  await writeSource(destination, 'existing destination checkout bytes\n');
  commitSource(destination, 'Update editor selection');
  await writeFile(
    join(destination, 'selection-notes.txt'),
    'ORBIT_SELECTION_NOTES\n',
  );
  await writeFile(
    join(home, 'settings.json'),
    JSON.stringify({ trusted_folders: [project], theme: 'light' }),
  );
  await writeFile(
    fixture,
    JSON.stringify({
      requestsPath: requests,
      replies: [
        reply('before', '', true),
        reply('started', beforeAnswer),
        reply('after', '', true),
        reply('moved', afterAnswer),
        reply('reused', reusedAnswer),
      ],
    }),
  );

  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(patience(15000));
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fit = (width) =>
    setViewport(app, page, { width, height: 900 }, { show: true });
  await fit(1440);

  const state = () =>
    page.evaluate(
      async () => (await window.circleDesktop.runtimeState()).snapshot,
    );
  const button = (name) => page.getByRole('button', { name, exact: true });
  const menuItem = (name) => page.getByRole('menuitem', { name, exact: true });
  const message = () => page.locator('.composer textarea');
  const checkbox = () => page.getByRole('checkbox', { name: '工作树' });
  const projectMenu = () => button('选择项目');
  const branchMenu = () => menuItem('起始分支');
  const move = () => menuItem('在工作树中继续…');
  const shot = (name) =>
    page.screenshot({
      path: join(output, name + '.png'),
      animations: 'disabled',
    });
  const send = async (text, answer) => {
    await message().fill(text);
    await button('发送消息').click();
    await page.getByText(answer, { exact: true }).waitFor();
  };
  const sessionReady = async (id, branch) => {
    const { sample } = await waitDesktopReady(
      async () => {
        const snapshot = await state();
        const row = snapshot.sessions.find((session) => session.id === id);
        return { active: snapshot.activeSessionId, row };
      },
      ({ active, row }) =>
        active === id &&
        row?.state === 'idle' &&
        (typeof branch === 'string'
          ? row.executionBranch === branch
          : branch(row.executionBranch)),
      {
        label: 'execution checkout is ready',
        timeoutMs: patience(15000),
        stableMs: 0,
      },
    );
    return sample.row;
  };
  const setTheme = async (theme) => {
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+,' : 'Control+,',
    );
    const settings = page.locator('.settings-dialog');
    await settings
      .getByRole('button', {
        name: theme === 'light' ? '浅色' : '深色',
        exact: true,
      })
      .click();
    await page.waitForFunction(
      (value) => document.documentElement.dataset.theme === value,
      theme,
    );
    assert.equal(await closeNativeSettings(page), true);
  };
  const assertToolRead = async (call, bytes) => {
    const log = await readModelRequests(requests, { requireComplete: true });
    const result = log
      .flatMap((request) => request.messages)
      .find((entry) => entry.role === 'tool' && entry.tool_call_id === call);
    assert.ok(String(result?.content).includes(bytes), JSON.stringify(result));
  };

  await message().waitFor();
  await setTheme('light');
  await projectMenu().click();
  await menuItem('打开文件夹…').click();
  await checkbox().waitFor();
  assert.equal(countWorktrees(), 2);
  await checkbox().check();
  await projectMenu().click();
  await branchMenu().click();
  const search = page.getByRole('textbox', { name: '搜索分支' });
  await search.fill('keyboard');
  await menuItem(base).waitFor();
  await menuItem('feat/keyboard-shortcuts').waitFor();
  assert.equal(await menuItem('feat/search-palette').count(), 0);
  await search.clear();
  await menuItem('feat/search-palette').waitFor();
  await shot('02-search-branches');
  await search.fill('keyboard');
  await search.press('ArrowDown');
  assert.equal(
    await menuItem(base).evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press('Enter');
  assert.equal(await checkbox().isChecked(), true);
  assert.equal(
    countWorktrees(),
    2,
    'configuring the draft creates no checkout',
  );
  await message().fill(beforeMessage);
  await shot('01-new-conversation');
  await send(beforeMessage, beforeAnswer);
  const id = (await state()).activeSessionId;
  const generated = await sessionReady(id, (branch) =>
    Boolean(branch && branch !== 'main'),
  );
  assert.equal(countWorktrees(), 3);
  assert.equal(
    git(generated.executionPath, 'rev-parse', 'HEAD'),
    git(project, 'rev-parse', base),
  );
  assert.equal(git(project, 'branch', '--show-current'), 'main');
  await assertToolRead('before-read', 'selected starting branch bytes');
  await writeFile(
    join(generated.executionPath, 'local-notes.txt'),
    'unsaved workspace notes\n',
  );
  const overview = page.locator('.overview');
  const oldChange = overview.getByText('local-notes.txt', { exact: true });
  await oldChange.waitFor();

  // The session's action is reachable from the title menu at a narrower width.
  await fit(1000);
  await page.locator('.session-title button').click();
  await move().waitFor();
  await page.keyboard.press('Escape');
  await fit(1440);
  const openBranch = () => page.locator('button.project-chip').click();
  await openBranch();
  await menuItem('复制分支名称').waitFor();
  await menuItem('在终端打开').waitFor();
  await shot('03-session-branch-menu');
  await move().click();
  const dialog = page.getByRole('dialog', { name: '在工作树中继续…' });
  await dialog.getByRole('button', { name: new RegExp(target) }).waitFor();
  await shot('04-target-list');
  await dialog
    .getByRole('textbox', { name: '搜索工作树' })
    .fill('editor-selection');
  await dialog.getByRole('button', { name: new RegExp(target) }).click();
  assert.equal(
    (await state()).sessions.find((row) => row.id === id).executionPath,
    generated.executionPath,
  );
  await shot('04-confirm-move');
  await dialog.getByRole('button', { name: '继续', exact: true }).click();
  const moved = await sessionReady(id, target);
  assert.equal(await realpath(moved.executionPath), destination);
  assert.equal(moved.workspaceId, generated.workspaceId);
  await page.getByText(beforeAnswer, { exact: true }).waitFor();
  assert.equal(
    await readFile(join(generated.executionPath, 'local-notes.txt'), 'utf8'),
    'unsaved workspace notes\n',
  );
  await assert.rejects(readFile(join(destination, 'local-notes.txt')), {
    code: 'ENOENT',
  });
  await overview.getByText('selection-notes.txt', { exact: true }).waitFor();
  await oldChange.waitFor({ state: 'hidden' });
  await send(afterMessage, afterAnswer);
  await assertToolRead('after-read', 'existing destination checkout bytes');
  const files = button('文件 面板');
  await files.click();
  await page.getByRole('textbox', { name: '查找文件' }).fill('selection-notes');
  await page.getByRole('treeitem', { name: /selection-notes\.txt/ }).click();
  await page
    .locator('.monaco-editor .view-lines')
    .getByText('ORBIT_SELECTION_NOTES', { exact: true })
    .waitFor();
  await button('关闭文件').click();
  if ((await files.getAttribute('aria-pressed')) === 'true')
    await files.click();

  await setTheme('dark');
  await openBranch();
  await menuItem('在终端打开').waitFor();
  await shot('05-session-branch-menu-dark');
  await menuItem('在终端打开').click();
  const shells = () =>
    page.evaluate(async (sessionId) => {
      const reply = await window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        name: 'workspace-service',
        sessionId,
        payload: { service: 'terminal', method: 'list', params: {} },
      });
      if (!reply.ok) throw Error(reply.error);
      return reply.data.filter((row) => row.kind === 'shell' && !row.hidden);
    }, id);
  const waitForShells = async (count) => {
    const { sample } = await waitDesktopReady(
      shells,
      (rows) =>
        rows.length === count && rows.every((row) => row.status === 'running'),
      {
        label: `${count} terminal tabs open in the conversation`,
        timeoutMs: patience(15000),
        stableMs: 0,
      },
    );
    return sample;
  };
  const [shell] = await waitForShells(1);
  assert.equal(await realpath(shell.cwd), destination);
  const tabFor = (window, terminalId) =>
    window.locator(`[role="tab"][aria-controls="terminal-${terminalId}"]`);
  const terminalInput = (window, terminalId) =>
    window.locator(`#terminal-${terminalId} .xterm-helper-textarea`);
  const runTerminalCommand = async (window, terminalId, command, expected) => {
    await window.keyboard.type(command);
    await window.keyboard.press('Enter');
    await window
      .locator(`#terminal-${terminalId} .xterm-rows`)
      .getByText(expected, { exact: true })
      .waitFor();
  };
  const runBranch = (window, terminalId) =>
    runTerminalCommand(window, terminalId, 'git branch --show-current', target);
  await tabFor(page, shell.id).waitFor();
  await terminalInput(page, shell.id).focus();
  await runBranch(page, shell.id);
  await shot('06-terminal-dark');

  await openBranch();
  await move().and(page.locator('[aria-disabled="true"]')).waitFor();
  await page.keyboard.press('Escape');

  [popout] = await Promise.all([
    app.waitForEvent('window'),
    button('在单独窗口打开').click(),
  ]);
  popout.setDefaultTimeout(patience(15000));
  popout.on('pageerror', (error) => errors.push(String(error)));
  await popout.waitForURL((url) => url.hash === `#/popout/terminal/${id}`);
  const oldTab = tabFor(popout, shell.id);
  await oldTab.and(popout.locator('[aria-selected="true"]')).waitFor();
  const focusWindow = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getFocusedWindow()?.webContents.getURL(),
    );
  const waitForFocus = (window, label) =>
    waitDesktopReady(focusWindow, (url) => url === window.url(), {
      label,
      timeoutMs: patience(15000),
      stableMs: 0,
    });
  await app.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows()
      .find((candidate) => candidate.webContents.getURL() === url)
      .focus();
  }, page.url());
  await waitForFocus(
    page,
    'the main window has focus before the branch action',
  );
  await openBranch();
  await menuItem('在终端打开').click();
  const rows = await waitForShells(2);
  const newShell = rows.find((row) => row.id !== shell.id);
  assert.ok(newShell, 'the action creates a different terminal');
  assert.equal(await realpath(newShell.cwd), destination);
  await waitForFocus(popout, 'the detached terminal is brought to the front');
  assert.equal(
    app.windows().filter((window) => window.url() === popout.url()).length,
    1,
  );
  await tabFor(popout, newShell.id)
    .and(popout.locator('[aria-selected="true"]'))
    .waitFor();
  await oldTab.and(popout.locator('[aria-selected="false"]')).waitFor();
  await popout.waitForFunction(
    (terminalId) =>
      document.activeElement?.matches(
        `#terminal-${terminalId} .xterm-helper-textarea`,
      ),
    newShell.id,
  );
  await runBranch(popout, newShell.id);
  await popout.screenshot({
    path: join(output, '08-popout-terminal.png'),
    animations: 'disabled',
  });
  await oldTab.click();
  await oldTab.and(popout.locator('[aria-selected="true"]')).waitFor();
  // The popout resizes the old shell. Its viewport is not its saved output.
  assert.ok((await readFile(shell.logPath, 'utf8')).includes(target));
  await terminalInput(popout, shell.id).focus();
  await runTerminalCommand(
    popout,
    shell.id,
    'git rev-parse --short HEAD',
    git(destination, 'rev-parse', '--short', 'HEAD'),
  );
  await Promise.all([
    popout.waitForEvent('close'),
    popout.getByRole('button', { name: '放回抽屉', exact: true }).click(),
  ]);
  await tabFor(page, shell.id).waitFor();
  await tabFor(page, newShell.id).waitFor();
  await button('终端 面板').click();
  await button('新会话').click();
  await projectMenu().click();
  await menuItem('使用已有工作树').click();
  const existing = page.getByRole('menuitem', { name: new RegExp(target) });
  await existing.waitFor();
  await shot('07-existing-worktree-dark');
  await existing.click();
  assert.equal(await checkbox().isChecked(), true);
  assert.equal(countWorktrees(), 3);
  await send('使用已有工作树开始一个新会话。', reusedAnswer);
  const reusedId = (await state()).activeSessionId;
  assert.notEqual(reusedId, id);
  const reused = await sessionReady(reusedId, target);
  assert.equal(await realpath(reused.executionPath), destination);
  assert.equal(countWorktrees(), 3, 'reusing a checkout creates no checkout');

  // A local page named in the moved conversation comes from the actual checkout.
  await writeFile(
    join(project, 'review.html'),
    '<title>ORBIT_ORIGIN_PAGE</title>',
  );
  await writeFile(
    join(project, 'origin-only.html'),
    '<title>ORBIT_ORIGIN_ONLY</title>',
  );
  await writeFile(
    join(destination, 'review.html'),
    '<title>ORBIT_WORKTREE_PAGE</title>',
  );
  const pageAddress = (path) =>
    page.evaluate(
      ({ id, path }) => window.circleDesktop.browserLocalPage(id, path),
      { id, path },
    );
  await assert.rejects(pageAddress('origin-only.html'), /file does not exist/);
  await assert.rejects(
    page.evaluate(
      ({ reusedId, id }) =>
        window.circleDesktop.browserLocalPage(reusedId, 'review.html', id),
      { reusedId, id },
    ),
    /workspace not found/,
  );
  const reviewUrl = await pageAddress('review.html');
  await page.evaluate(
    ({ id, url }) => window.circleDesktop.browserNavigate(id, url),
    { id, url: reviewUrl },
  );
  await waitDesktopReady(
    () => page.evaluate((id) => window.circleDesktop.browserState(id), id),
    (browser) =>
      browser.url === reviewUrl &&
      browser.title === 'ORBIT_WORKTREE_PAGE' &&
      !browser.loading,
    {
      label: 'the moved conversation loads the worktree version of the page',
      timeoutMs: patience(15000),
      stableMs: 0,
    },
  );
  assert.deepEqual(errors, []);
  passed = true;
  console.log(
    `worktree menus passed in the ${packaged ? 'packaged' : 'development'} app`,
  );
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  if (popout && !popout.isClosed())
    await popout
      .screenshot({ path: join(output, 'popout-failure.png') })
      .catch(() => {});
  console.error(`kept isolated fixture at ${temp}`);
  throw error;
} finally {
  try {
    await app?.close();
  } finally {
    if (passed)
      await rm(temp, { recursive: true, force: true, maxRetries: 10 });
  }
}
