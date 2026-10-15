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
import { createRequire } from 'node:module';
import { setViewport } from './helpers/viewport.mjs';
const require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packaged = !!process.env.CIRCLE_DESKTOP_EXECUTABLE;
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
const repo = join(data, 'runtime-home', 'workspace');
await mkdir(repo, { recursive: true });
const baseline = '# native journey\n\noriginal content\n';
const program =
  "function fixture() {\n  const count = 3;\n  const next = count + 1;\n  console.log('DEBUG_RESULT', next);\n  return next;\n}\nfixture();\n";
const browserSource =
  "function browserFixture(){\n  console.error('JOURNEY_CONSOLE_SOURCE');\n}\nbrowserFixture();\nfetch('/api/data').then(r=>r.text()).then(v=>console.log(v));\nlocalStorage.setItem('journey','before');\n";
await Promise.all([
  writeFile(
    join(repo, 'AGENTS.md'),
    '# local fixture rules\nKeep native journey changes isolated.\n',
  ),
  writeFile(join(repo, 'README.md'), baseline),
  writeFile(join(repo, 'debug.cjs'), program),
  writeFile(join(repo, 'browser-source.js'), browserSource),
  writeFile(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'native-journey', private: true }),
  ),
]);
const git = async (...args) =>
  (await promisify(execFile)('git', ['-C', repo, ...args])).stdout;
await git('init', '-b', 'main');
await git('add', 'README.md', 'debug.cjs', 'browser-source.js', 'package.json');
await git(
  '-c',
  'user.name=Circle Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-m',
  'Create isolated journey baseline',
);
const fixture = join(temp, 'model.json');
await writeFile(
  fixture,
  JSON.stringify({
    replies: [
      {
        message: {
          id: 'journey-baseline',
          role: 'assistant',
          content: 'Native journey ready: README.md and debug.cjs',
        },
      },
      { waitForAbort: true },
    ],
  }),
);
const server = createServer((request, response) => {
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
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_LANGUAGE: 'en',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
if (packaged)
  env.PATH =
    process.platform === 'win32'
      ? `${process.env.SystemRoot}\\System32`
      : '/usr/bin:/bin:/usr/sbin:/sbin';
let app, page;
const checks = [];
const errors = [];
let phase = 'launch';
let sessionId;
let receipt;
const until = async (predicate, label) => {
  const deadline = Date.now() + 20000;
  while (!(await predicate())) {
    assert(Date.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 40));
  }
};
const check = async (name, action) => {
  phase = name;
  const start = Date.now();
  const result = await action();
  checks.push({
    name,
    status: 'passed',
    durationMs: Date.now() - start,
    result,
  });
};
const screenshot = async (name) => {
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
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(String(e)));
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
  const send = async (text) => {
    await page
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(text);
    await page
      .getByRole('button', { name: 'send message', exact: true })
      .click();
  };
  await check('native identity and task layout', async () => {
    assert.equal(
      (await page.evaluate(() => window.circleDesktop.info())).packaged,
      packaged,
    );
    await page
      .getByRole('button', { name: 'task layout', exact: true })
      .click();
    assert.equal(
      await page.locator('.developer-workbench').getAttribute('data-layout'),
      'task',
    );
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
    await screenshot('01-task-layout');
  });
  await check(
    'loaded project instruction source opens actual file',
    async () => {
      await page
        .getByRole('button', { name: 'context panel', exact: true })
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
      await screenshot('01b-instruction-source');
      await page
        .getByRole('button', { name: 'close inspector', exact: true })
        .click();
    },
  );
  await check('developer layout and active-turn manual edit save', async () => {
    await page
      .getByRole('button', { name: 'developer layout', exact: true })
      .click();
    await send('Remain active while I edit and diagnose');
    await until(
      async () =>
        (await state()).sessions.find((s) => s.id === sessionId)?.state ===
        'running',
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
    await editor.locator('textarea').focus();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\nJOURNEY_MANUAL_SAVE\n');
    await page.keyboard.press('ControlOrMeta+s');
    await until(
      async () =>
        (await readFile(join(repo, 'README.md'), 'utf8')).includes(
          'JOURNEY_MANUAL_SAVE',
        ),
      'actual disk save during active agent',
    );
    assert.equal(
      (await state()).sessions.find((s) => s.id === sessionId)?.state,
      'running',
    );
    await screenshot('02-active-manual-edit');
  });
  await check('interactive PTY stdin and output', async () => {
    await page.locator('#dock-tab-terminal').click();
    await page
      .getByRole('button', { name: 'new terminal', exact: true })
      .click();
    const terminal = page
      .locator('.native-terminal .xterm-helper-textarea')
      .last();
    await terminal.focus();
    await page.keyboard.type(
      "printf 'JOURNEY_INPUT? '; read answer; printf '\\nJOURNEY_ECHO:%s\\n' \"$answer\"\n",
    );
    await page.keyboard.type('native-input\n');
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
  await check('Git working diff stage and unstage hunk', async () => {
    await page.locator('#dock-tab-git').click();
    const panel = page.locator('.native-git');
    await panel
      .getByRole('button', { name: 'refresh', exact: true })
      .first()
      .click();
    await panel.getByRole('button', { name: 'README.md', exact: true }).click();
    await panel
      .getByLabel('git diff', { exact: true })
      .filter({ hasText: 'JOURNEY_MANUAL_SAVE' })
      .waitFor();
    await panel
      .getByRole('button', { name: 'stage this hunk', exact: true })
      .first()
      .click();
    await until(
      async () =>
        (await git('diff', '--cached', '--', 'README.md')).includes(
          'JOURNEY_MANUAL_SAVE',
        ),
      'actual index hunk staged',
    );
    await panel
      .getByRole('button', { name: 'staged changes', exact: true })
      .click();
    await panel.getByRole('button', { name: 'README.md', exact: true }).click();
    await screenshot('04-staged-git-hunk');
    await panel
      .getByRole('button', { name: 'unstage this hunk', exact: true })
      .first()
      .click();
    await until(
      async () =>
        !(await git('diff', '--cached', '--', 'README.md')).includes(
          'JOURNEY_MANUAL_SAVE',
        ),
      'actual index hunk unstaged',
    );
  });
  await check('Node launch breakpoint variables and step', async () => {
    await page.locator('#dock-tab-debug').click();
    const panel = page.locator('.debug-panel');
    await panel.getByLabel('program path', { exact: true }).fill('debug.cjs');
    await panel.getByRole('button', { name: 'launch', exact: true }).click();
    await until(
      async () => (await query('debug', 'snapshot')).status === 'paused',
      'Node paused on entry',
    );
    await panel.getByLabel('breakpoint line', { exact: true }).fill('3');
    await panel
      .getByRole('button', { name: 'set breakpoint', exact: true })
      .click();
    await panel.getByRole('button', { name: 'continue', exact: true }).click();
    await until(async () => {
      const r = await query('debug', 'stackTrace');
      return r.stackFrames?.[0]?.line === 3;
    }, 'real Node breakpoint line3');
    await panel
      .getByRole('button', { name: /fixture.*debug\.cjs:3/ })
      .first()
      .click();
    await panel.getByRole('button', { name: 'count', exact: true }).waitFor();
    assert((await panel.innerText()).includes('3'));
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
    await screenshot('06-console-to-source');
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
    await panel.getByLabel('viewport width', { exact: true }).fill('375');
    await panel.getByLabel('viewport height', { exact: true }).fill('812');
    await panel
      .getByRole('button', { name: 'apply viewport', exact: true })
      .click();
    await screenshot('07-browser-storage-viewport');
  });
  await check('draft survives layout switches', async () => {
    const message = page.getByRole('textbox', { name: 'message', exact: true });
    await message.fill('JOURNEY_UNSENT_DRAFT');
    await page
      .getByRole('button', { name: 'task layout', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'developer layout', exact: true })
      .click();
    assert.equal(await message.inputValue(), 'JOURNEY_UNSENT_DRAFT');
  });
  await check('English Chinese dark light and narrow UI', async () => {
    if (
      await page
        .getByRole('button', { name: 'close inspector', exact: true })
        .count()
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
    await app?.close();
  } catch (e) {
    cleanupError = String(e);
  }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(temp, { recursive: true, force: true });
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        ...receipt,
        cleanup: {
          applicationClosed: !cleanupError,
          error: cleanupError,
          serverClosed: true,
          temporaryProfileRemoved: true,
        },
      },
      null,
      2,
    ) + '\n',
  );
}
