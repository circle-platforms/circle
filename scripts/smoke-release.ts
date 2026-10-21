import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  ARCHIVE_ROOT,
  assetName,
  fileInventory,
  targetFor,
  validateRelease,
  activeVersion,
  type ReleaseManifest,
} from '../src/install_layout.js';
import { VERSION } from '../src/version.js';
import { TITLE_MAX_TOKENS } from '../src/session_title.js';
import { listenReleaseGateway } from './release-gateway.js';
import { parseFrontmatter } from '../src/skills.js';
import {
  defaultSettings,
  saveSettings,
  saveCredentials,
  trustFolder,
} from '../src/settings.js';
const output = resolve(process.argv[2] || '.tmp/release');
const target = targetFor();
const windows = process.platform === 'win32';
const asset = assetName(VERSION, target);
const archive = join(output, asset);
const bytes = readFileSync(archive);
assert.equal(
  readFileSync(archive + '.sha256', 'utf8').split(/\s+/)[0],
  createHash('sha256').update(bytes).digest('hex'),
);
const temporary = mkdtempSync(join(tmpdir(), 'circle-dist-smoke-'));
// The installer writes to the default location under HOME and to the shell startup files there.
// Give it a home of its own and a PATH without any circle, so a developer's real installation is
// never seen or changed.
const fakeHome = join(temporary, 'home');
const fakeAppData = join(fakeHome, 'AppData', 'Local');
mkdirSync(fakeAppData, { recursive: true });
const pathValue = Object.entries(process.env)
  .filter(([key]) => key.toUpperCase() === 'PATH')
  .map(([, value]) => value || '')
  .join(delimiter)
  .split(delimiter)
  .filter(
    (folder) =>
      folder &&
      !['circle', 'circle.exe', 'circle.cmd'].some((name) =>
        existsSync(join(folder, name)),
      ),
  )
  .join(delimiter);
const isolated: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      key.toUpperCase() !== 'PATH' &&
      !['CIRCLE_PREFIX', 'CIRCLE_BIN_DIR', 'CIRCLE_REPO'].includes(key),
  ),
);
Object.assign(isolated, {
  PATH: pathValue,
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  LOCALAPPDATA: fakeAppData,
});
let server: ReturnType<typeof createServer> | undefined;
let primarySmokeError: unknown;
function sync(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const batch = windows && command.endsWith('.cmd');
  const actualCommand = batch ? 'cmd.exe' : command;
  const actualArgs = batch
    ? [
        '/d',
        '/s',
        '/c',
        `""${command}" ${args.map((arg) => `"${arg}"`).join(' ')}"`,
      ]
    : args;
  const result = spawnSync(actualCommand, actualArgs, {
    encoding: 'utf8',
    env,
    windowsVerbatimArguments: batch,
    timeout: 120_000,
    maxBuffer: 16_000_000,
  });
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stderr || result.stdout,
  );
  return result.stdout;
}
function extract(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  if (windows) {
    const script = join(temporary, 'extract.ps1');
    writeFileSync(
      script,
      'param([string]$Source,[string]$Destination)\n$ErrorActionPreference="Stop"\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::ExtractToDirectory($Source,$Destination)\n',
    );
    sync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      source,
      destination,
    ]);
  } else sync('tar', ['-xzf', source, '-C', destination]);
}
try {
  const relocated = join(temporary, 'relocated package');
  extract(archive, relocated);
  const root = join(relocated, ARCHIVE_ROOT);
  validateRelease(root);
  const node = join(root, 'runtime', windows ? 'node.exe' : 'node');
  const cli = join(root, 'app/dist/cli.js');
  assert.equal(sync(node, [cli, '--version']).trim(), VERSION);
  const home = join(temporary, 'data');
  const workspace = join(temporary, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  // The skill that ships with Circle, as the relocated release has it: the model must see it.
  const builtinSkill = parseFrontmatter(
    readFileSync(
      join(root, 'app/dist/builtin_skills/create-pr/SKILL.md'),
      'utf8',
    ),
  ).meta;
  assert.equal(builtinSkill.name, 'create-pr');
  let firstSystem = '';
  let calls = 0;
  let titles = 0;
  server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as {
      messages: { role?: string; content?: unknown }[];
      max_tokens?: number;
    };
    // The prompt is long enough for a session title, asked after the turn. It
    // is not one of the turn's two calls.
    if (payload.max_tokens === TITLE_MAX_TOKENS) {
      titles++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        'data: ' +
          JSON.stringify({
            id: 'smoke-title',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'Release receipt' },
                finish_reason: 'stop',
              },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
      return;
    }
    calls++;
    if (calls === 1)
      firstSystem = String(
        payload.messages.find((message) => message.role === 'system')
          ?.content ?? '',
      );
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta =
      calls === 1
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'write',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    file_path: 'receipt.txt',
                    content: 'release smoke',
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'release verified' };
    if (calls === 2)
      assert.match(JSON.stringify(payload.messages), /Wrote.*receipt.txt/);
    response.write(
      'data: ' +
        JSON.stringify({
          id: 'smoke',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: null }],
        }) +
        '\n\n',
    );
    response.write(
      'data: ' +
        JSON.stringify({
          id: 'smoke',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: calls === 1 ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
    response.end();
  });
  const gatewayPort = await listenReleaseGateway(server);
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth = {
    ...settings.auth,
    protocol: 'openai',
    model: 'smoke',
    base_url: `http://127.0.0.1:${gatewayPort}/v1`,
  };
  saveSettings(trustFolder(settings, workspace), home);
  saveCredentials({ api_key: 'fake-release-smoke-key' }, home);
  const env = {
    ...isolated,
    CIRCLE_HOME: home,
    CIRCLE_NO_MODELS_REFRESH: '1',
  };
  const answer = await new Promise<string>((resolveResult, reject) => {
    const child = spawn(
      node,
      [cli, '-p', '--yolo', 'write a receipt', workspace],
      { env },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveResult(stdout) : reject(new Error(stderr)),
    );
  });
  assert.match(answer, /release verified/);
  assert.equal(calls, 2);
  assert.ok(titles <= 1, `${titles} title requests`);
  assert.ok(
    firstSystem.includes(`\n- create-pr: ${builtinSkill.description}`),
    'the built-in create-pr skill is listed in the system prompt',
  );
  assert.equal(
    readFileSync(join(workspace, 'receipt.txt'), 'utf8'),
    'release smoke',
  );
  const preserved = ['settings.json', 'credentials.json', 'circle.sqlite'].map(
    (name) => ({
      path: join(home, name),
      bytes: readFileSync(join(home, name)),
    }),
  );
  const prefix = join(temporary, 'install space');
  const bin = join(temporary, 'bin space');
  const installEnv = {
    ...env,
    CIRCLE_VERSION: VERSION,
    CIRCLE_ASSET_DIR: output,
    CIRCLE_PREFIX: prefix,
    CIRCLE_BIN_DIR: bin,
    CIRCLE_NO_PATH: '1',
  };
  const steps = sync(
    windows ? 'powershell.exe' : 'bash',
    windows
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolve('install.ps1'),
        ]
      : [resolve('install.sh')],
    installEnv,
  );
  // The installer says each step as it takes it.
  assert.deepEqual(
    steps.match(/^\[circle-install\] \S+/gm)?.slice(0, 5),
    ['verifying', 'unpacking', 'checking', 'copying', 'installed'].map(
      (step) => `[circle-install] ${step}`,
    ),
    steps,
  );
  const launcher = join(bin, windows ? 'circle.cmd' : 'circle');
  assert.equal(sync(launcher, ['--version'], env).trim(), VERSION);
  assert.equal(activeVersion(prefix), VERSION);
  const second = join(temporary, 'second');
  cpSync(root, second, { recursive: true });
  const upgraded = VERSION.replace(
    /^(\d+)\.(\d+)\.(\d+)/,
    (_, major, minor, patch) => `${major}.${minor}.${Number(patch) + 1}`,
  );
  const packageJson = JSON.parse(
    readFileSync(join(second, 'app/package.json'), 'utf8'),
  );
  packageJson.version = upgraded;
  writeFileSync(join(second, 'app/package.json'), JSON.stringify(packageJson));
  writeFileSync(
    join(second, 'app/dist/version.js'),
    readFileSync(join(second, 'app/dist/version.js'), 'utf8').replace(
      `'${VERSION}'`,
      `'${upgraded}'`,
    ),
  );
  const manifest = JSON.parse(
    readFileSync(join(second, 'release.json'), 'utf8'),
  ) as ReleaseManifest;
  manifest.version = upgraded;
  manifest.files = fileInventory(second);
  writeFileSync(join(second, 'release.json'), JSON.stringify(manifest));
  sync(
    join(second, 'runtime', windows ? 'node.exe' : 'node'),
    [join(second, 'app/dist/install_manager.js'), second, prefix, bin],
    env,
  );
  assert.equal(sync(launcher, ['--version'], env).trim(), upgraded);
  const corrupt = join(temporary, 'corrupt');
  mkdirSync(corrupt);
  cpSync(archive, join(corrupt, asset));
  writeFileSync(
    join(corrupt, asset + '.sha256'),
    '0'.repeat(64) + '  ' + asset + '\n',
  );
  const rejected = spawnSync(
    windows ? 'powershell.exe' : 'bash',
    windows
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolve('install.ps1'),
        ]
      : [resolve('install.sh')],
    { env: { ...installEnv, CIRCLE_ASSET_DIR: corrupt }, encoding: 'utf8' },
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(activeVersion(prefix), upgraded);
  for (const row of preserved)
    assert.deepEqual(readFileSync(row.path), row.bytes);
  // With no location given, the installer uses the default one under the home folder.
  const defaultPrefix = windows
    ? join(fakeAppData, 'circle')
    : join(fakeHome, '.local', 'share', 'circle');
  const defaultBin = windows
    ? join(defaultPrefix, 'bin')
    : join(fakeHome, '.local', 'bin');
  sync(
    windows ? 'powershell.exe' : 'bash',
    windows
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolve('install.ps1'),
        ]
      : [resolve('install.sh')],
    {
      ...env,
      CIRCLE_VERSION: VERSION,
      CIRCLE_ASSET_DIR: output,
      CIRCLE_NO_PATH: '1',
    },
  );
  assert.equal(activeVersion(defaultPrefix), VERSION);
  assert.equal(
    sync(
      join(defaultBin, windows ? 'circle.cmd' : 'circle'),
      ['--version'],
      env,
    ).trim(),
    VERSION,
  );
  for (const row of preserved)
    assert.deepEqual(readFileSync(row.path), row.bytes);
  process.stdout.write(
    JSON.stringify({
      target,
      version: VERSION,
      relocated: true,
      installed: true,
      upgraded: true,
      checksumRejected: true,
      dataPreserved: true,
      defaultLocation: true,
      modelRequests: calls,
      builtinSkill: builtinSkill.name,
      sideEffect: 'receipt.txt',
    }) + '\n',
  );
} catch (error) {
  primarySmokeError = error;
  console.error(error);
  throw error;
} finally {
  const cleanupErrors: unknown[] = [];
  try {
    if (server)
      await new Promise<void>((resolveClosed) =>
        server!.close(() => resolveClosed()),
      );
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length) {
    for (const error of cleanupErrors) console.error(error);
    if (primarySmokeError === undefined)
      throw new AggregateError(cleanupErrors, 'release smoke cleanup failed');
  }
}
