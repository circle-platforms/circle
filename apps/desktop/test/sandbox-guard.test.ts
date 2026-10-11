import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const electronPath = require('electron');
async function bundleMain(appDir: string) {
  const { build } = require('esbuild');
  await build({
    entryPoints: [join(root, 'src/main.ts')],
    outfile: join(appDir, 'main.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron'],
  });
  await writeFile(
    join(appDir, 'package.json'),
    JSON.stringify({
      name: 'sandbox-guard-test',
      version: '0.0.0',
      main: 'main.cjs',
    }),
  );
}
function launch(appDir: string, dataDir: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CIRCLE_WORKBENCH_DATA_DIR: dataDir,
    CIRCLE_WORKBENCH_MODE: 'preview',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [appDir, ...args], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return { child, stderr: () => stderr };
}
test(
  'main process refuses a contradictory --no-sandbox switch, runs without it, and exits with an error when its start fails',
  { timeout: 120000 },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), 'circle-sandbox-guard-'));
    try {
      const appDir = join(temp, 'app');
      await bundleMain(appDir);
      const refused = launch(appDir, join(temp, 'data-a'), ['--no-sandbox']);
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          refused.child.kill();
          reject(Error('app did not exit after --no-sandbox'));
        }, 60000);
        refused.child.on('error', reject);
        refused.child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(exitCode, 1);
      assert.match(refused.stderr(), /--no-sandbox/);
      const accepted = launch(appDir, join(temp, 'data-b'), []);
      const exited = new Promise((resolve) =>
        accepted.child.once('exit', resolve),
      );
      const alive = await new Promise((resolve) =>
        setTimeout(() => resolve(accepted.child.exitCode === null), 15000),
      );
      // Waits on the exit seen from the start: one that came already does not come again
      accepted.child.kill();
      await exited;
      assert.equal(
        alive,
        true,
        'app should keep running without the switch: ' + accepted.stderr(),
      );
      // A start that fails exits with an error: its data folder cannot be made under a file
      await writeFile(join(temp, 'a-file'), '');
      const failed = launch(appDir, join(temp, 'a-file', 'data'), []);
      const failedCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          failed.child.kill();
          reject(Error('app did not exit after a failed start'));
        }, 60000);
        failed.child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(failedCode, 1);
      assert.match(failed.stderr(), /desktop startup failed/);
    } finally {
      await rm(temp, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 500,
      });
    }
  },
);
