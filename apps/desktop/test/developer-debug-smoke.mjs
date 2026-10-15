// The adapter runs in Electron-as-Node, but the debuggee must use the real bundled Node.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const application = process.env.CIRCLE_DESKTOP_APP_PATH;
const dist = application
  ? join(
      resolve(application),
      process.platform === 'darwin'
        ? 'Contents/Resources/app.asar.unpacked/dist'
        : 'resources/app.asar.unpacked/dist',
    )
  : join(root, 'dist');
const result = spawnSync(
  process.execPath,
  [
    join(root, '../../node_modules/tsx/dist/cli.mjs'),
    '--test',
    join(root, 'test/workspace-debug.test.ts'),
  ],
  {
    stdio: 'inherit',
    timeout: 180_000,
    env: {
      ...process.env,
      CIRCLE_JS_DEBUG_ADAPTER: join(
        dist,
        'tools/js-debug/src/dapDebugServer.js',
      ),
      CIRCLE_JS_DEBUG_NODE:
        process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
      CIRCLE_JS_DEBUG_RUNTIME: join(
        dist,
        'tools/node/bin',
        process.platform === 'win32' ? 'node.exe' : 'node',
      ),
    },
  },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw Error(`native debug journey failed: ${result.status}`);
