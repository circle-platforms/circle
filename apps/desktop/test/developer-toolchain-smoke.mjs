// Runs Electron's Node runtime only: no BrowserWindow, real profile, model or network.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const executable = process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron');
const application = process.env.CIRCLE_DESKTOP_APP_PATH;
const dist = application
  ? join(
      resolve(application),
      process.platform === 'darwin'
        ? 'Contents/Resources/app.asar.unpacked/dist'
        : 'resources/app.asar.unpacked/dist',
    )
  : join(root, 'dist');
const scratch = mkdtempSync(join(tmpdir(), 'circle-native-toolchain-smoke-'));
try {
  const probe = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const dist = ${JSON.stringify(dist)};
// node-pty rewrites virtual app.asar to its unpacked helper path itself.
const moduleDist = dist.replace('app.asar.unpacked', 'app.asar');
const load = require('node:module').createRequire(path.join(moduleDist, 'probe.cjs'));
const ts = load('typescript');
assert.ok(fs.existsSync(ts.getDefaultLibFilePath({})));
assert.ok(fs.existsSync(path.join(dist, 'tools/js-debug/src/dapDebugServer.js')));
const gh = cp.spawnSync(path.join(dist, 'tools/gh/bin', process.platform === 'win32' ? 'gh.exe' : 'gh'), ['--version'], { encoding: 'utf8' });
assert.equal(gh.status, 0, gh.stderr);
assert.match(gh.stdout, /2\\.83\\.2/);
const adapter = cp.spawn(process.execPath, [path.join(dist, 'tools/js-debug/src/dapDebugServer.js'), '0', '127.0.0.1'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let adapterOutput = '';
let adapterReady = false;
adapter.stdout.on('data', chunk => {
  adapterOutput += chunk;
  if (/listening/i.test(adapterOutput)) { adapterReady = true; adapter.kill(); }
});
adapter.stderr.on('data', chunk => { adapterOutput += chunk; });
adapter.on('exit', () => { assert.ok(adapterReady, adapterOutput); console.log('debug adapter: real listening socket verified'); });
adapter.on('error', error => { throw error; });
setTimeout(() => { if (!adapterReady) { adapter.kill(); process.exit(3); } }, 10000).unref();
const pty = load('node-pty');
const shell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh';
const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'set /p value=&call echo PTY:%%value%%'] : ['-c', 'read value; printf "PTY:%s\\n" "$value"'];
const terminal = pty.spawn(shell, args, { cwd: ${JSON.stringify(scratch)}, cols: 80, rows: 24 });
let output = '';
terminal.onData((data) => { output += data; });
terminal.onExit((event) => {
  assert.equal(event.exitCode, 0, output);
  assert.match(output, /PTY:hello/);
  console.log(JSON.stringify({ node: process.version, electron: process.versions.electron, abi: process.versions.modules, target: process.platform + '-' + process.arch, pty: 'interactive stdin/output verified', gh: gh.stdout.split('\\n')[0], typescript: ts.version, adapter: 'present', dist }));
});
terminal.write('hello\\r');
setTimeout(() => { terminal.kill(); process.exit(2); }, 10000).unref();
`;
  const result = spawnSync(executable, ['-e', probe], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CIRCLE_HOME: join(scratch, 'home'),
      CIRCLE_WORKBENCH_DATA_DIR: join(scratch, 'data'),
      GH_CONFIG_DIR: join(scratch, 'gh'),
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Error(`native developer toolchain smoke failed: ${result.status}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
