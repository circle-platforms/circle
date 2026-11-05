import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { waitDesktopReady } from './helpers/desktop-readiness.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root);
const executable = process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron');
const temp = await mkdtemp(join(tmpdir(), 'circle-instance-native-'));
const apps = [];
const children = [];
let passed = false;
const env = (data) => ({
  ...process.env,
  CIRCLE_HOME: join(temp, 'cli-home'),
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
  CIRCLE_WORKBENCH_LANGUAGE: 'en',
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: join(temp, 'model.json'),
});
await writeFile(
  join(temp, 'model.json'),
  JSON.stringify({
    requestsPath: join(temp, 'requests.jsonl'),
    replies: [
      {
        chunks: [
          { waitForFile: join(temp, 'release-turn') },
          'isolated instance answer',
        ],
      },
    ],
  }),
);

async function launch(data) {
  await mkdir(join(data, 'runtime-home'), { recursive: true });
  await writeFile(
    join(data, 'runtime-home/settings.json'),
    JSON.stringify({
      base_url: 'http://127.0.0.1:1',
      api_key: 'synthetic',
      model: 'fixture',
      protocol: 'openai',
      onboarding_complete: true,
    }),
  );
  const app = await electron.launch({
    executablePath: executable,
    args: [directory],
    cwd: root,
    chromiumSandbox: true,
    env: env(data),
    timeout: 90000,
  });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForFunction(async () => {
    if (!window.circleDesktop) return false;
    return (await window.circleDesktop.runtimeState()).connected;
  });
  return { app, page };
}

async function duplicate(
  data,
  args = [],
  program = executable,
  entry = directory,
  expected = 0,
  extraEnv = {},
) {
  const child = spawn(program, [entry, ...args], {
    cwd: root,
    env: { ...env(data), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(
    () => child.kill(),
    expected === 0 ? 30000 : 60000,
  );
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, stderr);
    assert.equal(code, expected, stderr);
  } finally {
    clearTimeout(timeout);
  }
}

try {
  const data = join(temp, 'data');
  const first = await launch(data);
  const state = await first.page.evaluate(() =>
    window.circleDesktop.runtimeState(),
  );
  const pid = state.snapshot.runtime.processId;
  await first.app.evaluate(({ app }) => {
    globalThis.instanceEvents = 0;
    app.on('second-instance', () => globalThis.instanceEvents++);
  });
  await first.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].hide(),
  );
  await duplicate(data);
  await waitDesktopReady(
    () =>
      first.app.evaluate(({ BrowserWindow }) => ({
        events: globalThis.instanceEvents,
        visible: BrowserWindow.getAllWindows().some((w) => w.isVisible()),
      })),
    (sample) => sample.events === 1 && sample.visible,
  );
  assert.equal(
    (await first.page.evaluate(() => window.circleDesktop.runtimeState()))
      .snapshot.runtime.processId,
    pid,
  );
  const alias = join(temp, 'alias');
  await symlink(data, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await duplicate(alias);
  await duplicate(data, ['--instance-untrusted-argument=ignored']);
  assert.equal(await first.app.evaluate(() => globalThis.instanceEvents), 3);

  await first.app.evaluate(({ dialog }) => {
    globalThis.instanceNotices = [];
    dialog.showMessageBox = async (options) => {
      globalThis.instanceNotices.push(options);
      return { response: 0, checkboxChecked: false };
    };
  });
  const otherBuild = join(temp, 'another-build');
  await mkdir(otherBuild);
  await writeFile(
    join(otherBuild, 'package.json'),
    JSON.stringify({
      name: 'circle-instance-fixture',
      version: '1.0.0',
      main: 'main.cjs',
    }),
  );
  await writeFile(
    join(otherBuild, 'main.cjs'),
    `require(${JSON.stringify(join(directory, 'dist/main.cjs'))});`,
  );
  await duplicate(data, [], require('electron'), otherBuild);
  await waitDesktopReady(
    () => first.app.evaluate(() => globalThis.instanceNotices),
    (sample) => sample.length === 1,
  );
  assert.equal(
    await first.app.evaluate(() => globalThis.instanceNotices[0].message),
    'Circle is already running from another build',
  );

  const second = await launch(join(temp, 'separate'));
  assert.notEqual(
    (await second.page.evaluate(() => window.circleDesktop.runtimeState()))
      .snapshot.runtime.processId,
    pid,
  );
  assert.equal(first.app.process().exitCode, null);
  assert.equal(
    (await first.page.evaluate(() => window.circleDesktop.runtimeState()))
      .snapshot.sessions.length,
    state.snapshot.sessions.length,
  );

  await first.page
    .getByRole('textbox', { name: 'message', exact: true })
    .fill('keep this turn running');
  await first.page
    .getByRole('button', { name: 'send message', exact: true })
    .click();
  await waitDesktopReady(
    () => readFile(join(temp, 'requests.jsonl'), 'utf8').catch(() => ''),
    (sample) => sample.includes('keep this turn running'),
  );
  const requestsBefore = await readFile(join(temp, 'requests.jsonl'), 'utf8');
  await duplicate(data);
  assert.equal(
    await readFile(join(temp, 'requests.jsonl'), 'utf8'),
    requestsBefore,
  );
  assert.equal(
    (await first.page.evaluate(() => window.circleDesktop.runtimeState()))
      .snapshot.runtime.processId,
    pid,
  );
  await writeFile(join(temp, 'release-turn'), 'release');
  await first.page
    .getByText('isolated instance answer', { exact: true })
    .waitFor();

  if (process.platform === 'darwin') {
    await first.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await duplicate(data);
    const restored = await first.app.firstWindow();
    await restored.waitForFunction(
      async () => (await window.circleDesktop?.runtimeState())?.connected,
    );
    assert.equal(
      (await restored.evaluate(() => window.circleDesktop.runtimeState()))
        .snapshot.runtime.processId,
      pid,
    );
  }
  await first.app.close();
  apps.splice(apps.indexOf(first.app), 1);
  const replacement = await launch(data);
  assert.notEqual(
    (await replacement.page.evaluate(() => window.circleDesktop.runtimeState()))
      .snapshot.runtime.processId,
    pid,
  );
  const legacyBuild = join(temp, 'legacy-writer-build');
  await mkdir(legacyBuild);
  await writeFile(
    join(legacyBuild, 'package.json'),
    JSON.stringify({
      name: 'circle-occupancy-fixture',
      version: '1.0.0',
      main: 'main.cjs',
    }),
  );
  const noticePath = join(temp, 'legacy-notice.json');
  await writeFile(
    join(legacyBuild, 'main.cjs'),
    `
    require('electron').dialog.showMessageBox = async (options) => {
      require('node:fs').writeFileSync(${JSON.stringify(noticePath)}, JSON.stringify(options));
      return { response: 0, checkboxChecked: false };
    };
    require(${JSON.stringify(join(directory, 'dist/main.cjs'))});
  `,
  );
  const legacyData = join(temp, 'legacy-data');
  await mkdir(join(legacyData, 'runtime-home'), { recursive: true });
  const owner = new DatabaseSync(
    join(legacyData, 'runtime-home/circle.sqlite'),
  );
  try {
    owner.exec('BEGIN EXCLUSIVE');
    await duplicate(legacyData, [], require('electron'), legacyBuild, 1, {
      CIRCLE_WORKBENCH_LANGUAGE: 'zh-CN',
    });
    const notice = JSON.parse(await readFile(noticePath, 'utf8'));
    assert.equal(notice.message, 'Circle 数据正在使用中');
    assert.match(notice.detail, /请正常退出/);
    assert.ok(notice.detail.includes(await realpath(legacyData)));
  } finally {
    owner.exec('ROLLBACK');
    owner.close();
  }
  console.log(
    'instance native passed: duplicate exits, restoration, aliases, cross-build notice, uninterrupted turn, independent data, restart and occupied-data notice',
  );
  passed = true;
} finally {
  for (const app of apps.reverse()) await app.close().catch(() => {});
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill();
  if (passed) await rm(temp, { recursive: true, force: true, maxRetries: 5 });
  else console.error(`instance evidence kept at ${temp}`);
}
