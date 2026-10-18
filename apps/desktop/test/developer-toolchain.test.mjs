import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { resetDesktopOutput } from '../scripts/build-output.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureNativeDependencyPermissions,
  prepareCommandSupervisor,
  verifyCommandSupervisor,
  prepareNativeDependencies,
  prepareDeveloperTools,
  downloadArchive,
  toolCacheMismatch,
  verifyArchive,
} from '../scripts/developer-toolchain.mjs';

test('developer tools reject tampered bytes before extraction or execution', async (t) => {
  const bytes = Buffer.from('fixture');
  assert.equal(
    verifyArchive(bytes, createHash('sha256').update(bytes).digest('hex'))
      .length,
    64,
  );
  assert.throws(
    () => verifyArchive(bytes, '0'.repeat(64)),
    /checksum mismatch/,
  );
  const dist = await mkdtemp(join(tmpdir(), 'circle-tool-reject-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await assert.rejects(
    prepareDeveloperTools(dist, {
      platform: 'darwin',
      arch: 'arm64',
      fetchArchive: async () => bytes,
    }),
    /checksum mismatch/,
  );
  await assert.rejects(stat(join(dist, 'tools/gh')), { code: 'ENOENT' });
});

test('a dropped connection or a busy server is tried again, waiting longer each time; a missing file is not', async () => {
  const bytes = Buffer.from('archive');
  // As a runner that cannot reach github.com for a while sees it
  const timeout = () =>
    Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
  const answers = [
    () => {
      throw timeout();
    },
    () => new Response(null, { status: 429 }),
    () => new Response(null, { status: 503 }),
    () => new Response(bytes),
  ];
  let calls = 0;
  const pauses = [];
  const lines = [];
  const quiet = {
    pause: async (ms) => pauses.push(ms),
    log: (line) => lines.push(line),
  };
  assert.deepEqual(
    await downloadArchive('https://tools.test/a.tar.gz', {
      ...quiet,
      request: async () => answers[calls++](),
    }),
    bytes,
  );
  assert.equal(calls, 4);
  assert.deepEqual(pauses, [2000, 4000, 8000]);
  assert.equal(
    lines[0],
    'https://tools.test/a.tar.gz: fetch failed (UND_ERR_CONNECT_TIMEOUT); trying again in 2 s, attempt 2 of 6',
  );
  assert.match(lines[2], /503 .*trying again in 8 s, attempt 4 of 6/);

  calls = 0;
  pauses.length = 0;
  await assert.rejects(
    downloadArchive('https://tools.test/missing.tar.gz', {
      ...quiet,
      request: async () => {
        calls++;
        return new Response(null, { status: 404 });
      },
    }),
    /developer tool download failed: 404 https:\/\/tools\.test\/missing\.tar\.gz/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(pauses, []);

  // Six attempts, a minute of pauses in all, before a download that never connects fails
  calls = 0;
  pauses.length = 0;
  await assert.rejects(
    downloadArchive('https://tools.test/down.tar.gz', {
      ...quiet,
      request: async () => {
        calls++;
        throw timeout();
      },
    }),
    /fetch failed/,
  );
  assert.equal(calls, 6);
  assert.deepEqual(pauses, [2000, 4000, 8000, 16000, 32000]);
});

test('a tool is reused only while its folder holds exactly what its receipt lists, and says why not', async (t) => {
  const tool = await mkdtemp(join(tmpdir(), 'circle-tool-cache-'));
  t.after(() => rm(tool, { recursive: true, force: true }));
  const entry = join('bin', 'gh');
  await mkdir(join(tool, 'bin'), { recursive: true });
  await writeFile(join(tool, entry), 'gh binary');
  await writeFile(join(tool, 'LICENSE'), 'license');
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  const expected = {
    version: '2.0.0',
    sha256: 'a'.repeat(64),
    target: 'darwin-arm64',
    entries: [entry],
  };
  // The receipt lists the files in another order than the folder does
  const receipt = (fields = {}) =>
    writeFile(
      join(tool, 'circle-tool.json'),
      JSON.stringify({
        version: '2.0.0',
        sha256: 'a'.repeat(64),
        target: 'darwin-arm64',
        format: 1,
        files: { LICENSE: hash('license'), [entry]: hash('gh binary') },
        ...fields,
      }),
    );
  assert.equal(await toolCacheMismatch(tool, expected), 'no receipt');
  await receipt();
  assert.equal(await toolCacheMismatch(tool, expected), '');
  await receipt({ version: '1.9.0' });
  assert.equal(await toolCacheMismatch(tool, expected), 'version 1.9.0');
  await receipt({ target: 'darwin-x64' });
  assert.equal(await toolCacheMismatch(tool, expected), 'target darwin-x64');
  await receipt();
  await writeFile(join(tool, entry), 'changed');
  await writeFile(join(tool, 'bin', 'extra'), 'extra');
  await rm(join(tool, 'LICENSE'));
  assert.equal(
    await toolCacheMismatch(tool, expected),
    `files differ: -LICENSE, ~${entry}, +${join('bin', 'extra')}`,
  );
});

test('unsupported architecture fails explicitly instead of copying host tools', async () => {
  await assert.rejects(
    prepareDeveloperTools('/unused', { platform: 'win32', arch: 'arm64' }),
    /unsupported developer tool target/,
  );
});

test('staged native runtime includes target addons, executable helper and TypeScript libraries', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'circle-native-runtime-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('..', import.meta.url));
  await prepareNativeDependencies(root, dist);
  const require = createRequire(join(dist, 'probe.cjs'));
  const ts = require('typescript');
  assert.match(
    await readFile(ts.getDefaultLibFilePath({}), 'utf8'),
    /reference lib="es5"/,
  );
  assert.ok(
    (
      await stat(
        join(dist, 'node_modules/typescript-language-server/lib/cli.mjs'),
      )
    ).size > 1000,
  );
  // The native addon must be loaded in a child: Windows holds its DLL open
  // until the loading process exits, even after every PTY has been released.
  const cleanupPath = fileURLToPath(
    new URL('../src/workspace/pty-exit-cleanup.mjs', import.meta.url),
  );
  const output = execFileSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const load = require('node:module').createRequire(${JSON.stringify(join(dist, 'probe.cjs'))});
    const koffi = load('koffi');
    assert.equal(koffi.version, '3.3.3');
    const library = koffi.load(process.platform === 'win32' ? 'kernel32.dll' : null);
    const getpid = library.func(process.platform === 'win32' ? 'uint32_t __stdcall GetCurrentProcessId()' : 'int getpid()');
    assert.equal(Number(getpid()), process.pid);
    console.log('STAGED_KOFFI_LOADED');
    const pty = load('node-pty');
    const {installWindowsPtyExitCleanup} = require(${JSON.stringify(cleanupPath)});
    const terminal = pty.spawn(process.execPath, ['-e', "console.log('STAGED_TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY)"], {cwd:${JSON.stringify(dist)},cols:80,rows:24});
    installWindowsPtyExitCleanup(terminal,{version:load('node-pty/package.json').version});
    let output='';
    terminal.onData(chunk=>output+=chunk);
    const timer=setTimeout(()=>{terminal.kill();throw Error('staged PTY did not exit');},8000);
    terminal.onExit(({exitCode})=>{clearTimeout(timer);assert.equal(exitCode,0);assert.match(output,/STAGED_TTY:true:true/);console.log('STAGED_PTY_RELEASED');});
  `,
    ],
    { encoding: 'utf8', timeout: 12000 },
  );
  assert.match(output, /STAGED_PTY_RELEASED/);
  assert.match(output, /STAGED_KOFFI_LOADED/);
  const hostRequire = createRequire(join(root, 'package.json'));
  const electronOutput = execFileSync(
    hostRequire('electron'),
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const load = require('node:module').createRequire(${JSON.stringify(join(dist, 'probe.cjs'))});
    const koffi = load('koffi');
    assert.equal(koffi.version, '3.3.3');
    const library = koffi.load(process.platform === 'win32' ? 'kernel32.dll' : null);
    const getpid = library.func(process.platform === 'win32' ? 'uint32_t __stdcall GetCurrentProcessId()' : 'int getpid()');
    assert.equal(Number(getpid()), process.pid);
    console.log('STAGED_ELECTRON_KOFFI_LOADED');
  `,
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 12000,
    },
  );
  assert.match(electronOutput, /STAGED_ELECTRON_KOFFI_LOADED/);

  const receipt = JSON.parse(
    await readFile(join(dist, 'tools/koffi-native.json'), 'utf8'),
  );
  assert.equal(receipt.version, '3.3.3');
  assert.equal(receipt.target, `${process.platform}-${process.arch}`);
  assert.ok(Object.keys(receipt.files).some((file) => file.endsWith('.node')));
  for (const [file, hash] of Object.entries(receipt.files))
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(dist, file)))
        .digest('hex'),
      hash,
    );
  if (process.platform === 'darwin') {
    const helper = await stat(
      join(
        dist,
        `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
      ),
    );
    assert.ok(helper.mode & 0o111);
  }
});

test(
  'source dependency permissions repair non-executable archive helper after install',
  {
    skip:
      process.platform === 'win32' &&
      'Windows uses ConPTY executables instead of Unix spawn-helper',
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'circle-pty-install-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dependency = join(root, 'node_modules/node-pty');
    const prebuild = join(dependency, 'prebuilds/darwin-arm64');
    const compiled = join(dependency, 'build/Release');
    await mkdir(prebuild, { recursive: true });
    await mkdir(compiled, { recursive: true });
    await writeFile(join(dependency, 'package.json'), '{"name":"node-pty"}');
    for (const folder of [prebuild, compiled])
      await writeFile(join(folder, 'spawn-helper'), 'fixture', { mode: 0o644 });
    await ensureNativeDependencyPermissions(root);
    for (const folder of [prebuild, compiled])
      assert.ok((await stat(join(folder, 'spawn-helper'))).mode & 0o111);
  },
);

test('desktop build cleanup preserves the tool cache and removes every old generated output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-build-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = join(root, 'tools/node/bin');
  await mkdir(tools, { recursive: true });
  await writeFile(join(tools, 'node'), 'cached executable bytes');
  await writeFile(
    join(root, 'tools/node/circle-tool.json'),
    '{"receipt":"preserved for revalidation"}',
  );
  await mkdir(join(root, 'renderer/assets'), { recursive: true });
  await writeFile(join(root, 'renderer/assets/stale.js'), 'obsolete renderer');
  await writeFile(join(root, 'main.cjs'), 'obsolete main');
  await resetDesktopOutput(root);
  assert.equal(
    await readFile(join(tools, 'node'), 'utf8'),
    'cached executable bytes',
  );
  assert.equal(
    await readFile(join(root, 'tools/node/circle-tool.json'), 'utf8'),
    '{"receipt":"preserved for revalidation"}',
  );
  await assert.rejects(stat(join(root, 'main.cjs')), { code: 'ENOENT' });
  await assert.rejects(stat(join(root, 'renderer')), { code: 'ENOENT' });
  await resetDesktopOutput(root);
  assert.equal(
    await readFile(join(tools, 'node'), 'utf8'),
    'cached executable bytes',
  );
});

test('an incomplete matching tool receipt cannot suppress preparation of a missing executable', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'circle-empty-tool-cache-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(join(dist, 'tools/node'), { recursive: true });
  await writeFile(
    join(dist, 'tools/node/circle-tool.json'),
    JSON.stringify({
      version: '24.21.0',
      target: 'darwin-arm64',
      format: 1,
      sha256:
        'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
      files: {},
    }),
  );
  let requested;
  await assert.rejects(
    prepareDeveloperTools(dist, {
      platform: 'darwin',
      arch: 'arm64',
      fetchArchive: async (url) => {
        requested = url;
        throw Error('fixture download reached');
      },
    }),
    /fixture download reached/,
  );
  assert.match(requested, /node-v24\.21\.0-darwin-arm64/);
});

test('static command supervisor copies exact source bytes and rejects a tampered resource receipt', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'circle-supervisor-resource-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await prepareCommandSupervisor(dist);
  const entry = join(dist, 'tools', 'command-supervisor.mjs');
  const original = await readFile(
    new URL('../src/workspace/command-supervisor.mjs', import.meta.url),
  );
  assert.deepEqual(await readFile(entry), original);
  await verifyCommandSupervisor(dist);
  await writeFile(entry, 'tampered');
  await assert.rejects(
    verifyCommandSupervisor(dist),
    /unprepared command supervisor/,
  );
  await prepareCommandSupervisor(dist);
  await verifyCommandSupervisor(dist);
  assert.deepEqual(await readFile(entry), original);
  const source = original.toString('utf8');
  assert.deepEqual(
    [...source.matchAll(/from ['"]([^'"]+)['"]/g)]
      .map((match) => match[1])
      .every((name) => name.startsWith('node:')),
    true,
  );
});
