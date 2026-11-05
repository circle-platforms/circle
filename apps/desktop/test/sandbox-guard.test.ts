import { test } from 'node:test';
import type { Plugin } from 'esbuild';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { until } from '../../../tests/helpers.ts';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const electronPath = require('electron');
// As in scripts/build.mjs: leave ssh2's .node accelerators to runtime, where their
// absence is the fallback ssh2 already handles.
const nativeBinaries: Plugin = {
  name: 'native-binaries',
  setup(api) {
    api.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};
async function bundleMain(appDir: string) {
  const { build } = require('esbuild');
  await build({
    entryPoints: [join(root, 'src/main.ts')],
    outfile: join(appDir, 'main.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    // mirror scripts/build.mjs: main pulls in ssh2 (device terminals), whose optional
    // native addons esbuild cannot bundle; ssh2 falls back to pure JS without them.
    external: ['electron', 'original-fs', 'cpu-features'],
    plugins: [nativeBinaries],
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
    CIRCLE_HOME: join(dataDir, 'cli-home'),
    CIRCLE_NO_UPDATE_CHECK: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [appDir, ...args], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { child, stderr: () => stderr, exited };
}
test(
  'main process refuses a contradictory --no-sandbox switch, runs without it, and exits with an error when its start fails',
  { timeout: 120000 },
  async (t) => {
    const temp = await mkdtemp(join(tmpdir(), 'circle-sandbox-guard-'));
    const children: ReturnType<typeof launch>[] = [];
    const start = (data: string, args: string[]) => {
      const launched = launch(join(temp, 'app'), data, args);
      children.push(launched);
      return launched;
    };
    const exit = async (launched: ReturnType<typeof launch>, phase: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          launched.exited,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(Error(`${phase} did not exit: ${launched.stderr()}`)),
              30000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const appDir = join(temp, 'app');
      await bundleMain(appDir);
      t.diagnostic('sandbox refusal');
      const refused = start(join(temp, 'data-a'), ['--no-sandbox']);
      const exitCode = await exit(refused, 'sandbox refusal');
      assert.equal(exitCode, 1);
      assert.match(refused.stderr(), /--no-sandbox/);
      t.diagnostic('sandbox startup');
      const accepted = start(join(temp, 'data-b'), [
        '--remote-debugging-port=0',
      ]);
      const portFile = join(temp, 'data-b', 'DevToolsActivePort');
      let port = 0;
      await until(
        async () => {
          if (accepted.child.exitCode !== null) throw Error(accepted.stderr());
          port = Number(
            (await readFile(portFile, 'utf8').catch(() => '')).split('\n')[0],
          );
          return port > 0;
        },
        { label: 'sandbox debugging port', timeout: 30000 },
      );
      const { chromium } = await import('playwright');
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      try {
        const page = browser.contexts()[0]!.pages()[0]!;
        await page.waitForURL('circle://workbench/index.html');
      } finally {
        await browser.close();
      }
      t.diagnostic('sandbox termination');
      accepted.child.kill();
      await exit(accepted, 'sandbox termination');
      // A start that fails exits with an error: its data folder cannot be made under a file
      await writeFile(join(temp, 'a-file'), '');
      t.diagnostic('failed data directory');
      const failed = start(join(temp, 'a-file', 'data'), []);
      const failedCode = await exit(failed, 'failed data directory');
      assert.equal(failedCode, 1);
      assert.match(failed.stderr(), /desktop startup failed/);
    } finally {
      for (const launched of children) {
        if (
          launched.child.exitCode === null &&
          launched.child.signalCode === null
        )
          launched.child.kill('SIGKILL');
        await launched.exited;
      }
      await rm(temp, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 500,
      });
    }
  },
);
