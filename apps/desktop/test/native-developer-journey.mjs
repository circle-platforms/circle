import {
  createNativeContinuityFixture,
  runNativeTerminalContextJourney,
  runNativeChildSourceJourney,
} from './helpers/native-continuity-journey.mjs';
import {
  browserDebugFixtureSource,
  runNativeBrowserDebugJourney,
} from './helpers/native-browser-debug-journey.mjs';
import { nativeTaskJourneyFixture } from './helpers/native-task-fixture.mjs';
import {
  preserveNativeClipboard,
  restoreNativeClipboard,
} from './helpers/native-clipboard.mjs';
import {
  createNativeGitFixture,
  runNativeGitJourney,
} from './helpers/native-git-journey.mjs';
import {
  createNativeTerminalFixture,
  runNativeTerminalJourney,
} from './helpers/native-terminal-journey.mjs';
import {
  createNativeDebugFixture,
  runNativeDebugJourney,
} from './helpers/native-debug-journey.mjs';
import { runNativeKeyboardJourney } from './helpers/native-keyboard-journey.mjs';
import {
  createNativeEditorSemanticsFixture,
  runNativeEditorSemantics,
} from './helpers/native-editor-semantics.mjs';
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
} from './helpers/native-journey-platform.mjs';
// Real renderer interactions; RPC is limited to fixture preparation and effect queries.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setViewport } from './helpers/viewport.mjs';
const require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packaged = !!process.env.CIRCLE_DESKTOP_EXECUTABLE;
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
const program =
  "function fixture() {\n  const count = 3;\n  const next = count + 1;\n  console.log('DEBUG_RESULT', next);\n  return next;\n}\nfixture();\n";
const browserDebugFixture = browserDebugFixtureSource(
  "function browserFixture(){\n  console.error('JOURNEY_CONSOLE_SOURCE');\n}\nbrowserFixture();\nfetch('/api/data').then(r=>r.text()).then(v=>console.log(v));\nlocalStorage.setItem('journey','before');\nnew EventSource('/events').onmessage = event => console.log(event.data);\n",
);
const browserSource = browserDebugFixture.source;
await Promise.all([
  writeFile(
    join(repo, 'AGENTS.md'),
    '# local fixture rules\nKeep native journey changes isolated.\n',
  ),
  writeFile(join(repo, 'git-probe.txt'), 'baseline\n'),
  writeFile(join(repo, 'README.md'), baseline),
  writeFile(join(repo, 'debug.cjs'), program),
  writeFile(
    join(repo, 'debug-args.cjs'),
    "const args = process.argv.slice(2);\nconsole.log('JOURNEY_LITERAL_ARGS', JSON.stringify(args));\n",
  ),
  writeFile(join(repo, 'browser-source.js'), browserSource),
  writeFile(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'native-journey', private: true }),
  ),
]);
await createNativeGitFixture(repo);
await createNativeEditorFixture(repo);
await createNativeEditorSemanticsFixture(repo);
const terminalFixture = await createNativeTerminalFixture(repo);
const continuityFixture = await createNativeContinuityFixture(repo);
const debugFixture = await createNativeDebugFixture(repo);
const isolationFiles = await createNativeEditorIsolationFixture(repo);
const git = async (...args) =>
  (await promisify(execFile)('git', ['-C', repo, ...args])).stdout;
await git('init', '-b', 'main');
await git(
  'add',
  ...isolationFiles,
  '.circle-editor-isolation-fixture.json',
  ...terminalFixture.files,
  ...continuityFixture.files,
  debugFixture.program,
  '.circle-native-debug-interaction.json',
  'editor-supplement.ts',
  'editor-main.ts',
  'editor-lib.ts',
  '.circle-editor-journey.json',
  'AGENTS.md',
  'git-probe.txt',
  'README.md',
  'debug.cjs',
  'debug-args.cjs',
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
await writeFile(
  fixture,
  JSON.stringify(nativeTaskJourneyFixture(requestsPath)),
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
await new Promise((done) => server.listen(0, '127.0.0.1', done));
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
const until = async (predicate, label) => {
  const deadline = Date.now() + 20000;
  while (!(await predicate().catch(() => false))) {
    assert(Date.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 40));
  }
};
const dependencies = {
  'original file viewer and active-turn manual edit save': [
    'native identity and original panels',
  ],
  'two isolated write agents and readonly agent with pending Git approval': [
    'original file viewer and active-turn manual edit save',
  ],
  'native terminal selection enters original unsent context and preserves processes':
    ['native identity and original panels'],
  'real child source ownership and return to child while parent saves another file':
    ['two isolated write agents and readonly agent with pending Git approval'],
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
  if (blocked.length) {
    checks.push({
      name,
      status: 'blocked',
      reason: 'requires successful ' + blocked.join(', '),
    });
    return;
  }
  const start = Date.now();
  try {
    if (sessionId && page) {
      const parent = page.locator(
        `.sidebar .session-link[href="#/session/${sessionId}"]`,
      );
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
    if (app)
      clipboardRecoveryPending = await app
        .evaluate(() => !!globalThis.__circleJourneyClipboard?.size)
        .catch(() => clipboardRecoveryPending);
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
const launchRoot = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root);
const buildIdentity = {
  sourceBuildHead: process.env.CIRCLE_NATIVE_JOURNEY_SOURCE_BUILD_HEAD ?? null,
  appPath: launchRoot,
  files: {},
  driverFiles: {},
  fixtureFiles: {},
};
for (const file of continuityFixture.files)
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
    'native-editor-semantics',
    'native-terminal-journey',
    'native-continuity-journey',
    'native-debug-journey',
    'native-keyboard-journey',
    'native-git-journey',
    'native-journey-platform',
    'native-clipboard',
    'native-task-fixture',
    'native-browser-debug-journey',
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
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) =>
    errors.push({ phase, error: String(e), stack: e.stack }),
  );
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
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
    const close = page.getByRole('button', { name: 'close file', exact: true });
    if (await close.isVisible()) await close.click();
  };
  const openInspector = async (kind, tab) => {
    const toggle = page.getByRole('button', {
      name: `${kind} panel`,
      exact: true,
    });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click();
    await page.locator(`#inspector-${kind}-tab-${tab}`).click();
    await page
      .locator(`#inspector-${kind}-${tab}`)
      .waitFor({ state: 'visible' });
  };
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
    await page
      .locator('.main-stack .conversation')
      .waitFor({ state: 'visible' });
    await send('Prepare native journey');
    await page
      .getByText('Native journey ready: README.md and debug.cjs', {
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
      if (
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .isVisible()
      )
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .click();
    },
  );
  await check(
    'native editor semantic navigation and conflict journey',
    async () => {
      await page
        .getByRole('button', { name: 'files panel', exact: true })
        .click();
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
      if (
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .isVisible()
      )
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .click();
    },
  );
  await check(
    'supplemental editor references completion formatting and replacement',
    async () => {
      await runNativeEditorSemantics({
        page,
        workspace: repo,
        sessionId,
        output,
        assertDevToolsClosed: async () => {
          const mainWindow = await app.browserWindow(page);
          const windowId = await mainWindow.evaluate((window) => window.id);
          const opened = await app.evaluate(({ BrowserWindow }, id) => {
            const window = BrowserWindow.fromId(id);
            if (!window || window.isDestroyed())
              throw new Error('native journey main window is unavailable');
            return window.webContents.isDevToolsOpened();
          }, windowId);
          assert.equal(
            opened,
            false,
            'formatting must keep main DevTools closed',
          );
        },
      });
    },
  );
  await check(
    'loaded project instruction source opens actual file',
    async () => {
      await page
        .getByRole('button', { name: 'context panel', exact: true })
        .click();
      await page
        .locator('.inspector details')
        .filter({ hasText: 'AGENTS.md' })
        .first()
        .locator('summary')
        .click();
      await page
        .locator('.inspector')
        .getByRole('button', { name: /AGENTS\.md/ })
        .first()
        .click();
      await page
        .locator('.file-view')
        .filter({ hasText: 'AGENTS.md' })
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
        .getByRole('button', { name: 'edit', exact: true })
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
      await page.keyboard.press('ControlOrMeta+s');
      await until(
        async () =>
          (await readFile(join(repo, 'README.md'), 'utf8')).includes(
            'JOURNEY_MANUAL_SAVE',
          ),
        'actual disk save during active agent',
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
  await check('interactive PTY stdin and output', async () => {
    await openInspector('terminal', 'terminal');
    await page
      .getByRole('button', { name: 'new terminal', exact: true })
      .first()
      .click();
    const terminal = page
      .locator('.native-terminal .xterm-helper-textarea')
      .last();
    await terminal.focus();
    for (const chunk of journeyShellInput()) await page.keyboard.type(chunk);
    await until(async () => {
      const terminals = await query('terminal', 'list');
      if (!terminals.length) return false;
      const log = await query('terminal', 'replay', {
        id: terminals.at(-1).id,
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
      return runNativeTerminalContextJourney({
        page,
        workspace: repo,
        sessionId,
        fixture: continuityFixture,
        nodePath: buildIdentity.bundledNode.path,
        query,
        state,
        until,
        output,
      });
    },
  );
  await check('Git working diff stage and unstage hunk', async () => {
    await openInspector('changes', 'git');
    const panel = page.locator('.native-git');
    await panel
      .getByRole('button', { name: 'refresh', exact: true })
      .first()
      .click();
    await panel
      .getByRole('button', { name: 'git-probe.txt', exact: true })
      .click();
    await panel
      .getByLabel('git diff', { exact: true })
      .filter({ hasText: 'JOURNEY_GIT_HUNK' })
      .waitFor();
    await panel
      .getByRole('button', { name: 'stage this hunk', exact: true })
      .first()
      .click();
    await until(
      async () =>
        (await git('diff', '--cached', '--', 'git-probe.txt')).includes(
          'JOURNEY_GIT_HUNK',
        ),
      'actual index hunk staged',
    );
    await panel
      .getByRole('button', { name: 'staged changes', exact: true })
      .click();
    await panel
      .getByRole('button', { name: 'git-probe.txt', exact: true })
      .click();
    await screenshot('04-staged-git-hunk');
    await panel
      .getByRole('button', { name: 'unstage this hunk', exact: true })
      .first()
      .click();
    await until(
      async () =>
        !(await git('diff', '--cached', '--', 'git-probe.txt')).includes(
          'JOURNEY_GIT_HUNK',
        ),
      'actual index hunk unstaged',
    );
  });
  await check(
    'Git consecutive scoped commits local push conflict continue and abort',
    async () => {
      await page
        .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
        .click();
      const beforeBranch = (await git('branch', '--show-current')).trim();
      const beforeReadme = await readFile(join(repo, 'README.md'), 'utf8');
      await runNativeGitJourney({ page, workspace: repo, sessionId, output });
      assert.equal(
        (await git('branch', '--show-current')).trim(),
        beforeBranch,
      );
      assert.equal(
        await readFile(join(repo, 'README.md'), 'utf8'),
        beforeReadme,
        'extended Git journey preserves existing manual edits',
      );
    },
  );
  await check('Node launch breakpoint variables and step', async () => {
    await openInspector('activity', 'debug');
    const panel = page.locator('.debug-panel');
    await panel.getByLabel('program path', { exact: true }).fill('debug.cjs');
    await panel.getByLabel('breakpoint line', { exact: true }).fill('3');
    await panel
      .getByRole('button', { name: 'set breakpoint', exact: true })
      .click();
    await panel.getByRole('button', { name: 'launch', exact: true }).click();
    await until(
      async () => (await query('debug', 'snapshot')).status === 'paused',
      'Node hits the breakpoint configured before launch',
    );
    await until(async () => {
      const r = await query('debug', 'stackTrace');
      return r.stackFrames?.[0]?.line === 3;
    }, 'real Node breakpoint line3');
    await panel
      .getByRole('button', { name: /fixture.*debug\.cjs:3/ })
      .first()
      .click();
    await panel.getByRole('button', { name: 'count', exact: true }).waitFor();
    assert.equal(
      await panel
        .getByRole('button', { name: 'count', exact: true })
        .locator('..')
        .locator('code')
        .innerText(),
      '3',
    );
    await screenshot('05-node-breakpoint');
    await panel.getByRole('button', { name: 'step over', exact: true }).click();
    await until(
      async () =>
        (await query('debug', 'stackTrace')).stackFrames?.[0]?.line === 4,
      'Node stepOver line4',
    );
    await panel.getByRole('button', { name: 'continue', exact: true }).click();
    await until(
      async () =>
        (await query('debug', 'snapshot')).output.includes('DEBUG_RESULT 4'),
      'Node continued real output',
    );
  });
  await check('explicit entry pause and literal launch arguments', async () => {
    await openInspector('activity', 'debug');
    const panel = page.locator('.debug-panel');
    await until(
      async () =>
        ['idle', 'stopped', 'failed'].includes(
          (await query('debug', 'snapshot')).status,
        ),
      'prior debug process completed',
    );
    await panel
      .getByLabel('program path', { exact: true })
      .fill('debug-args.cjs');
    await panel.locator('.debug-launch-options summary').click();
    await panel
      .getByRole('checkbox', { name: 'pause at entry', exact: true })
      .check();
    const args = ['two words', '"quoted"', ''];
    for (let index = 0; index < args.length; index++) {
      await panel
        .getByRole('button', { name: 'add argument', exact: true })
        .click();
      await panel
        .getByLabel('program argument ' + (index + 1), { exact: true })
        .fill(args[index]);
    }
    await panel.getByRole('button', { name: 'launch', exact: true }).click();
    await until(
      async () => (await query('debug', 'snapshot')).status === 'paused',
      'explicit entry pause takes effect',
    );
    const frames = await query('debug', 'stackTrace');
    assert(
      frames.stackFrames.some((frame) =>
        frame.source?.path?.endsWith('debug-args.cjs'),
      ),
      'entry pause belongs to actual args fixture',
    );
    await screenshot('05-debug-explicit-entry-arguments');
    await panel.getByRole('button', { name: 'continue', exact: true }).click();
    await until(
      async () =>
        (await query('debug', 'snapshot')).output.includes(
          'JOURNEY_LITERAL_ARGS ' + JSON.stringify(args),
        ),
      'actual process argv preserves spaces quotes and empty argument',
    );
    await writeFile(
      join(output, 'debug-literal-arguments.json'),
      JSON.stringify(
        { args, output: (await query('debug', 'snapshot')).output },
        null,
        2,
      ),
    );
    await panel
      .getByRole('checkbox', { name: 'pause at entry', exact: true })
      .uncheck();
  });
  await check(
    'debug variable editing steps interactive stdin and inspector cleanup',
    async () => {
      await runNativeDebugJourney({
        page,
        workspace: repo,
        sessionId,
        query,
        until,
        output,
        screenshot,
      });
    },
  );
  await check('browser diagnostics actual source navigation', async () => {
    await page
      .getByRole('button', { name: 'browser panel', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'browser address', exact: true })
      .fill(origin);
    await page
      .getByRole('button', { name: 'navigate browser', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'page diagnostics', exact: true })
      .click();
    const panel = page.locator('.browser-diagnostics');
    const entry = panel
      .locator('details')
      .filter({
        has: page.locator('summary', { hasText: 'JOURNEY_CONSOLE_SOURCE' }),
      })
      .first();
    await entry.locator('summary').click();
    await entry
      .getByRole('button', { name: /browserFixture.*browser-source\.js:2/ })
      .click();
    await until(
      async () =>
        (await page
          .locator('.file-view')
          .getByText('browser-source.js', { exact: false })
          .count()) > 0,
      'console opens real local source',
    );
    await until(
      async () =>
        (await page
          .locator('.file-view .monaco-editor .line-numbers.active-line-number')
          .first()
          .innerText()) === '2',
      'console source cursor is at actual line2',
    );
    await screenshot('06-console-to-source');
    const browserToggle = page.getByRole('button', {
      name: 'browser panel',
      exact: true,
    });
    if ((await browserToggle.getAttribute('aria-pressed')) !== 'true')
      await browserToggle.click();
    const diagnosticsToggle = page.getByRole('button', {
      name: 'page diagnostics',
      exact: true,
    });
    if ((await diagnosticsToggle.getAttribute('aria-expanded')) !== 'true')
      await diagnosticsToggle.click();
    await panel.getByRole('tab', { name: 'network', exact: true }).click();
    await panel.getByRole('button', { name: /GET 200.*api\/data/ }).click();
    await panel.getByText('JOURNEY_NETWORK_OK', { exact: true }).waitFor();
    await panel.getByRole('tab', { name: 'storage', exact: true }).click();
    await panel.getByLabel('storage key', { exact: true }).fill('journey');
    await panel.getByLabel('storage value', { exact: true }).fill('after');
    await panel
      .getByRole('button', { name: 'save storage item', exact: true })
      .click();
    await panel.getByText('journey: after', { exact: true }).waitFor();
    // Read back via the native page debugger, not the renderer origin.
    const actual = await page.evaluate(
      ({ sessionId, origin }) =>
        window.circleDesktop.browserDiagnostics(sessionId, {
          action: 'storage',
          kind: 'local',
          origin,
          operation: 'read',
        }),
      { sessionId, origin },
    );
    assert(actual.storage.some(([k, v]) => k === 'journey' && v === 'after'));
    const viewportSettings = panel.locator('details').filter({
      has: page.locator('summary', { hasText: 'viewport and developer tools' }),
    });
    if (!(await viewportSettings.evaluate((node) => node.open)))
      await viewportSettings.locator('summary').click();
    await panel.getByLabel('viewport width', { exact: true }).fill('375');
    await panel.getByLabel('viewport height', { exact: true }).fill('812');
    await panel
      .getByRole('button', { name: 'apply viewport', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'capture browser', exact: true })
      .click();
    await page.getByText('captured observation', { exact: true }).click();
    const capture = await page
      .locator('.native-browser img.attachment-image')
      .getAttribute('src');
    assert(capture?.startsWith('data:image/png;base64,'));
    const png = Buffer.from(capture.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), 375);
    assert.equal(png.readUInt32BE(20), 812);
    await writeFile(join(output, '07-actual-browser-capture-375x812.png'), png);
    await screenshot('07-browser-storage-viewport');
    if (process.env.CIRCLE_NATIVE_JOURNEY_PUSH === '1') {
      await until(
        async () => browserStreams.size > 0,
        'synthetic browser event stream connected',
      );
      await runNativeBrowserStream({
        page,
        sessionId,
        output,
        emit(marker) {
          for (const stream of browserStreams)
            stream.write('data: ' + marker + '\n\n');
        },
      });
    }
  });
  await check('draft survives original inspector switches', async () => {
    await closeFile();
    const message = page.getByRole('textbox', { name: 'message', exact: true });
    await message.fill('JOURNEY_UNSENT_DRAFT');
    await message.evaluate((node) => node.setSelectionRange(3, 10));
    await openInspector('terminal', 'terminal');
    await openInspector('changes', 'original');
    await openInspector('activity', 'original');
    await page
      .getByRole('button', { name: 'close inspector', exact: true })
      .click();
    assert.equal(await message.inputValue(), 'JOURNEY_UNSENT_DRAFT');
    assert.deepEqual(
      await message.evaluate((node) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
      [3, 10],
    );
  });

  await check(
    'two isolated write agents and readonly agent with pending Git approval',
    async () => {
      if (
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .isVisible()
      )
        await page
          .getByRole('button', { name: 'close inspector', exact: true })
          .click();
      await openInspector('activity', 'tasks');
      const panel = page.locator('.tasks-panel');
      const queue = async (prompt, access) => {
        const newTask = panel.getByRole('button', {
          name: 'new task',
          exact: true,
        });
        if (await newTask.isVisible()) await newTask.click();
        await panel
          .getByLabel('task instruction', { exact: true })
          .fill(prompt);
        await panel
          .getByLabel('acceptance criteria', { exact: true })
          .fill('Inspect actual file and git effects');
        await panel
          .locator('label')
          .filter({ hasText: 'workspace access' })
          .locator('select')
          .selectOption(access);
        await panel
          .getByRole('button', { name: 'queue task', exact: true })
          .click();
        const startReady = panel.getByRole('button', {
          name: 'start ready tasks',
          exact: true,
        });
        if (await startReady.isEnabled()) await startReady.click();
      };
      await queue('JOURNEY_WRITE_A', 'write');
      await until(
        async () =>
          (await query('tasks', 'list')).some(
            (t) => t.spec.prompt === 'JOURNEY_WRITE_A' && t.state === 'waiting',
          ),
        'first task awaits human',
      );
      await queue('JOURNEY_WRITE_B', 'write');
      await until(
        async () =>
          (await query('tasks', 'list')).some(
            (t) => t.spec.prompt === 'JOURNEY_WRITE_B' && t.state === 'waiting',
          ),
        'second task independently awaits human',
      );
      await queue('JOURNEY_READ_ONLY', 'readonly');
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
          if (pending.command?.includes('git status'))
            gitApprovalObserved = true;
          await page
            .locator(
              `.sidebar .session-link[href="#/session/${record.runtimeSessionId}"]`,
            )
            .click();
          await page
            .getByRole('button', { name: 'allow once', exact: true })
            .first()
            .waitFor();
          await page
            .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
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
          await page
            .locator(
              `.sidebar .session-link[href="#/session/${record.runtimeSessionId}"]`,
            )
            .click();
          await page
            .getByRole('button', { name: 'allow once', exact: true })
            .first()
            .click();
          await page
            .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
            .click();
          await until(
            async () =>
              !(await state()).interactions.some(
                (i) => i.id === pending.id && i.status === 'pending',
              ),
            'approval consumed exactly once',
          );
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
    },
  );
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
        entry: 'activity',
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
    'whole app restart preserves inputs without automatic sending',
    async () => {
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
          page.setDefaultTimeout(15000);
          page.on('pageerror', (error) =>
            errors.push({ phase, error: String(error), stack: error.stack }),
          );
        },
      });
    },
  );
  if (process.env.CIRCLE_NATIVE_JOURNEY_WEB_DEBUG === '1')
    await check(
      'web GUI breakpoint refreshed locals source navigation and resume',
      async () => {
        if (!(await page.locator('.native-browser').isVisible()))
          await page
            .getByRole('button', { name: 'browser panel', exact: true })
            .click();
        await page
          .getByRole('textbox', { name: 'browser address', exact: true })
          .fill(origin);
        await page
          .getByRole('button', { name: 'navigate browser', exact: true })
          .click();
        const diagnostics = page.getByRole('button', {
          name: 'page diagnostics',
          exact: true,
        });
        if ((await diagnostics.getAttribute('aria-expanded')) !== 'true')
          await diagnostics.click();
        await until(
          async () => browserStreams.size > 0,
          'actual web debug fixture stream connected',
        );
        await runNativeBrowserDebugJourney({
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
  await check('English Chinese dark light and narrow UI', async () => {
    if (
      await page
        .getByRole('button', { name: 'close inspector', exact: true })
        .isVisible()
    )
      await page
        .getByRole('button', { name: 'close inspector', exact: true })
        .click();
    for (const language of ['English', '简体中文'])
      for (const theme of ['dark', 'light']) {
        await page
          .getByRole('button', { name: /^(settings|设置)$/ })
          .last()
          .click();
        await page.getByRole('button', { name: language, exact: true }).click();
        await page
          .getByRole('button', {
            name: theme === 'dark' ? /^(dark|深色)$/ : /^(light|浅色)$/,
          })
          .click();
        await page
          .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
          .click();
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
  assert.equal(
    checks.filter((c) => c.status !== 'passed').length,
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
      const keys = await app.evaluate(() => [
        ...(globalThis.__circleJourneyClipboard?.keys() ?? []),
      ]);
      for (const key of keys) await restoreNativeClipboard(app, key);
      clipboardRecoveryPending = false;
      await app.close();
    }
  } catch (e) {
    cleanupError = String(e);
    clipboardRecoveryPending = true;
    console.error(
      'Native clipboard recovery failed; application and main checkpoint are retained. No automatic close or profile deletion.',
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
    'debug.cjs',
    'browser-source.js',
    ...continuityFixture.files,
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
  if (!clipboardRecoveryPending) {
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
          ...(clipboardRecoveryPending ? { retainedProfile: temp } : {}),
          error: cleanupError,
          serverClosed: !clipboardRecoveryPending,
          temporaryProfileRemoved: !clipboardRecoveryPending,
        },
      },
      null,
      2,
    ) + '\n',
  );
  if (clipboardRecoveryPending) await new Promise(() => {});
}
