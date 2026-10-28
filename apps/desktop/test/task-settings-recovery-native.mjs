// Run serially with the native desktop lease; node --import tsx test/task-settings-recovery-native.mjs.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { TaskService } from '../src/workspace/task-service.ts';
import { readModelRequests } from './helpers/model-requests.mjs';
import { setViewport } from './helpers/viewport.mjs';
import { patience } from './helpers/patience.mjs';
const require = createRequire(import.meta.url);
const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = await realpath(
  await mkdtemp(join(tmpdir(), 'circle-task-settings-native-')),
);
const output = process.env.CIRCLE_TASK_SETTINGS_EVIDENCE
  ? resolve(process.env.CIRCLE_TASK_SETTINGS_EVIDENCE)
  : join(temp, 'evidence');
const home = join(temp, 'home'),
  data = join(temp, 'data'),
  repo = join(temp, 'project');
await Promise.all([
  mkdir(home),
  mkdir(repo),
  mkdir(join(data, 'runtime-home'), { recursive: true }),
  mkdir(output, { recursive: true }),
]);
const git = (...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git('init', '-b', 'main');
await writeFile(join(repo, 'source.txt'), 'retained project\n');
git('add', 'source.txt');
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-m',
  'Seed isolated project',
);
const settings = trustFolder(defaultSettings(), repo);
settings.workspace_folder = repo;
saveSettings(settings, join(data, 'runtime-home'));
const requestsPath = join(temp, 'requests.jsonl'),
  fixturePath = join(temp, 'model.json');
await writeFile(
  fixturePath,
  JSON.stringify({
    requestsPath,
    replies: [
      {
        message: {
          id: 'history',
          role: 'assistant',
          content: 'COLD_CONFIG_HISTORY_REMAINS_READABLE',
        },
      },
      {
        message: {
          id: 'explicit',
          role: 'assistant',
          content: 'EXPLICIT_START_ONLY',
        },
      },
    ],
  }),
);
const env = {
  ...process.env,
  HOME: home,
  ...(process.platform === 'win32'
    ? { USERPROFILE: home }
    : { ZDOTDIR: home, ENV: '/dev/null', HISTFILE: '/dev/null' }),
  CIRCLE_HOME: home,
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en',
  CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
let app, page, sessionId;
const receipt = {
  status: 'running',
  temp,
  settingsPath: join(data, 'workspace-services', 'task-settings.json'),
  checks: [],
  rendererErrors: [],
};
const until = async (predicate, label) => {
  const deadline = Date.now() + patience(15000);
  while (!(await predicate())) {
    assert(Date.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 25));
  }
};
const requests = () =>
  readModelRequests(requestsPath, { requireComplete: true });
const state = () =>
  page.evaluate(
    async () => (await window.circleDesktop.runtimeState()).snapshot,
  );
const call = (method, params = {}) =>
  page.evaluate(
    async ({ sessionId, method, params }) => {
      const reply = await window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        name: 'workspace-service',
        sessionId,
        payload: { service: 'tasks', method, params },
      });
      if (!reply.ok) throw Error(reply.error);
      return reply.data;
    },
    { sessionId, method, params },
  );
const launch = async () => {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? appRoot)],
    cwd: appRoot,
    env,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(patience(15000));
  page.on('pageerror', (error) => receipt.rendererErrors.push(String(error)));
  await setViewport(app, page, { width: 1400, height: 900 });
  const actual = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(actual.packaged, !!process.env.CIRCLE_DESKTOP_EXECUTABLE);
  receipt.identity = actual;
};
const openHistory = async () => {
  // Settings are a dialog over the window, and a history row is in the window: close
  // the dialog first, as a person does.
  const dialog = page.locator('.settings-dialog');
  if (await dialog.count()) {
    await page.waitForFunction(() =>
      document.activeElement?.closest('.settings-dialog'),
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }
  const historyLink = page.locator(
    `.sidebar:visible .session-link[href="#/session/${sessionId}"][tabindex="0"]`,
  );
  await historyLink.waitFor({ state: 'visible' });
  assert.equal(
    await historyLink.count(),
    1,
    'open the unique keyboard-primary original history row',
  );
  await historyLink.click();
  await page
    .getByText('COLD_CONFIG_HISTORY_REMAINS_READABLE', { exact: true })
    .waitFor();
};
// The task limits are kept in the workspace group of settings, with the start of the
// tasks a repaired limit left waiting. The tasks panel that also said so went with the
// manual task controls.
const openTaskLimits = async () => {
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page
    .locator('.settings-index-list')
    .getByRole('button', { name: 'workspace', exact: true })
    .click();
  const section = page.getByRole('region', {
    name: 'parallel tasks',
    exact: true,
  });
  await section.waitFor();
  return section;
};
try {
  await launch();
  await page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('Seed readable history');
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await page
    .getByText('COLD_CONFIG_HISTORY_REMAINS_READABLE', { exact: true })
    .waitFor();
  sessionId = (await state()).activeSessionId;
  await until(
    async () =>
      (await state()).sessions.find((s) => s.id === sessionId)?.state ===
      'idle',
    'seed history idle',
  );
  assert.equal((await requests()).length, 1);
  await app.close();
  app = undefined;
  const service = new TaskService({
    workspace: repo,
    dataDir: join(
      data,
      'collaboration',
      createHash('sha256').update(repo).digest('hex').slice(0, 24),
    ),
    settingsPath: receipt.settingsPath,
    autoStart: false,
    emit() {},
    createRuntime() {
      throw Error('seeding queued work must never initialize a model');
    },
  });
  try {
    await service.call(sessionId, 'enqueue', {
      operationId: 'cold-settings-seed',
      tasks: [
        {
          id: 'cold-settings-queued',
          prompt: 'Answer EXPLICIT_START_ONLY',
          access: 'readonly',
          acceptanceCriteria: ['independent inspection'],
          dependencies: [],
          resource: 'agent',
        },
      ],
    });
  } finally {
    await service.close();
  }
  await mkdir(join(data, 'workspace-services'), { recursive: true });
  await writeFile(receipt.settingsPath, '{malformed native fixture');
  await launch();
  await openHistory();
  const limitsSection = await openTaskLimits();
  await limitsSection
    .getByText('the saved limit could not be read; save a value to fix it', {
      exact: false,
    })
    .waitFor();
  const bad = await call('settings');
  assert.equal(typeof bad.error, 'string');
  assert.ok(bad.error.length > 0);
  assert.deepEqual(
    [bad.agents, bad.builds, bad.ui, bad.browsers],
    [1, 1, 1, 1],
  );
  await assert.rejects(call('list'), /could not load task settings/);
  // Read the pre-existing ledger without creating a scheduler or writing/migrating it.
  const ledger = new DatabaseSync(
    join(
      data,
      'collaboration',
      createHash('sha256').update(repo).digest('hex').slice(0, 24),
      'collaboration.sqlite',
    ),
    { readOnly: true },
  );
  try {
    const row = ledger
      .prepare('SELECT record FROM tasks WHERE id=?')
      .get('cold-settings-queued');
    assert.ok(row, 'cold startup retains the queued task record');
    assert.equal(JSON.parse(String(row.record)).state, 'queued');
  } finally {
    ledger.close();
  }
  assert.equal((await requests()).length, 1);
  await page.screenshot({
    path: join(output, 'cold-start-history-and-config-error.png'),
  });
  receipt.checks.push(
    'malformed configuration preserves original window and stored history; queued task does not run',
  );
  // The settings page repairs the limit where it is kept.
  await limitsSection.getByLabel('agents at once').fill('2');
  await limitsSection
    .getByRole('button', { name: 'save', exact: true })
    .click();
  await limitsSection.getByText('saved', { exact: true }).waitFor();
  assert.equal(
    await limitsSection
      .getByText('the saved limit could not be read', { exact: false })
      .count(),
    0,
  );
  await openHistory();
  const repaired = await call('settings');
  assert.equal(repaired.error, undefined);
  assert.equal(repaired.agents, 2);
  assert.equal(repaired.requiresStart, true);
  assert.equal(
    (await call('list')).find((t) => t.spec.id === 'cold-settings-queued')
      .state,
    'queued',
  );
  assert.equal((await requests()).length, 1);
  assert.equal(
    JSON.parse(await readFile(receipt.settingsPath, 'utf8')).agents,
    2,
  );
  await page.screenshot({
    path: join(output, 'limits-repaired-explicit-start-required.png'),
  });
  await app.close();
  app = undefined;
  await launch();
  await openHistory();
  assert.equal((await call('settings')).requiresStart, true);
  assert.equal(
    (await call('list')).find((t) => t.spec.id === 'cold-settings-queued')
      .state,
    'queued',
  );
  assert.equal(
    (await requests()).length,
    1,
    'repair and restart must not auto-request a model',
  );
  receipt.checks.push(
    'repair gate and queued task survive full application restart with exactly zero additional model requests',
  );
  await page.screenshot({
    path: join(output, 'restarted-still-explicit-start-required.png'),
  });
  // The settings page offers to start the queued tasks, and that start is the only thing
  // that lets them run: the next real scripted model request follows that press alone.
  const restartedSection = await openTaskLimits();
  await restartedSection
    .getByRole('button', { name: 'start queued tasks', exact: true })
    .waitFor();
  assert.equal((await requests()).length, 1);
  await restartedSection
    .getByRole('button', { name: 'start queued tasks', exact: true })
    .click();
  await until(
    async () => (await requests()).length >= 2,
    'the settings page start runs the queued model request',
  );
  await restartedSection
    .getByRole('button', { name: 'start queued tasks', exact: true })
    .waitFor({ state: 'detached' });
  receipt.checks.push(
    'only the explicit start on the settings page causes the next real scripted model request',
  );
  assert.deepEqual(receipt.rendererErrors, []);
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.error = String(error);
  receipt.stack = error.stack;
  if (page) {
    receipt.snapshot = await state().catch(String);
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
  }
  throw error;
} finally {
  try {
    if (app) await app.close();
  } finally {
    await writeFile(
      join(output, 'task-settings-native-receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n',
    );
    console.log('task settings native evidence: ' + output);
  }
}
