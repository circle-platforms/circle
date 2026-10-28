import {
  createNativeTerminalShortcutsFixture,
  runNativeTerminalShortcutsJourney,
} from './helpers/native-terminal-shortcuts-journey.mjs';
import { runNativePanelAcceptance } from './helpers/native-panel-acceptance.mjs';
import {
  createNativeCommandHandoffFixture,
  runNativeCommandHandoffJourney,
} from './helpers/native-command-handoff-journey.mjs';
import {
  createNativeChildCommandHandoffFixture,
  runNativeChildCommandHandoffJourney,
  runNativeChildCommandAfterRestart,
  runNativeReviewerSourceJourney,
} from './helpers/native-child-command-handoff-journey.mjs';
import { runNativeGitHubSettingsJourney } from './helpers/native-github-settings-journey.mjs';
import { closeNativeSettings } from './helpers/native-settings.mjs';
import {
  createNativeContinuityFixture,
  runNativeTerminalContextJourney,
  runNativeChildSourceJourney,
} from './helpers/native-continuity-journey.mjs';
import {
  browserDebugFixtureSource,
  runNativeBrowserDebugJourney,
} from './helpers/native-browser-debug-journey.mjs';
import {
  nativeTaskJourneyEnqueueCall,
  nativeTaskJourneyFixture,
} from './helpers/native-task-fixture.mjs';
import {
  preserveNativeClipboard,
  restoreNativeClipboard,
  pendingNativeClipboardCheckpoints,
} from './helpers/native-clipboard.mjs';
import {
  chooseNewLocalTerminal,
  chooseTerminalAction,
  createNativeTerminalFixture,
  openNativeTerminalInspector,
  runNativeTerminalJourney,
} from './helpers/native-terminal-journey.mjs';
import { openNativeProjectFile } from './helpers/native-project-file.mjs';
import { runNativeKeyboardJourney } from './helpers/native-keyboard-journey.mjs';
import { runNativeInputRecovery } from './helpers/native-input-recovery.mjs';
import { runNativeBrowserStream } from './helpers/native-browser-stream.mjs';
import {
  createNativeEditorIsolationFixture,
  runNativeEditorIsolation,
} from './helpers/native-editor-isolation.mjs';
import {
  createNativeEditorFixture,
  runNativeEditorJourney,
} from './helpers/native-editor-journey.mjs';
import {
  journeyShellInput,
  isolatedJourneyPath,
  assertBundledJourneyNode,
  journeyBundledNodeFromApp,
} from './helpers/native-journey-platform.mjs';
// Real renderer interactions; RPC is limited to fixture preparation and effect queries.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setViewport } from './helpers/viewport.mjs';
import { patience } from './helpers/patience.mjs';
import { saveWithShortcut } from './helpers/native-editor-save.mjs';
import { listenForBrowser } from '../../../tests/browser-port.mjs';
const require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packaged = !!process.env.CIRCLE_DESKTOP_EXECUTABLE;
const launchRoot = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root);
const diagnostic = process.env.CIRCLE_NATIVE_JOURNEY_DIAGNOSTIC === '1';
const output = resolve(
  process.env.CIRCLE_NATIVE_JOURNEY_EVIDENCE ??
    join(
      root,
      'artifacts/native-developer-journey',
      packaged ? 'packaged' : 'development',
    ),
);
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-native-journey-'));
const data = join(temp, 'data');
const shellHome = join(temp, 'home');
await mkdir(shellHome, { recursive: true });
const repo = join(data, 'runtime-home', 'workspace');
await mkdir(repo, { recursive: true });
const baseline = '# native journey\n\noriginal content\n';
const browserDebugFixture = browserDebugFixtureSource(
  "function browserFixture(){\n  console.error('JOURNEY_CONSOLE_SOURCE');\n}\nbrowserFixture();\nfetch('/api/data').then(r=>r.text()).then(v=>console.log(v));\nlocalStorage.setItem('journey','before');\nnew EventSource('/events').onmessage = event => { (window.__journeyEvents ||= []).push(event.data); console.log(event.data); };\n",
);
const browserSource = browserDebugFixture.source;
await Promise.all([
  writeFile(
    join(repo, 'AGENTS.md'),
    '# local fixture rules\nKeep native journey changes isolated.\n',
  ),
  writeFile(join(repo, 'git-probe.txt'), 'baseline\n'),
  writeFile(join(repo, 'changes-deleted.txt'), 'JOURNEY_DELETED_LINE\n'),
  writeFile(join(repo, 'README.md'), baseline),
  writeFile(join(repo, 'browser-source.js'), browserSource),
  writeFile(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'native-journey', private: true }),
  ),
]);
await createNativeEditorFixture(repo);
const terminalFixture = await createNativeTerminalFixture(repo);
const terminalShortcutsFixture =
  await createNativeTerminalShortcutsFixture(repo);
const continuityFixture = await createNativeContinuityFixture(repo);
// CIRCLE_DESKTOP_APP_PATH may name app.asar, a macOS .app or a Linux/Windows package folder.
const packagedResources = !process.env.CIRCLE_DESKTOP_APP_PATH
  ? undefined
  : /[\\/]app\.asar$/.test(launchRoot)
    ? dirname(launchRoot)
    : launchRoot.endsWith('.app')
      ? join(launchRoot, 'Contents/Resources')
      : join(launchRoot, 'resources');
const commandHandoffFixture = await createNativeCommandHandoffFixture(
  repo,
  journeyBundledNodeFromApp({
    isPackaged: !!packagedResources,
    resourcesPath: packagedResources,
    appPath: launchRoot,
  }),
);
const childCommandFixture = await createNativeChildCommandHandoffFixture(
  repo,
  commandHandoffFixture.nodePath,
);
const isolationFiles = await createNativeEditorIsolationFixture(repo);
const git = async (...args) =>
  (await promisify(execFile)('git', ['-C', repo, ...args])).stdout;
await git('init', '-b', 'main');
await git(
  'add',
  ...isolationFiles,
  '.circle-editor-isolation-fixture.json',
  ...terminalFixture.files,
  ...terminalShortcutsFixture.files,
  ...continuityFixture.files,
  ...commandHandoffFixture.files,
  ...childCommandFixture.files,
  'editor-main.ts',
  'editor-lib.ts',
  '.circle-editor-journey.json',
  'AGENTS.md',
  'git-probe.txt',
  'changes-deleted.txt',
  'README.md',
  'browser-source.js',
  'package.json',
);
await git(
  '-c',
  'user.name=Circle Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-m',
  'Create isolated journey baseline',
);
await writeFile(join(repo, 'git-probe.txt'), 'baseline\nJOURNEY_GIT_HUNK\n');
const fixture = join(temp, 'model.json');
const requestsPath = join(temp, 'requests.jsonl');
// The parent's held turn schedules the tasks once this file exists: Circle makes tasks.
const startTasks = join(temp, 'start-journey-tasks');
await writeFile(
  fixture,
  JSON.stringify(
    (() => {
      const fixture = nativeTaskJourneyFixture(requestsPath, { startTasks });
      fixture.routes.push(commandHandoffFixture.route);
      fixture.routes.push(...childCommandFixture.routes);
      return fixture;
    })(),
  ),
);
const browserStreams = new Set();
const server = createServer((request, response) => {
  if (request.url === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    response.write(': ready\n\n');
    browserStreams.add(response);
    request.on('close', () => browserStreams.delete(response));
    return;
  }
  if (request.url === '/source.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(
      browserSource +
        '\n//# sourceURL=' +
        pathToFileURL(join(repo, 'browser-source.js')).href,
    );
    return;
  }
  if (request.url === '/api/data') {
    response.setHeader('Content-Type', 'text/plain');
    response.end('JOURNEY_NETWORK_OK');
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><title>native journey fixture</title><h1>Native browser fixture</h1><script src="/source.js"></script>',
  );
});
await listenForBrowser(server);
const origin = 'http://127.0.0.1:' + server.address().port;
const env = {
  ...process.env,
  HOME: shellHome,
  USERPROFILE:
    process.platform === 'win32' ? shellHome : process.env.USERPROFILE,
  ...(process.platform !== 'win32'
    ? { ZDOTDIR: shellHome, ENV: '/dev/null', HISTFILE: '/dev/null' }
    : {}),
  CIRCLE_HOME: shellHome,
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_LANGUAGE: 'en',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
if (packaged) env.PATH = await isolatedJourneyPath();
let app, page;
const checks = [];
const errors = [];
const recoveries = [];
let rendererUnavailable = false;
let clipboardRecoveryPending = false;
let phase = 'launch';
let sessionId;
let receipt;
const until = async (predicate, label, ms = 20000) => {
  const deadline = Date.now() + patience(ms);
  while (!(await predicate().catch(() => false))) {
    assert(Date.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 40));
  }
};
// Chooses a settings option. The settings page can re-render the whole row
// while the runtime publishes state, so a click can keep landing on a button
// that was just replaced: aim each try briefly and check the result, which is
// the button pressed, not the click.
const choose = async (button, label) => {
  const deadline = Date.now() + patience(15000);
  while (
    (await button.getAttribute('aria-pressed').catch(() => null)) !== 'true'
  ) {
    assert(Date.now() < deadline, label);
    await button.click({ timeout: 2000 }).catch(() => {});
  }
};
const tasksCheckName =
  'two isolated write tasks and a readonly task Circle schedules with pending Git approval';
const ptyCheckName = 'interactive PTY stdin and output';
const childCommandCheckName =
  'child task command card preserves original PTY and parent draft';
const inputRecoveryCheckName =
  'whole app restart preserves inputs without automatic sending';
// A phase that reads what an earlier phase made is blocked, not run, when that phase did
// not pass: it would only fail again, after waiting out every locator.
const dependencies = {
  // The shortcuts journey drives the one manual shell the PTY phase opened.
  'original terminal keyboard paste and Control C preserve the existing shell':
    [ptyCheckName],
  'original file viewer and active-turn manual edit save': [
    'native identity and original panels',
  ],
  [tasksCheckName]: ['original file viewer and active-turn manual edit save'],
  'native terminal selection enters original unsent context and preserves processes':
    ['native identity and original panels'],
  'real child source ownership and return to child while parent saves another file':
    [tasksCheckName],
  "the parent's link to a task opens the task's conversation": [tasksCheckName],
  'original settings enable and disable the native GitHub extension without authorization':
    [
      'native identity and original panels',
      'draft survives switching the drawer modes',
      tasksCheckName,
    ],
  // Both read the receipt of the live child handoff; the history also needs the restart.
  "a task reviewer's source opens read-only in its own conversation": [
    childCommandCheckName,
  ],
  'child command history after app restart is read-only without respawn': [
    childCommandCheckName,
    inputRecoveryCheckName,
  ],
};
// After a failed phase the window is probed once: a phase that cannot reach the parent
// conversation would wait out each of its locators, so every later phase is blocked instead.
let applicationUnhealthy;
const within = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error(label + ' did not answer')), ms).unref(),
    ),
  ]);
const probeApplication = async () => {
  const ms = patience(3000);
  if (!page || page.isClosed()) return 'the window is closed';
  if (!(await page.locator('.workspace-content .main-stack').count()))
    return 'the workspace is not rendered';
  const runtime = await within(
    page.evaluate(() => window.circleDesktop.runtimeState()),
    ms,
    'runtime state',
  );
  if (!runtime?.connected) return 'the runtime is not connected';
  if (sessionId && !runtime.snapshot.sessions.some((s) => s.id === sessionId))
    return 'the runtime no longer lists the parent conversation';
  // A modal left open by the failed phase takes every click; Escape is how a person
  // would dismiss it.
  const overlay = page.locator('.dialog-overlay[data-state="open"]');
  for (let i = 0; i < 2 && (await overlay.count()); i++) {
    await page.keyboard.press('Escape');
    await overlay
      .first()
      .waitFor({ state: 'detached', timeout: ms })
      .catch(() => {});
  }
  if (await overlay.count())
    return 'a dialog left open covers the window and does not close';
  if (sessionId) {
    const parent = page
      .locator(`.sidebar .session-link[href="#/session/${sessionId}"]:visible`)
      .first();
    if (await parent.count())
      await parent.click({ trial: true, timeout: ms }).catch((error) => {
        // Playwright's call log names the element that takes the click, if one does.
        const lines = String(error).split('\n');
        throw Error(
          'the parent conversation cannot be clicked: ' +
            (
              lines.findLast((line) => line.includes('intercepts pointer')) ??
              lines[0]
            )
              .trim()
              .replace(/^- /, ''),
        );
      });
  }
};
const check = async (name, action) => {
  phase = name;
  console.log('native journey: ' + name);
  const blocked = (dependencies[name] ?? []).filter(
    (dependency) =>
      checks.find((c) => c.name === dependency)?.status !== 'passed',
  );
  if (rendererUnavailable) blocked.push('renderer recovery');
  if (clipboardRecoveryPending)
    blocked.push('native clipboard recovery; preserve live main checkpoint');
  if (blocked.length || applicationUnhealthy) {
    const reasons = [];
    if (blocked.length)
      reasons.push('requires successful ' + blocked.join(', '));
    if (applicationUnhealthy)
      reasons.push(
        `the application failed its health probe after "${applicationUnhealthy.phase}": ${applicationUnhealthy.reason}`,
      );
    checks.push({ name, status: 'blocked', reason: reasons.join('; ') });
    return;
  }
  const start = Date.now();
  try {
    if (sessionId && page) {
      // Each phase starts from the parent conversation. A file or a subagent open in the
      // drawer can fold the sidebar; closing it brings the sidebar back.
      const closeFile = page
        .locator('.file-view')
        .getByRole('button', { name: 'close file', exact: true });
      if (await closeFile.isVisible()) await closeFile.click();
      const closeAgent = page.getByRole('button', {
        name: 'close subagent',
        exact: true,
      });
      if (await closeAgent.isVisible()) await closeAgent.click();
      // The sidebar lists a session under recent and under its project.
      const parent = page
        .locator(
          `.sidebar .session-link[href="#/session/${sessionId}"]:visible`,
        )
        .first();
      await parent.waitFor({ timeout: patience(3000) }).catch(() => {});
      if (await parent.isVisible()) await parent.click();
      const quick = page.getByRole('dialog', {
        name: 'quick open',
        exact: true,
      });
      if (await quick.isVisible()) await page.keyboard.press('Escape');
    }
    const result = await action();
    checks.push({
      name,
      status: 'passed',
      durationMs: Date.now() - start,
      result,
    });
  } catch (error) {
    clipboardRecoveryPending = pendingNativeClipboardCheckpoints().length > 0;
    const image =
      'phase-' +
      checks.length +
      '-' +
      name.replace(/[^a-z0-9]+/gi, '-') +
      '-failure.png';
    await page?.screenshot({ path: join(output, image) }).catch(() => {});
    checks.push({
      name,
      status: 'failed',
      durationMs: Date.now() - start,
      error: String(error),
      // An aggregated failure keeps each underlying cause, for platforms we cannot run locally.
      causes: Array.isArray(error?.errors)
        ? error.errors.map((cause) => String(cause?.stack ?? cause))
        : undefined,
      stack: String(error?.stack ?? ''),
      screenshot: image,
    });
    if (!diagnostic) throw error;
    if (
      page &&
      !(await page.locator('.workspace-content .main-stack').count()) &&
      !(await page.locator('body').innerText()).trim()
    ) {
      const recovery = {
        phase,
        action: 'native reload window shortcut',
        status: 'failed',
      };
      try {
        await page.keyboard.press('ControlOrMeta+Shift+r');
        await page
          .locator('.workspace-content .main-stack')
          .waitFor({ timeout: 15000 });
        const after = await page.evaluate(() =>
          window.circleDesktop.runtimeState(),
        );
        assert(after.snapshot.sessions.some((s) => s.id === sessionId));
        Object.assign(recovery, {
          status: 'passed',
          connected: after.connected,
          parentSession: after.snapshot.sessions.find((s) => s.id === sessionId)
            ?.state,
        });
      } catch (failure) {
        rendererUnavailable = true;
        recovery.error = String(failure);
      }
      recoveries.push(recovery);
    }
    if (!rendererUnavailable) {
      const probeStart = Date.now();
      const reason = await probeApplication().catch((failure) =>
        String(failure?.message ?? failure),
      );
      recoveries.push({
        phase,
        action: 'health probe',
        status: reason ? 'failed' : 'passed',
        durationMs: Date.now() - probeStart,
        ...(reason ? { error: reason } : {}),
      });
      if (reason) applicationUnhealthy = { phase, reason };
    }
  } finally {
    await writeFile(
      join(output, 'progress.json'),
      JSON.stringify(
        { phase, diagnostic, checks, errors, recoveries, buildIdentity },
        null,
        2,
      ),
    );
  }
};
const buildIdentity = {
  sourceBuildHead: process.env.CIRCLE_NATIVE_JOURNEY_SOURCE_BUILD_HEAD ?? null,
  appPath: launchRoot,
  files: {},
  driverFiles: {},
  fixtureFiles: {},
};
for (const file of [
  ...terminalShortcutsFixture.files,
  ...continuityFixture.files,
  ...commandHandoffFixture.files,
  ...childCommandFixture.files,
])
  buildIdentity.fixtureFiles[file] = createHash('sha256')
    .update(await readFile(join(repo, file)))
    .digest('hex');
for (const file of [
  'native-developer-journey.mjs',
  ...[
    'native-input-recovery',
    'native-browser-stream',
    'native-editor-isolation',
    'native-editor-journey',
    'native-terminal-journey',
    'native-terminal-shortcuts-journey',
    'native-continuity-journey',
    'native-command-handoff-journey',
    'native-child-command-handoff-journey',
    'native-terminal-rendered-match',
    'native-paste-cleanup',
    'native-github-settings-journey',
    'native-settings',
    'native-panel-acceptance',
    'native-keyboard-journey',
    'native-project-file',
    'native-journey-platform',
    'native-clipboard',
    'native-clipboard-checkpoint',
    'native-task-fixture',
    'native-browser-debug-journey',
    'native-devtools-bridge-handoff',
    'devtools-resume-control',
  ].map((name) => 'helpers/' + name + '.mjs'),
]) {
  buildIdentity.driverFiles[file] = createHash('sha256')
    .update(await readFile(join(root, 'test', file)))
    .digest('hex');
}
for (const file of [
  'dist/main.cjs',
  'dist/preload.cjs',
  'dist/runtime-worker.mjs',
  'dist/renderer/index.html',
]) {
  try {
    buildIdentity.files[file] = createHash('sha256')
      .update(await readFile(join(launchRoot, file)))
      .digest('hex');
  } catch {}
}
// A task's conversation is folded under the conversation that started it.
// Open that list when it is closed, then return the task's row.
const taskRow = async (ownerId, childId) => {
  const link = page
    .locator(`.sidebar .session-link[href="#/session/${childId}"]`)
    .first();
  if (await link.isVisible()) return link;
  const toggle = page
    .locator(
      `.sidebar .session-row:has(> .session-link[href="#/session/${ownerId}"]) + .session-tasks-toggle`,
    )
    .first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click();
  await link.waitFor();
  return link;
};
const screenshot = async (name) => {
  const navigation = await page.evaluate(async () => {
    const { snapshot } = await window.circleDesktop.runtimeState();
    return {
      hash: location.hash,
      activeSessionId: snapshot.activeSessionId,
      focusedHref: document.activeElement?.closest('a')?.getAttribute('href'),
      links: [...document.querySelectorAll('.sidebar .session-link')].map(
        (link) => ({
          href: link.getAttribute('href'),
          className: link.className,
          ariaCurrent: link.getAttribute('aria-current'),
          hovered: link.matches(':hover'),
          focusWithin: link.matches(':focus-within'),
          background: getComputedStyle(link).backgroundColor,
        }),
      ),
    };
  });
  await writeFile(
    join(output, name + '-navigation.json'),
    JSON.stringify(navigation, null, 2) + '\n',
  );
  await page.screenshot({ path: join(output, name + '.png') });
};
// The phases use the inspector beside the conversation. A window made on a CI
// runner's small screen is 1050 pixels or narrower, where the inspector lies
// over the conversation instead, so size it as on a desktop. The last phase
// checks the narrow window.
const desktopViewport = () =>
  setViewport(app, page, { width: 1400, height: 900 }, { show: true });
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
  });
  const actualApp = await app.evaluate(({ app }) => ({
    appPath: app.getAppPath(),
    executablePath: process.execPath,
    packaged: app.isPackaged,
  }));
  Object.assign(buildIdentity, actualApp, { files: {} });
  if (actualApp.appPath.endsWith('.asar'))
    buildIdentity.files['app.asar'] = createHash('sha256')
      .update(await readFile(actualApp.appPath))
      .digest('hex');
  else
    for (const file of [
      'dist/main.cjs',
      'dist/preload.cjs',
      'dist/runtime-worker.mjs',
      'dist/renderer/index.html',
    ])
      buildIdentity.files[file] = createHash('sha256')
        .update(await readFile(join(actualApp.appPath, file)))
        .digest('hex');
  const toolsRoot = actualApp.appPath.replace(
    /([\\/])app\.asar$/,
    '$1app.asar.unpacked',
  );
  buildIdentity.bundledNode = await assertBundledJourneyNode(
    join(
      toolsRoot,
      'dist',
      'tools',
      'node',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    ),
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(patience(15000));
  page.on('pageerror', (e) =>
    errors.push({ phase, error: String(e), stack: e.stack }),
  );
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  await desktopViewport();
  const state = async () =>
    (await page.evaluate(() => window.circleDesktop.runtimeState())).snapshot;
  sessionId = (await state()).activeSessionId;
  const query = async (service, method, params = {}) => {
    const reply = await page.evaluate(
      ({ sessionId, service, method, params }) =>
        window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name: 'workspace-service',
          sessionId,
          payload: { service, method, params },
        }),
      { sessionId, service, method, params },
    );
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.data;
  };
  const closeFile = async () => {
    const close = page
      .locator('.file-view')
      .getByRole('button', { name: 'close file', exact: true });
    if (await close.isVisible()) {
      await close.click();
      await page.locator('.file-view').waitFor({ state: 'hidden' });
    }
  };
  // The work drawer's modes, by the buttons in the top bar.
  const modeButton = (kind) =>
    page.getByRole('button', { name: `${kind} panel`, exact: true });
  const openMode = async (kind) => {
    const toggle = modeButton(kind);
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    await until(
      async () => (await toggle.getAttribute('aria-pressed')) === 'true',
      `the ${kind} mode opens`,
    );
  };
  // A mode has no title bar: pressing its button again closes the drawer. The
  // buttons after the divider are the modes; the one before it is the overview.
  const closeDrawer = async () => {
    const open = page.locator(
      '.drawer-mode-toolbar .drawer-mode-divider ~ .drawer-mode-button[aria-pressed="true"]',
    );
    if (await open.count()) {
      await open.first().click();
      await until(async () => !(await open.count()), 'the drawer closes');
    }
  };
  // What the message box holds besides its text, as the window keeps it for the session.
  const storedAttachments = (id) =>
    page.evaluate((id) => {
      const text = localStorage.getItem('circle.workbench.live.attachments.v1');
      if (text !== null) return new Map(JSON.parse(text)).get(id) ?? [];
      const views = JSON.parse(
        localStorage.getItem('circle.workbench.live.views.v1') ??
          '{"views":[]}',
      ).views;
      return views.find(([key]) => key === id)?.[1]?.attachments ?? [];
    }, id);
  const send = async (text) => {
    await closeFile();
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(text);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
  };
  await check('native identity and original panels', async () => {
    assert.equal(
      (await page.evaluate(() => window.circleDesktop.info())).packaged,
      packaged,
    );
    assert.equal(
      await page
        .locator('.developer-workbench,.layout-toggle,.developer-dock')
        .count(),
      0,
    );
    // A configured app with nothing to resume opens the home composer; the
    // first message there starts the conversation in the default project.
    await send('Prepare native journey');
    await page
      .locator('.main-stack .conversation')
      .waitFor({ state: 'visible' });
    sessionId = (await state()).activeSessionId;
    await page
      .getByText('Native journey ready: README.md', {
        exact: true,
      })
      .waitFor();
    await until(
      async () =>
        (await state()).sessions.find((s) => s.id === sessionId)?.state ===
        'idle',
      'model baseline idle',
    );
    await screenshot('01-original-panels');
  });
  await check(
    'independent editor bodies buffers and undo histories',
    async () => {
      const result = await runNativeEditorIsolation({
        page,
        workspace: repo,
        output,
      });
      await writeFile(
        join(output, 'editor-isolation.json'),
        JSON.stringify(result, null, 2),
      );
      const fonts = await page.evaluate(async () => {
        await document.fonts.ready;
        const loaded = await document.fonts.load('16px codicon');
        return {
          checked: document.fonts.check('16px codicon'),
          faces: loaded.map((face) => ({
            family: face.family,
            status: face.status,
          })),
        };
      });
      await writeFile(
        join(output, 'native-editor-fonts.json'),
        JSON.stringify(fonts, null, 2),
      );
      assert(fonts.checked, 'native editor icon font is available');
      assert(
        fonts.faces.some(
          (face) =>
            face.family.replace(/["']/g, '') === 'codicon' &&
            face.status === 'loaded',
        ),
        'a real loaded editor icon face is required, not a fallback font',
      );
      await closeFile();
      await closeDrawer();
    },
  );
  await check('native editor save, undo and conflict journey', async () => {
    const result = await runNativeEditorJourney({
      page,
      workspace: repo,
      sessionId,
      output,
    });
    await writeFile(
      join(output, 'editor-journey.json'),
      JSON.stringify(result, null, 2),
    );
    await closeFile();
    await closeDrawer();
  });
  await check(
    'loaded project instruction source opens actual file',
    async () => {
      // The overview's context card lists the instruction files the folder gave Circle;
      // each opens in the files mode.
      const overview = page.getByRole('button', {
        name: 'overview panel',
        exact: true,
      });
      if ((await overview.getAttribute('aria-pressed')) !== 'true')
        await overview.click();
      const contextCard = page.locator('.overview #overview-context > button');
      if ((await contextCard.getAttribute('aria-expanded')) !== 'true')
        await contextCard.click();
      const instruction = page
        .locator('.overview #overview-context-body')
        .getByRole('button', { name: 'AGENTS.md', exact: true });
      const instructionPath = await instruction.getAttribute('title');
      assert.equal(
        await realpath(
          isAbsolute(instructionPath)
            ? instructionPath
            : join(repo, instructionPath),
        ),
        await realpath(join(repo, 'AGENTS.md')),
        'the card names the instruction file the folder actually has',
      );
      await instruction.click();
      await page
        .locator('.file-view-heading strong')
        .getByText('AGENTS.md', { exact: true })
        .waitFor();
      assert.equal(
        (await readFile(join(repo, 'AGENTS.md'), 'utf8')).includes(
          'Keep native journey changes isolated.',
        ),
        true,
      );
      await page
        .locator('.file-view .view-lines')
        .filter({ hasText: 'Keep native journey changes isolated.' })
        .waitFor();
      assert.equal(
        await page
          .locator('.file-view')
          .getByText('file not found', { exact: true })
          .count(),
        0,
      );
      await screenshot('01b-instruction-source');
      await page
        .getByRole('button', { name: 'close file', exact: true })
        .click();
    },
  );
  await check(
    'original file viewer and active-turn manual edit save',
    async () => {
      await send('Remain active while I edit and diagnose');
      await until(
        async () =>
          ['running', 'waiting'].includes(
            (await state()).sessions.find((s) => s.id === sessionId)?.state,
          ),
        'agent running',
      );
      await page.keyboard.press('ControlOrMeta+p');
      await page
        .getByRole('textbox', { name: 'global search', exact: true })
        .fill('README.md');
      await page
        .locator('.search-results button')
        .filter({ hasText: 'README.md' })
        .first()
        .click();
      await page
        .locator('.file-view')
        .getByRole('button', { name: 'source code', exact: true })
        .click();
      const editor = page.locator('.file-view .monaco-editor').last();
      await editor
        .locator('.view-lines')
        .click({ position: { x: 120, y: 10 } });
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await page.keyboard.type('JOURNEY_MANUAL_SAVE');
      await until(
        async () =>
          (await page.locator('.file-view').innerText()).includes(
            'JOURNEY_MANUAL_SAVE',
          ),
        'actual edit buffer receives keyboard input',
      );
      await saveWithShortcut(
        page,
        'ControlOrMeta',
        async () =>
          (await readFile(join(repo, 'README.md'), 'utf8')).includes(
            'JOURNEY_MANUAL_SAVE',
          ),
        'actual disk save during active agent',
        page.locator('.file-view:visible'),
      );
      const savedReadme = await readFile(join(repo, 'README.md'), 'utf8');
      await writeFile(join(output, '02-manual-readme-disk.txt'), savedReadme);
      assert(
        savedReadme.startsWith(baseline),
        'saving README must preserve its own baseline, not another editor model',
      );
      assert(
        !savedReadme.includes('import { amount }'),
        'no cross-file model content',
      );
      assert.equal(
        (await state()).sessions.find((s) => s.id === sessionId)?.state,
        'waiting',
      );
      await screenshot('02-active-manual-edit');
    },
  );
  await check(ptyCheckName, async () => {
    // The + at the end of the terminal tabs makes a shell in the conversation's folder.
    const panel = await openNativeTerminalInspector(page);
    const prior = new Set((await query('terminal', 'list')).map((t) => t.id));
    await chooseNewLocalTerminal(page, panel);
    let shell;
    await until(
      async () =>
        Boolean(
          (shell = (await query('terminal', 'list')).find(
            (item) => !prior.has(item.id),
          )),
        ),
      'a new shell starts',
    );
    const tab = panel.locator(
      `[role="tab"][aria-controls="terminal-${shell.id}"]`,
    );
    await until(
      async () => (await tab.getAttribute('aria-selected')) === 'true',
      'the new shell is the tab in front',
    );
    assert.match((await tab.innerText()).trim(), /^terminal \d+$/);
    assert.equal(await realpath(shell.cwd), await realpath(repo));
    const terminal = panel.locator(
      `#terminal-${shell.id} .xterm-helper-textarea`,
    );
    await terminal.focus();
    for (const chunk of journeyShellInput()) await page.keyboard.type(chunk);
    await until(async () => {
      const log = await query('terminal', 'replay', {
        id: shell.id,
        limit: 512,
      });
      return JSON.stringify(log).includes('JOURNEY_ECHO:native-input');
    }, 'PTY receives actual stdin');
    await screenshot('03-interactive-terminal');
  });
  await check(
    'terminal search complete copy independent buffers and managed service lifecycle',
    async () => {
      const clipboardKey = await preserveNativeClipboard(app);
      try {
        await runNativeTerminalJourney({
          page,
          workspace: repo,
          sessionId,
          output,
          nodePath: buildIdentity.bundledNode.path,
          clipboard: {
            readText: () =>
              app.evaluate(({ clipboard }) => clipboard.readText()),
          },
          query,
          until,
          screenshot,
        });
      } finally {
        await restoreNativeClipboard(app, clipboardKey);
      }
    },
  );
  await check(
    'native terminal selection enters original unsent context and preserves processes',
    async () => {
      await closeFile();
      const clipboardKey = await preserveNativeClipboard(app);
      try {
        return await runNativeTerminalContextJourney({
          page,
          workspace: repo,
          sessionId,
          fixture: continuityFixture,
          nodePath: buildIdentity.bundledNode.path,
          query,
          state,
          until,
          output,
          clipboard: {
            readText: () =>
              app.evaluate(({ clipboard }) => clipboard.readText()),
          },
        });
      } finally {
        await restoreNativeClipboard(app, clipboardKey);
      }
    },
  );
  await check(
    'original terminal keyboard paste and Control C preserve the existing shell',
    async () => {
      await closeFile();
      return runNativeTerminalShortcutsJourney({
        page,
        getApp: () => app,
        workspace: repo,
        sessionId,
        fixture: terminalShortcutsFixture,
        nodePath: buildIdentity.bundledNode.path,
        query,
        until,
        output,
      });
    },
  );
  // The window stages, commits and pushes nothing: the changes mode is one list of what
  // differs, read from Git whoever made the change, with each file's difference and the file
  // itself one click away.
  await check(
    'changes mode reads the working tree from Git and opens the file itself',
    async () => {
      await closeFile();
      await closeDrawer();
      assert.equal(
        (await git('diff', '--cached', '--name-only')).trim(),
        '',
        'the fixture starts with an empty index',
      );
      // Work done outside the window: a change staged in a terminal, a deleted file and
      // a new one, beside the unstaged change to git-probe.txt.
      await writeFile(
        join(repo, 'changes-staged.txt'),
        'JOURNEY_STAGED_LINE\n',
      );
      await git('add', '--', 'changes-staged.txt');
      await rm(join(repo, 'changes-deleted.txt'));
      await writeFile(
        join(repo, 'changes-untracked.txt'),
        'JOURNEY_UNTRACKED_LINE\n',
      );
      const index = await git('diff', '--cached', '--binary');
      const probe = await readFile(join(repo, 'git-probe.txt'), 'utf8');
      try {
        await openMode('changes');
        const mode = page.locator('.changes-mode:visible');
        const byPath = (rows) =>
          rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const expected = async () => {
          const rows = new Map();
          const status = (
            await git('diff', '--name-status', '-z', 'HEAD', '--')
          ).split('\0');
          for (let i = 0; i + 1 < status.length; i += 2)
            rows.set(
              status[i + 1],
              status[i].startsWith('A')
                ? 'A'
                : status[i].startsWith('D')
                  ? 'D'
                  : 'M',
            );
          for (const path of (
            await git('ls-files', '--others', '--exclude-standard', '-z')
          )
            .split('\0')
            .filter(Boolean))
            rows.set(path, 'A');
          return byPath([...rows]);
        };
        const list = mode.getByRole('list', {
          name: 'changed files',
          exact: true,
        });
        const shown = async () =>
          byPath(
            await list
              .locator('.changes-row')
              .evaluateAll((rows) =>
                rows.map((row) => [
                  row.getAttribute('title'),
                  row.querySelector('.overview-letter')?.textContent,
                ]),
              ),
          );
        let listed, actual;
        const matchesGit = async () => {
          actual = await expected();
          listed = await shown();
          return JSON.stringify(listed) === JSON.stringify(actual);
        };
        // This session's list is what Circle's file tools changed here, nothing yet,
        // together with the uncommitted files the overview's changes card lists: work
        // done outside the window shows in both.
        await mode
          .getByRole('button', { name: 'this session', exact: true })
          .click();
        await until(
          matchesGit,
          "this session's list is the files Git says differ, as the overview's changes card lists them",
        );
        await mode
          .getByRole('button', { name: 'all uncommitted', exact: true })
          .click();
        // Everything that differs from the last commit, staged or not, new files too.
        await until(
          matchesGit,
          'the list is every file Git says differs from the last commit',
        );
        for (const [path, letter] of [
          ['git-probe.txt', 'M'],
          ['changes-staged.txt', 'A'],
          ['changes-deleted.txt', 'D'],
          ['changes-untracked.txt', 'A'],
        ])
          assert(
            listed.some(
              ([shownPath, shownLetter]) =>
                shownPath === path && shownLetter === letter,
            ),
            `${path} is listed as ${letter}`,
          );
        const row = (path) => list.locator(`.changes-row[title="${path}"]`);
        const file = mode.locator('.changes-file');
        const difference = async (path, line) => {
          await row(path).click();
          await file
            .locator('.changes-path')
            .getByText(path, { exact: true })
            .waitFor();
          await file
            .locator('.changes-diff span.added')
            .filter({ hasText: line })
            .waitFor();
        };
        // Each difference is Git's own: the line the working tree adds to git-probe.txt.
        assert.match(
          await git('diff', 'HEAD', '--', 'git-probe.txt'),
          /^\+JOURNEY_GIT_HUNK\r?$/m,
        );
        await difference('git-probe.txt', 'JOURNEY_GIT_HUNK');
        await difference('changes-staged.txt', 'JOURNEY_STAGED_LINE');
        await difference('changes-untracked.txt', 'JOURNEY_UNTRACKED_LINE');
        // A deleted file has its difference and nothing to open.
        await row('changes-deleted.txt').click();
        await file
          .locator('.changes-path')
          .getByText('changes-deleted.txt', { exact: true })
          .waitFor();
        await file
          .locator('.changes-diff span.removed')
          .filter({ hasText: 'JOURNEY_DELETED_LINE' })
          .waitFor();
        assert.equal(
          await file
            .getByRole('button', { name: 'open file', exact: true })
            .count(),
          0,
        );
        await screenshot('04-changes-mode-all-uncommitted');
        // open file shows the file itself in the files mode, not its difference, with
        // the line Git says is new marked beside it.
        await row('git-probe.txt').click();
        await file
          .locator('.changes-path')
          .getByText('git-probe.txt', { exact: true })
          .waitFor();
        await file
          .getByRole('button', { name: 'open file', exact: true })
          .click();
        const view = page.locator('.file-view:visible');
        await view
          .locator('.file-view-heading strong')
          .getByText('git-probe.txt', { exact: true })
          .waitFor();
        assert.equal(
          await modeButton('files').getAttribute('aria-pressed'),
          'true',
        );
        assert.equal(
          await view
            .getByRole('button', { name: 'edit', exact: true })
            .getAttribute('aria-pressed'),
          'true',
        );
        await until(
          async () =>
            (await view.locator('.view-lines').first().textContent()).includes(
              'JOURNEY_GIT_HUNK',
            ),
          'the editor holds the file on disk',
        );
        await view
          .locator('.monaco-editor .change-mark-added')
          .first()
          .waitFor({ state: 'attached' });
        await screenshot('04b-changes-open-file');
        await closeFile();
        // Reading the changes staged nothing and changed no file.
        assert.equal(await git('diff', '--cached', '--binary'), index);
        assert.equal(
          await readFile(join(repo, 'git-probe.txt'), 'utf8'),
          probe,
        );
        return { listed };
      } finally {
        // Put the fixture back as it was: only git-probe.txt differs.
        await git('rm', '--cached', '-q', '--', 'changes-staged.txt').catch(
          () => {},
        );
        await rm(join(repo, 'changes-staged.txt'), { force: true });
        await rm(join(repo, 'changes-untracked.txt'), { force: true });
        await git('checkout', '--', 'changes-deleted.txt').catch(() => {});
        await closeFile();
        await closeDrawer();
      }
    },
  );
  await check(
    'Chromium developer tools and native page visibility',
    async () => {
      await closeFile();
      await openMode('browser');
      await page
        .getByRole('textbox', { name: 'browser address', exact: true })
        .fill(origin);
      await page
        .getByRole('textbox', { name: 'browser address', exact: true })
        .press('Enter');
      await page
        .getByRole('button', { name: 'browser menu', exact: true })
        .waitFor();
      assert.equal(await page.locator('.browser-diagnostics').count(), 0);
      const devToolsOpen = () =>
        app.evaluate(
          ({ webContents }, origin) =>
            webContents
              .getAllWebContents()
              .some(
                (contents) =>
                  contents.getURL().startsWith(origin) &&
                  contents.isDevToolsOpened(),
              ),
          origin,
        );
      await page
        .getByRole('button', { name: 'browser menu', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'developer tools' }).click();
      await until(devToolsOpen, 'Chromium developer tools open from the menu');
      await page
        .getByRole('button', { name: 'browser menu', exact: true })
        .click();
      await page
        .getByRole('menuitem', { name: 'close developer tools' })
        .click();
      await until(
        async () => !(await devToolsOpen()),
        'the menu closes Chromium developer tools',
      );
      const guestViews = () =>
        app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          return window.contentView.children
            .filter(
              (view) =>
                view.webContents && view.webContents !== window.webContents,
            )
            .map((view) => ({
              visible: view.getVisible(),
              url: view.webContents.getURL(),
              bounds: view.getBounds(),
            }));
        });
      const pageViews = async () =>
        (await guestViews()).filter(
          (view) =>
            view.url.startsWith('http') && !view.url.includes('circle-mask'),
        );
      await until(async () => {
        const views = await pageViews();
        return views.length > 0 && views.every((view) => view.visible);
      }, 'the page is shown in the browser panel');
      const hide = async (label) => {
        await until(async () => {
          const views = await pageViews();
          return views.length > 0 && views.every((view) => !view.visible);
        }, label);
      };
      // The page is a native view over the window: any other mode of the drawer hides it.
      for (const kind of ['changes', 'files', 'subagents', 'terminal']) {
        await openMode(kind);
        await hide(`the page hides in the ${kind} mode`);
      }
      await closeDrawer();
      await hide('the page hides when the drawer closes');
      await openMode('browser');
      let pageBounds;
      await until(async () => {
        const views = await pageViews();
        const box = await page.evaluate(() => {
          const node = document.querySelector('.native-browser-viewport');
          const rect = node?.getBoundingClientRect();
          return rect
            ? {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              }
            : null;
        });
        pageBounds = views[0]?.bounds;
        return (
          views.length > 0 &&
          views.every((view) => view.visible) &&
          box &&
          views.every(
            (view) =>
              Math.abs(view.bounds.x - box.x) <= 2 &&
              Math.abs(view.bounds.y - box.y) <= 2 &&
              Math.abs(view.bounds.width - box.width) <= 2 &&
              Math.abs(view.bounds.height - box.height) <= 2,
          )
        );
      }, 'the page returns to its box');
      // A picture of the page goes into the message box as an attachment, named for
      // the site and the time; nothing is drawn in the browser for it.
      const before = (await storedAttachments(sessionId)).map(
        (item) => item.id,
      );
      await page
        .getByRole('button', { name: 'browser menu', exact: true })
        .click();
      await page
        .getByRole('menuitem', { name: 'take page screenshot', exact: true })
        .click();
      let picture;
      await until(
        async () =>
          Boolean(
            (picture = (await storedAttachments(sessionId)).find(
              (item) => !before.includes(item.id),
            )),
          ),
        'the page screenshot is an attachment of the unsent message',
      );
      assert.equal(picture.kind, 'image');
      assert.match(picture.name, /^127\.0\.0\.1 \d\d:\d\d\.png$/);
      assert(picture.content.startsWith('data:image/png;base64,'));
      const png = Buffer.from(picture.content.split(',')[1], 'base64');
      const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      assert.ok(width > 0 && height > 0);
      // A picture of the page as laid out in the mode: the view's own proportions.
      assert.ok(
        Math.abs(width / height - pageBounds.width / pageBounds.height) <
          0.03 * (pageBounds.width / pageBounds.height),
        `the picture (${width}×${height}) has the page view's proportions (${pageBounds.width}×${pageBounds.height})`,
      );
      await writeFile(join(output, '07-actual-browser-capture.png'), png);
      const chip = page
        .locator('.attachment-strip')
        .getByRole('button', { name: picture.name, exact: true });
      await chip.waitFor();
      await screenshot('07-browser-chromium-devtools');
      // Taken back as any attachment, the message box holds what it held before.
      await page
        .locator('.attachment-strip')
        .getByRole('button', { name: `remove ${picture.name}`, exact: true })
        .click();
      await until(
        async () =>
          JSON.stringify(
            (await storedAttachments(sessionId)).map((item) => item.id),
          ) === JSON.stringify(before),
        'removing the picture leaves the attachments as they were',
      );
      await chip.waitFor({ state: 'detached' });
      if (process.env.CIRCLE_NATIVE_JOURNEY_PUSH === '1') {
        await until(
          async () => browserStreams.size > 0,
          'synthetic browser event stream connected',
        );
        await runNativeBrowserStream({
          page,
          output,
          emit(marker) {
            for (const stream of browserStreams)
              stream.write('data: ' + marker + '\n\n');
          },
          readGuest: (script) =>
            app.evaluate(
              ({ webContents }, { origin, script }) =>
                webContents
                  .getAllWebContents()
                  .find((contents) => contents.getURL().startsWith(origin))
                  .executeJavaScript(script),
              { origin, script },
            ),
        });
      }
    },
  );
  await check('draft survives switching the drawer modes', async () => {
    await closeFile();
    const message = page.getByRole('textbox', { name: 'message', exact: true });
    await message.fill('JOURNEY_UNSENT_DRAFT');
    await message.evaluate((node) => node.setSelectionRange(3, 10));
    for (const kind of ['terminal', 'changes', 'subagents', 'files', 'browser'])
      await openMode(kind);
    await closeDrawer();
    assert.equal(await message.inputValue(), 'JOURNEY_UNSENT_DRAFT');
    assert.deepEqual(
      await message.evaluate((node) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
      [3, 10],
    );
  });

  await check(tasksCheckName, async () => {
    await closeFile();
    await closeDrawer();
    // Circle makes the tasks, not the person: the parent's turn, still at work, schedules
    // two that write and one that reads, and asks first in the parent conversation.
    assert.equal(
      (await state()).sessions.find((s) => s.id === sessionId)?.state,
      'waiting',
      'the parent turn is still at work',
    );
    await writeFile(startTasks, 'schedule\n');
    let schedule;
    await until(
      async () =>
        Boolean(
          (schedule = (await state()).interactions.find(
            (i) =>
              i.sessionId === sessionId &&
              i.callId === nativeTaskJourneyEnqueueCall &&
              i.status === 'pending',
          )),
        ),
      'the parent asks before it schedules the tasks',
    );
    await page
      .locator('.main-stack .conversation:visible')
      .locator('.inline-request[data-kind="approval"]')
      .getByRole('button', { name: 'allow once', exact: true })
      .click();
    await until(
      async () =>
        !(await state()).interactions.some(
          (i) => i.id === schedule.id && i.status === 'pending',
        ),
      'the schedule approval is consumed once',
    );
    let tasks = [];
    await until(async () => {
      tasks = await query('tasks', 'list');
      return ['JOURNEY_WRITE_A', 'JOURNEY_WRITE_B', 'JOURNEY_READ_ONLY'].every(
        (prompt) =>
          tasks.some(
            (t) => t.spec.prompt === prompt && t.spec.sessionId === sessionId,
          ),
      );
    }, 'the parent conversation owns the three tasks it scheduled');
    await until(
      async () =>
        (await query('tasks', 'list')).some(
          (t) => t.spec.prompt === 'JOURNEY_WRITE_A' && t.state === 'waiting',
        ),
      'first task awaits human',
    );
    await until(
      async () =>
        (await query('tasks', 'list')).some(
          (t) => t.spec.prompt === 'JOURNEY_WRITE_B' && t.state === 'waiting',
        ),
      'second task independently awaits human',
    );
    await until(
      async () =>
        (await query('tasks', 'list')).some(
          (t) =>
            t.spec.prompt === 'JOURNEY_READ_ONLY' &&
            ['succeeded', 'needs_review'].includes(t.state),
        ),
      'readonly task completes while writers await',
    );
    const concurrent = await query('tasks', 'list');
    const writers = concurrent.filter((t) => t.spec.access === 'write');
    assert.equal(writers.length, 2);
    assert(writers.every((t) => t.state === 'waiting'));
    assert.notEqual(writers[0].worktree, writers[1].worktree);
    assert(writers.every((t) => t.worktree !== repo));
    await screenshot('08a-parallel-task-approvals');
    let gitApprovalObserved = false;
    for (const writer of writers) {
      for (let iteration = 0; iteration < 4; iteration++) {
        const record = (await query('tasks', 'list')).find(
          (t) => t.spec.id === writer.spec.id,
        );
        if (['succeeded', 'needs_review'].includes(record.state)) break;
        assert(
          record.runtimeSessionId,
          'real task child session identity exists',
        );
        await until(async () => {
          const fresh = (await query('tasks', 'list')).find(
            (task) => task.spec.id === writer.spec.id,
          );
          return (
            ['succeeded', 'needs_review'].includes(fresh.state) ||
            (await state()).interactions.some(
              (i) =>
                i.sessionId === record.runtimeSessionId &&
                i.status === 'pending',
            )
          );
        }, 'child approval is projected or actual task verification completes');
        if (
          ['succeeded', 'needs_review'].includes(
            (await query('tasks', 'list')).find(
              (task) => task.spec.id === writer.spec.id,
            ).state,
          )
        )
          break;
        const pending = (await state()).interactions.find(
          (i) =>
            i.sessionId === record.runtimeSessionId && i.status === 'pending',
        );
        if (pending.command?.includes('git status')) gitApprovalObserved = true;
        await (await taskRow(sessionId, record.runtimeSessionId)).click();
        await page
          .getByRole('button', { name: 'allow once', exact: true })
          .first()
          .waitFor();
        await page
          .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
          .first()
          .click();
        assert(
          (await state()).interactions.some(
            (i) => i.id === pending.id && i.status === 'pending',
          ),
        );
        assert.equal(
          (await state()).sessions.find((s) => s.id === sessionId)?.state,
          'waiting',
        );
        await screenshot(
          '08b-pending-request-parent-continues-' +
            writer.spec.id +
            '-' +
            iteration,
        );
        await (await taskRow(sessionId, record.runtimeSessionId)).click();
        const allow = page
          .getByRole('button', { name: 'allow once', exact: true })
          .first();
        // Which card the click lands on, so a failure below says whether it was this
        // task's (#228)
        const clicked = await allow.evaluate((button) => ({
          hash: location.hash,
          buttons: document.querySelectorAll('.inline-request button').length,
          card: button.closest('.inline-request')?.textContent ?? null,
        }));
        await allow.click();
        await page
          .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
          .first()
          .click();
        await until(
          async () =>
            !(await state()).interactions.some(
              (i) => i.id === pending.id && i.status === 'pending',
            ),
          'approval consumed exactly once',
        ).catch(async (error) => {
          // Record what the task's own conversation shows: an error under its card
          // means the runtime refused the answer; a card still waiting means the
          // click never answered it
          await (await taskRow(sessionId, record.runtimeSessionId)).click();
          const shown = await page.evaluate(() => ({
            hash: location.hash,
            cards: [...document.querySelectorAll('.inline-request')].map(
              (card) => card.textContent,
            ),
            failures: [...document.querySelectorAll('.request-failure')].map(
              (failure) => failure.textContent,
            ),
          }));
          const snapshot = await state();
          await writeFile(
            join(output, `08b-unanswered-${writer.spec.id}.json`),
            JSON.stringify(
              {
                pending,
                clicked,
                shown,
                interaction: snapshot.interactions.find(
                  (i) => i.id === pending.id,
                ),
                activeSessionId: snapshot.activeSessionId,
              },
              null,
              2,
            ) + '\n',
          );
          await page.screenshot({
            path: join(output, `08b-unanswered-${writer.spec.id}.png`),
          });
          throw error;
        });
      }
    }
    await until(
      async () =>
        (await query('tasks', 'list')).every((t) =>
          ['succeeded', 'needs_review'].includes(t.state),
        ),
      'all three tasks finish without hiding acceptance review',
    );
    const complete = await query('tasks', 'list');
    for (const writer of writers)
      assert.equal(
        await readFile(join(writer.worktree, 'agent-result.txt'), 'utf8'),
        'isolated task output\n',
      );
    assert.equal(
      gitApprovalObserved,
      true,
      'actual git command waited while session navigation continued',
    );
    await assert.rejects(readFile(join(repo, 'agent-result.txt'), 'utf8'), {
      code: 'ENOENT',
    });
    // A task whose checks cannot decide waits for review in its own conversation: the
    // card at its end asks for each criterion and can send the attempt back.
    const reviewed = [];
    for (const task of complete.filter((t) => t.state === 'needs_review')) {
      await (await taskRow(sessionId, task.runtimeSessionId)).click();
      await until(
        async () => (await state()).activeSessionId === task.runtimeSessionId,
        'the task conversation opens from its row',
      );
      const review = page.locator(
        '.main-stack .conversation:visible .task-review-card',
      );
      await review.waitFor();
      for (const criterion of task.spec.acceptanceCriteria)
        await review
          .locator('.task-review-criterion')
          .filter({ hasText: criterion })
          .waitFor();
      await review
        .getByRole('button', { name: 'send back', exact: true })
        .waitFor();
      if (task.spec.access === 'write') {
        // What the task wrote, in its worktree, is what its changes list.
        await review
          .getByRole('button', { name: '1 file changed', exact: true })
          .click();
        const changes = page.locator('.changes-mode:visible');
        await changes
          .locator('.changes-row[title="agent-result.txt"]')
          .waitFor();
        await until(
          async () =>
            (await changes.locator('.changes-diff').innerText()).includes(
              'isolated task output',
            ),
          'the task changes show what the task wrote',
        );
        await closeDrawer();
      }
      reviewed.push(task.spec.prompt);
      await screenshot('08d-task-review-' + task.spec.id);
    }
    assert.deepEqual(
      reviewed.sort(),
      complete
        .filter((t) => t.state === 'needs_review')
        .map((t) => t.spec.prompt)
        .sort(),
    );
    await page
      .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
      .first()
      .click();
    await writeFile(
      join(output, 'task-results.json'),
      JSON.stringify({ concurrent, complete, gitApprovalObserved }, null, 2),
    );
    const journal = (await readFile(requestsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const routes = new Set(
      journal.map((request) => request.fixture?.routeId).filter(Boolean),
    );
    for (const expected of ['writer-a', 'writer-b', 'readonly'])
      assert(
        routes.has(expected),
        'real task routed model conversation ' + expected,
      );
    assert(
      journal.filter((request) => request.fixture?.role === 'reviewer')
        .length >= 3,
      'three actual independent reviewer requests recorded',
    );
    await screenshot('08c-parallel-task-results');
  });
  await check(
    'real child source ownership and return to child while parent saves another file',
    async () => {
      await closeFile();
      const records = await query('tasks', 'list');
      const writer = records.find(
        (task) => task.spec.prompt === 'JOURNEY_WRITE_A',
      );
      assert(
        writer?.runtimeSessionId && writer.worktree,
        'a real writer child and its isolated worktree must be ready',
      );
      assert(
        ['succeeded', 'needs_review'].includes(writer.state),
        'child source check waits for the completed writer',
      );
      return runNativeChildSourceJourney({
        page,
        workspace: repo,
        sessionId,
        fixture: continuityFixture,
        agentId: writer.runtimeSessionId,
        childWorktree: writer.worktree,
        state,
        until,
        output,
      });
    },
  );
  // The parent's record of scheduling links each task it started. A task is not one of the
  // drawer's subagents but a conversation of its own, which the sidebar's row and the
  // overview open; its link in the parent's tool card has to lead there too.
  await check(
    "the parent's link to a task opens the task's conversation",
    async () => {
      await closeFile();
      await closeDrawer();
      const writer = (await query('tasks', 'list')).find(
        (task) => task.spec.prompt === 'JOURNEY_WRITE_A',
      );
      const agent = (await state()).agents.find(
        (item) => item.id === writer.runtimeSessionId,
      );
      assert(agent?.task, 'the writer is a task the parent started');
      const conversation = page.locator('.main-stack .conversation:visible');
      for (const summary of await conversation
        .locator('.tool-group > .tool-summary')
        .all())
        if ((await summary.getAttribute('aria-expanded')) !== 'true')
          await summary.click();
      const link = conversation
        .locator('.tool-agent-links button')
        .filter({ has: page.getByText(agent.name, { exact: true }) });
      assert.equal(await link.count(), 1, 'the tool card links the task once');
      await link.click();
      try {
        await until(
          async () =>
            (await state()).activeSessionId === writer.runtimeSessionId &&
            new URL(page.url()).hash === `#/session/${writer.runtimeSessionId}`,
          "the task link opens the task's own conversation",
          8000,
        );
      } finally {
        // Whatever the link opened, the next phase starts from the parent.
        await page.screenshot({
          path: join(output, '08e-parent-task-link.png'),
        });
        await closeDrawer();
        // Closing the drawer brings back a sidebar it folded; one that stays hidden is
        // shown by hand.
        const parent = page.locator(
          `.sidebar .session-link[href="#/session/${sessionId}"]:visible`,
        );
        await parent
          .first()
          .waitFor({ timeout: patience(3000) })
          .catch(() => {});
        if (!(await parent.count()))
          await page
            .getByRole('button', {
              name: 'show or hide the sidebar',
              exact: true,
            })
            .click();
        await parent.first().click();
        await until(
          async () => (await state()).activeSessionId === sessionId,
          'the parent conversation is shown again',
        );
      }
    },
  );
  await check(
    'original settings enable and disable the native GitHub extension without authorization',
    async () => {
      await closeFile();
      return runNativeGitHubSettingsJourney({
        page,
        sessionId,
        state,
        until,
        output,
        settingsFile: join(data, 'runtime-home', 'settings.json'),
        requestsPath,
      });
    },
  );
  await check(
    'keyboard quick open palette focus and original panel selection retention',
    async () => {
      const keyboardChecks = [];
      await runNativeKeyboardJourney({
        page,
        fileName: 'README.md',
        checks: keyboardChecks,
      });
      await writeFile(
        join(output, 'keyboard-journey.json'),
        JSON.stringify({ checks: keyboardChecks }, null, 2),
      );
    },
  );
  await check(
    'original command card opens the same interactive PTY without respawn',
    async () => {
      await closeFile();
      assert.equal(
        resolve(commandHandoffFixture.nodePath),
        resolve(buildIdentity.bundledNode.path),
      );
      return runNativeCommandHandoffJourney({
        page,
        workspace: repo,
        parentSessionId: sessionId,
        state,
        until,
        output,
      });
    },
  );
  let childCommandReceipt;
  await check(childCommandCheckName, async () => {
    childCommandReceipt = await runNativeChildCommandHandoffJourney({
      page,
      workspace: repo,
      parentSessionId: sessionId,
      state,
      until,
      output,
      fixture: childCommandFixture,
    });
  });
  await check(
    "a task reviewer's source opens read-only in its own conversation",
    async () =>
      runNativeReviewerSourceJourney({
        page,
        parentSessionId: sessionId,
        state,
        until,
        output,
        previous: childCommandReceipt,
      }),
  );
  const childCommandPreviousApp = app;
  let childCommandRestartConfirmed = false;
  await check(inputRecoveryCheckName, async () => {
    await runNativeInputRecovery({
      getApp: () => app,
      getPage: () => page,
      state,
      query,
      sessionId,
      fixture,
      requestsPath,
      output,
      until,
      relaunch: async () => {
        await app.close();
        app = await electron.launch({
          chromiumSandbox: true,
          executablePath:
            process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
          args: [launchRoot],
          cwd: root,
          env,
        });
        page = await app.firstWindow();
        page.setDefaultTimeout(patience(15000));
        page.on('pageerror', (error) =>
          errors.push({ phase, error: String(error), stack: error.stack }),
        );
        // Resize the restarted window once it is shown, or showing it later
        // fits it to a small screen again.
        await page
          .getByRole('textbox', { name: 'message', exact: true })
          .waitFor();
        await desktopViewport();
        childCommandRestartConfirmed = app !== childCommandPreviousApp;
      },
    });
  });
  await check(
    'child command history after app restart is read-only without respawn',
    async () => {
      assert(
        childCommandRestartConfirmed,
        'the whole app restart replaced the application process',
      );
      return runNativeChildCommandAfterRestart({
        page,
        parentSessionId: sessionId,
        state,
        until,
        output,
        previous: childCommandReceipt,
      });
    },
  );
  if (process.env.CIRCLE_NATIVE_JOURNEY_WEB_DEBUG === '1')
    await check(
      'Chromium developer tools open and the page stays usable',
      async () => {
        if (!(await page.locator('.native-browser').isVisible()))
          await page
            .getByRole('button', { name: 'browser panel', exact: true })
            .click();
        await page
          .getByRole('textbox', { name: 'browser address', exact: true })
          .fill(origin);
        await page
          .getByRole('textbox', { name: 'browser address', exact: true })
          .press('Enter');
        await until(
          async () => browserStreams.size > 0,
          'actual web debug fixture stream connected',
        );
        await runNativeBrowserDebugJourney({
          getApp: () => app,
          pageURL: origin,
          page,
          sessionId,
          sourceURL: pathToFileURL(join(repo, 'browser-source.js')).href,
          fixture: browserDebugFixture,
          until,
          output,
          emit(marker) {
            for (const stream of browserStreams)
              stream.write('data: ' + marker + '\n\n');
          },
        });
      },
    );
  await check(
    'original inspector controls in both languages themes and narrow window',
    async () => {
      // The preceding web stack link intentionally opens the original file viewer.
      // Return through its visible close action before reading the parent draft.
      await closeFile();
      if (new URL(page.url()).hash !== `#/session/${sessionId}`) {
        const parent = page.locator(
          `.sidebar:visible .session-link[href="#/session/${sessionId}"][tabindex="0"]`,
        );
        await parent.waitFor({ state: 'visible' });
        assert.equal(
          await parent.count(),
          1,
          'return to the unique original parent history row',
        );
        await parent.click();
      }
      await page.waitForURL((url) => url.hash === `#/session/${sessionId}`);
      assert.equal(
        (await state()).activeSessionId,
        sessionId,
        'panel appearance inspects the original parent task',
      );
      await page
        .getByRole('textbox', { name: 'message', exact: true })
        .waitFor({ state: 'visible' });
      const originalDraft = await page
        .getByRole('textbox', { name: 'message', exact: true })
        .inputValue();
      let currentLocale = 'en';
      const closeServiceForm = async () => {
        if (await page.locator('.native-service-form').isVisible()) {
          await page.keyboard.press('Escape');
          await page
            .locator('.native-service-form')
            .waitFor({ state: 'hidden' });
        }
      };
      const visibleNavigation = async () => {
        const sidebar = page.locator('.sidebar:visible');
        if ((await sidebar.count()) === 0) {
          await page
            .getByRole('button', {
              name: /^(show or hide the sidebar|显示或隐藏侧边栏)$/,
              exact: true,
            })
            .click();
        }
        await sidebar.waitFor({ state: 'visible' });
        assert.equal(
          await sidebar.count(),
          1,
          'navigate using the sole visible original sidebar',
        );
        return sidebar;
      };
      // The shell the service form needs in front, made here when the conversation has
      // none, and stopped again when the appearance is restored.
      let serviceShell;
      const appearance = async ({ locale, theme }) => {
        await closeServiceForm();
        await closeNativeSettings(page);
        await closeDrawer();
        await (
          await visibleNavigation()
        )
          .getByRole('button', { name: /^(settings|设置)$/, exact: true })
          .click();
        await choose(
          page.getByRole('button', {
            name: locale === 'en' ? 'English' : '简体中文',
            exact: true,
          }),
          'language chosen',
        );
        await choose(
          page.getByRole('button', {
            name: theme === 'dark' ? /^(dark|深色)$/ : /^(light|浅色)$/,
            exact: true,
          }),
          'theme chosen',
        );
        await closeNativeSettings(page);
        // The session opens once the runtime has selected it; carry on only
        // when its page is on screen.
        await page.waitForFunction(
          (id) =>
            location.hash === `#/session/${id}` &&
            !!document.querySelector('.composer textarea'),
          sessionId,
        );
        assert.equal((await state()).activeSessionId, sessionId);
        currentLocale = locale;
      };
      await runNativePanelAcceptance({
        page,
        output,
        configureAppearance: appearance,
        resize: (size) => setViewport(app, page, size),
        openPanel: async (kind) => {
          await closeServiceForm();
          const zh = currentLocale === 'zh-CN';
          const toggle = page.getByRole('button', {
            name:
              kind === 'service'
                ? zh
                  ? '终端面板'
                  : 'terminal panel'
                : zh
                  ? '浏览器面板'
                  : 'browser panel',
            exact: true,
          });
          if ((await toggle.getAttribute('aria-pressed')) !== 'true')
            await toggle.click();
          if (kind === 'service') {
            // The form opens from the ⋮ menu of the terminal in front.
            const panel = page.locator(
              '[data-inspector-resource="terminal"] .native-terminal:visible',
            );
            await panel.waitFor();
            if (!(await panel.getByRole('tab').count())) {
              const prior = new Set(
                (await query('terminal', 'list')).map((item) => item.id),
              );
              await panel
                .getByRole('button', {
                  name: zh ? '新建终端或连接设备' : 'new terminal or device',
                  exact: true,
                })
                .click();
              await page
                .getByRole('menuitem', {
                  name: zh ? /^新建本地终端/ : /^new local terminal/,
                })
                .click();
              await until(
                async () =>
                  Boolean(
                    (serviceShell = (await query('terminal', 'list')).find(
                      (item) => !prior.has(item.id),
                    )),
                  ),
                'a shell for the service form',
              );
              await panel.getByRole('tab').first().waitFor();
            }
            await panel
              .getByRole('button', {
                name: zh ? '终端菜单' : 'terminal menu',
                exact: true,
              })
              .click();
            await page
              .getByRole('menuitem', {
                name: zh ? '启动服务' : 'start service',
                exact: true,
              })
              .click();
          } else {
            const address = page.getByRole('textbox', {
              name: zh ? '浏览器地址' : 'browser address',
              exact: true,
            });
            if (['', 'about:blank'].includes(await address.inputValue())) {
              await address.fill(origin);
              await address.press('Enter');
            }
            await address.waitFor();
          }
        },
        restore: async () => {
          await closeServiceForm();
          await setViewport(app, page, { width: 1400, height: 900 });
          await appearance({ locale: 'en', theme: 'dark' });
          assert.equal(
            await page
              .getByRole('textbox', { name: 'message', exact: true })
              .inputValue(),
            originalDraft,
            'appearance and original panel controls preserve the original task draft',
          );
          if (serviceShell) {
            const panel = await openNativeTerminalInspector(page);
            const close = panel
              .locator('.term-tab')
              .filter({
                has: page.locator(
                  `[role="tab"][aria-controls="terminal-${serviceShell.id}"]`,
                ),
              })
              .locator('.term-tab-x');
            if (await close.count()) await close.click();
            await until(
              async () =>
                !['running', 'stopping'].includes(
                  (await query('terminal', 'list')).find(
                    (item) => item.id === serviceShell.id,
                  )?.status,
                ),
              'the shell made for the service form stops',
            );
            await closeDrawer();
          }
        },
      });
    },
  );
  // At 1050 pixels or less the drawer lies over the conversation. A file opens there with
  // the tree beside it, and closing the file closes the drawer, back to the conversation.
  await check(
    'a narrow window lays an open file over the conversation and closing it closes the drawer',
    async () => {
      await closeFile();
      await closeDrawer();
      const message = page.getByRole('textbox', {
        name: 'message',
        exact: true,
      });
      const draft = await message.inputValue();
      await setViewport(app, page, { width: 760, height: 720 });
      try {
        const view = page.locator('.file-view:visible');
        const heading = (name) =>
          view
            .locator('.file-view-heading strong')
            .getByText(name, { exact: true });
        await openNativeProjectFile(page, 'README.md');
        await heading('README.md').waitFor();
        await page.locator('[data-inspector-mode="overlay"]').waitFor();
        // The tree beside the file opens the next one.
        await openNativeProjectFile(page, 'AGENTS.md');
        await heading('AGENTS.md').waitFor();
        await until(
          async () =>
            (await view.locator('.view-lines').first().textContent())
              .replaceAll('\u00a0', ' ')
              .includes('Keep native journey changes isolated.'),
          'the second file is the file on disk',
        );
        await screenshot('09a-narrow-open-file');
        await view
          .getByRole('button', { name: 'close file', exact: true })
          .click();
        await until(
          async () =>
            (await modeButton('files').getAttribute('aria-pressed')) !== 'true',
          'closing the file closes the drawer in a narrow window',
        );
        await message.waitFor({ state: 'visible' });
        assert.equal(await message.inputValue(), draft);
        // With the drawer closed, the next file opens the files mode again.
        await openNativeProjectFile(page, 'README.md');
        await heading('README.md').waitFor();
        await view
          .getByRole('button', { name: 'close file', exact: true })
          .click();
        await until(
          async () =>
            (await modeButton('files').getAttribute('aria-pressed')) !== 'true',
          'the drawer closes with the file again',
        );
        assert.equal(await message.inputValue(), draft);
      } finally {
        await closeFile();
        await closeDrawer();
        await desktopViewport();
      }
    },
  );
  await check('English Chinese dark light and narrow UI', async () => {
    await closeFile();
    await closeNativeSettings(page);
    await closeDrawer();
    for (const language of ['English', '简体中文'])
      for (const theme of ['dark', 'light']) {
        await page
          .getByRole('button', { name: /^(settings|设置)$/ })
          .last()
          .click();
        await choose(
          page.getByRole('button', { name: language, exact: true }),
          'language chosen',
        );
        await choose(
          page.getByRole('button', {
            name: theme === 'dark' ? /^(dark|深色)$/ : /^(light|浅色)$/,
          }),
          'theme chosen',
        );
        await closeNativeSettings(page);
        await page.waitForURL((url) => url.hash === `#/session/${sessionId}`);
        assert.equal((await state()).activeSessionId, sessionId);
        await screenshot(`08-${language === 'English' ? 'en' : 'zh'}-${theme}`);
      }
    await setViewport(app, page, { width: 760, height: 720 });
    await screenshot('09-zh-light-narrow');
  });
  assert.deepEqual(errors, []);
  if (process.env.CIRCLE_NATIVE_JOURNEY_MANUAL_CHECKPOINT === '1') {
    const resumeFile = join(output, 'manual-continue');
    await writeFile(
      join(output, 'manual-ready.json'),
      JSON.stringify(
        {
          pid: app.process().pid,
          sessionId,
          appPath: launchRoot,
          executablePath: app.process().spawnfile,
          sourceBuildHead: buildIdentity.sourceBuildHead,
          resumeFile,
          scope:
            'isolated native journey only; automated checks precede manual use',
        },
        null,
        2,
      ) + '\n',
    );
    console.log('native journey: isolated manual checkpoint ready');
    const deadline = Date.now() + 600_000;
    while (
      !(await readFile(resumeFile).then(
        () => true,
        () => false,
      ))
    ) {
      assert(Date.now() < deadline, 'manual checkpoint timed out');
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  phase = 'final verification';
  // The evidence folder may not reach CI's artifacts, so the log says why too: the
  // phases that failed first, then those blocked behind them, which were not run.
  const failedChecks = checks.filter((c) => c.status === 'failed');
  const blockedChecks = checks.filter((c) => c.status === 'blocked');
  for (const failed of [...failedChecks, ...blockedChecks])
    console.error(
      `native journey ${failed.status}: ${failed.name}\n  ${String(
        failed.error ?? failed.reason ?? '',
      )
        .split('\n')
        .slice(0, 12)
        .join('\n  ')}`,
    );
  if (failedChecks.length || blockedChecks.length)
    console.error(
      `native journey: ${checks.length - failedChecks.length - blockedChecks.length} passed, ${failedChecks.length} failed, ${blockedChecks.length} blocked` +
        (failedChecks.length
          ? '\n  failed: ' +
            failedChecks.map((c) => c.name).join('\n          ')
          : '') +
        (blockedChecks.length
          ? '\n  blocked: ' +
            blockedChecks.map((c) => c.name).join('\n           ')
          : ''),
    );
  assert.equal(
    failedChecks.length + blockedChecks.length,
    0,
    'native journey has failed or blocked phases; see per-phase evidence',
  );
  receipt = {
    status: 'passed',
    packaged,
    checks,
    errors,
    output,
    fixtureIsolation: true,
    interactions: 'Playwright native UI; RPC queries only verify effects',
    nativeSourceNavigation:
      'file sourceURL exactly matches local fixture bytes; HTTP sources are not guessed as project paths',
  };
} catch (error) {
  receipt = {
    status: 'failed',
    packaged,
    phase,
    checks,
    errors,
    error: String(error),
    stack: error.stack,
  };
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  let cleanupError;
  try {
    if (app) {
      // Restore nested captures in reverse order so the oldest original wins.
      for (const key of pendingNativeClipboardCheckpoints().reverse())
        await restoreNativeClipboard(app, key);
      clipboardRecoveryPending = false;
      const nativeProcess = app.process();
      if (nativeProcess.exitCode === null && nativeProcess.signalCode === null)
        await app.close();
    }
  } catch (e) {
    cleanupError = String(e);
    clipboardRecoveryPending = pendingNativeClipboardCheckpoints().length > 0;
    console.error(
      'Native cleanup failed; recovery checkpoints and profile are retained. No automatic profile deletion.',
    );
  }
  const fixtureFinal = {};
  for (const file of [
    'README.md',
    'AGENTS.md',
    'editor-main.ts',
    'editor-lib.ts',
    'isolation-a.ts',
    'isolation-b.md',
    'git-probe.txt',
    'browser-source.js',
    ...terminalShortcutsFixture.files,
    ...continuityFixture.files,
    ...commandHandoffFixture.files,
    ...childCommandFixture.files,
    'agent-result.txt',
  ]) {
    try {
      fixtureFinal[file] = await readFile(join(repo, file), 'utf8');
    } catch (error) {
      fixtureFinal[file] = { unavailable: String(error) };
    }
  }
  await writeFile(
    join(output, 'fixture-final.json'),
    JSON.stringify(fixtureFinal, null, 2),
  );
  try {
    await writeFile(
      join(output, 'actual-scripted-requests.jsonl'),
      await readFile(requestsPath),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const nativeCleanupPending =
    Boolean(cleanupError) || clipboardRecoveryPending;
  if (!nativeCleanupPending) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(temp, { recursive: true, force: true });
  }
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        ...receipt,
        diagnostic,
        recoveries,
        buildIdentity,
        cleanup: {
          applicationClosed: !cleanupError && !clipboardRecoveryPending,
          clipboardRecoveryPending,
          ...(nativeCleanupPending ? { retainedProfile: temp } : {}),
          error: cleanupError,
          serverClosed: !nativeCleanupPending,
          temporaryProfileRemoved: !nativeCleanupPending,
        },
      },
      null,
      2,
    ) + '\n',
  );
  if (nativeCleanupPending) await new Promise(() => {});
}
