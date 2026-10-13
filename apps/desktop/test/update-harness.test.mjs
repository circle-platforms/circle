import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Execute the real harness's Windows preflight in a child Node process. Native commands
// and Playwright are intercepted before the harness imports them; no installer, watcher or app runs.
const watchHelper = fileURLToPath(
  new URL('./helpers/watch.mjs', import.meta.url),
);
const hooks = `
import { registerHooks } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'win32' });
process.env.ProgramFiles = process.env.CIRCLE_UPDATE_PROGRAM_FILES;
const commands = ${JSON.stringify(String.raw`
  import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  const installed = join(process.env.CIRCLE_UPDATE_PROGRAM_FILES, 'Circle');
  const record = (method, command, args) => appendFileSync(
    process.env.CIRCLE_UPDATE_ACTIONS, JSON.stringify({ method, command, args }) + '\n');
  export function spawn(command, args) {
    record('spawn', command, args);
    if (command === process.execPath && args[0] === process.env.CIRCLE_UPDATE_WATCH_HELPER) {
      return {
        unref() { record('unref', command, args); },
        kill() { record('kill', command, args); return true; },
      };
    }
    throw Error('unexpected application launch');
  }
  export function execFileSync(command, args) {
    record('execFileSync', command, args);
    return '';
  }
  export function spawnSync(command, args) {
    record('spawnSync', command, args);
    if (command === 'msiexec.exe' && args[0] === '/i') {
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(installed, 'partial-install'), 'created by the test installer');
      return { status: 1603 };
    }
    if (command === 'msiexec.exe' && args[0] === '/x') {
      if (!existsSync(args[1])) return { status: 1619 };
      rmSync(installed, { recursive: true, force: true });
    }
    return { status: 0 };
  }
`)};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'playwright' || specifier === 'node:child_process') {
      const source = specifier === 'playwright' ? 'export const chromium = {};' : commands;
      return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
`;

function preflight(t, existing) {
  const root = mkdtempSync(join(tmpdir(), 'circle-update-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const programFiles = join(root, 'Program Files');
  const installed = join(programFiles, 'Circle');
  mkdirSync(programFiles, { recursive: true });
  if (existing) {
    mkdirSync(installed);
    writeFileSync(
      join(installed, 'existing-install'),
      'leave this installation alone',
    );
  }
  const msi = join(root, 'fixture.msi');
  writeFileSync(
    msi,
    'a synthetic installer; never passed to Windows Installer',
  );
  const actions = join(root, 'actions.jsonl');
  const preload = join(root, 'hooks.mjs');
  writeFileSync(preload, hooks);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(preload).href,
      fileURLToPath(new URL('./update.mjs', import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        CIRCLE_UPDATE_PROGRAM_FILES: programFiles,
        CIRCLE_DESKTOP_APP_PATH: join(root, 'package'),
        CIRCLE_DESKTOP_EXECUTABLE: join(root, 'package', 'Circle.exe'),
        CIRCLE_DESKTOP_UPDATE_MSI: msi,
        CIRCLE_DESKTOP_TEST_TEMP: root,
        CIRCLE_UPDATE_ACTIONS: actions,
        CIRCLE_UPDATE_WATCH_HELPER: watchHelper,
        CIRCLE_HOME: join(root, 'home'),
        CIRCLE_WORKBENCH_DATA_DIR: join(root, 'data'),
      },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  const recorded = existsSync(actions)
    ? readFileSync(actions, 'utf8').trim().split('\n').map(JSON.parse)
    : [];
  const watchArgs = [
    watchHelper,
    String(result.pid),
    recorded[0]?.args[2],
    '12',
  ];
  assert.equal(dirname(watchArgs[2]), root);
  assert.ok(basename(watchArgs[2]).startsWith('circle-desktop-update-'));
  assert.deepEqual(
    recorded.filter((action) =>
      ['spawn', 'unref', 'kill'].includes(action.method),
    ),
    ['spawn', 'unref', 'kill'].map((method) => ({
      method,
      command: process.execPath,
      args: watchArgs,
    })),
  );
  return {
    installed,
    msi,
    result,
    watchArgs,
    actions: recorded,
  };
}

test('update preflight leaves an existing installation and its processes alone', (t) => {
  const { installed, result, actions, watchArgs } = preflight(t, true);
  assert.match(result.stderr, /exists already/);
  assert.ok(result.stderr.includes(installed));
  assert.equal(
    readFileSync(join(installed, 'existing-install'), 'utf8'),
    'leave this installation alone',
  );
  assert.deepEqual(actions, [
    { method: 'spawn', command: process.execPath, args: watchArgs },
    { method: 'unref', command: process.execPath, args: watchArgs },
    { method: 'execFileSync', command: 'tasklist', args: [] },
    { method: 'kill', command: process.execPath, args: watchArgs },
  ]);
});

test('update cleanup removes its own partially attempted installation', (t) => {
  const { installed, msi, result, actions, watchArgs } = preflight(t, false);
  assert.match(result.stderr, /msiexec .* exited with 1603/);
  assert.equal(existsSync(installed), false);
  assert.deepEqual(
    actions.map((action) => [action.method, action.command]),
    [
      ['spawn', process.execPath],
      ['unref', process.execPath],
      ['spawnSync', 'msiexec.exe'],
      ['execFileSync', 'tasklist'],
      ['kill', process.execPath],
      ['spawnSync', 'powershell.exe'],
      ['spawnSync', 'msiexec.exe'],
      ['spawnSync', 'msiexec.exe'],
    ],
  );
  assert.deepEqual(actions[2].args, [
    '/i',
    msi,
    '/qn',
    '/norestart',
    '/l*v',
    join(watchArgs[2], 'msi-install.log'),
  ]);
  const stop = actions.find((action) => action.command === 'powershell.exe');
  assert.ok(stop);
  assert.deepEqual(stop.args.slice(0, -1), ['-NoProfile', '-Command']);
  assert.ok(stop.args.at(-1).startsWith(`$inside = '${installed}\\'; `));
  assert.ok(
    stop.args
      .at(-1)
      .includes(
        'Where-Object { $_.Path -and $_.Path.StartsWith($inside, [StringComparison]::OrdinalIgnoreCase) }',
      ),
  );
  const removed = actions.filter(
    (action) => action.command === 'msiexec.exe' && action.args[0] === '/x',
  );
  assert.equal(removed.length, 2);
  assert.equal(dirname(removed[0].args[1]), join(watchArgs[2], 'release'));
  assert.match(
    basename(removed[0].args[1]),
    /^circle-desktop-\d+\.\d+\.\d+-windows-x64\.msi$/,
  );
  assert.deepEqual(removed[0].args.slice(2), ['/qn', '/norestart']);
  assert.deepEqual(removed.at(-1).args, ['/x', msi, '/qn', '/norestart']);
});
