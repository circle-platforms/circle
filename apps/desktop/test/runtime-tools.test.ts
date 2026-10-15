import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceToolsForWorker } from '../src/runtime-tools.ts';

test('development tools resolve beside the built worker, never through PATH', () => {
  assert.deepEqual(
    workspaceToolsForWorker(
      'file:///synthetic/application/dist/runtime-worker.mjs',
      '/synthetic/Electron',
      'darwin',
    ),
    {
      nodeExecutable: '/synthetic/Electron',
      runtimeExecutable: '/synthetic/application/dist/tools/node/bin/node',
      adapterPath:
        '/synthetic/application/dist/tools/js-debug/src/dapDebugServer.js',
      ghPath: '/synthetic/application/dist/tools/gh/bin/gh',
    },
  );
});
test('packaged executables and adapter resources resolve outside asar', () => {
  const tools = workspaceToolsForWorker(
    'file:///synthetic/Circle.app/Contents/Resources/app.asar/dist/runtime-worker.mjs',
    '/synthetic/Circle',
    'darwin',
  );
  assert.match(
    tools.runtimeExecutable,
    /app\.asar\.unpacked\/dist\/tools\/node\/bin\/node$/,
  );
  assert.match(
    tools.adapterPath,
    /app\.asar\.unpacked\/dist\/tools\/js-debug\/src\/dapDebugServer\.js$/,
  );
  assert.match(tools.ghPath, /app\.asar\.unpacked\/dist\/tools\/gh\/bin\/gh$/);
  assert.equal(tools.nodeExecutable, '/synthetic/Circle');
});
test('Windows tool names use native executable suffixes', () => {
  const tools = workspaceToolsForWorker(
    'file:///synthetic/resources/app.asar/dist/runtime-worker.mjs',
    '/synthetic/Circle.exe',
    'win32',
  );
  assert.ok(tools.runtimeExecutable.endsWith('node.exe'));
  assert.ok(tools.ghPath.endsWith('gh.exe'));
});
