import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { workspaceToolsForWorker } from '../src/runtime-tools.ts';

const fixture = (...parts: string[]) =>
  join(resolve('/synthetic tools fixture'), ...parts);

test('development tools resolve beside the built worker, never through PATH', () => {
  assert.deepEqual(
    workspaceToolsForWorker(
      pathToFileURL(fixture('application', 'dist', 'runtime-worker.mjs')).href,
      fixture('Electron'),
      'darwin',
    ),
    {
      nodeExecutable: fixture('Electron'),
      runtimeExecutable: fixture(
        'application',
        'dist',
        'tools',
        'node',
        'bin',
        'node',
      ),
      adapterPath: fixture(
        'application',
        'dist',
        'tools',
        'js-debug',
        'src',
        'dapDebugServer.js',
      ),
      ghPath: fixture('application', 'dist', 'tools', 'gh', 'bin', 'gh'),
    },
  );
});
test('packaged executables and adapter resources resolve outside asar', () => {
  const resources = fixture('Circle.app', 'Contents', 'Resources');
  const tools = workspaceToolsForWorker(
    pathToFileURL(join(resources, 'app.asar', 'dist', 'runtime-worker.mjs'))
      .href,
    fixture('Circle'),
    'darwin',
  );
  const unpacked = join(resources, 'app.asar.unpacked', 'dist', 'tools');
  assert.deepEqual(tools, {
    runtimeExecutable: join(unpacked, 'node', 'bin', 'node'),
    adapterPath: join(unpacked, 'js-debug', 'src', 'dapDebugServer.js'),
    ghPath: join(unpacked, 'gh', 'bin', 'gh'),
    nodeExecutable: fixture('Circle'),
  });
});
test('Windows tool names use native executable suffixes', () => {
  const tools = workspaceToolsForWorker(
    pathToFileURL(
      fixture('resources', 'app.asar', 'dist', 'runtime-worker.mjs'),
    ).href,
    fixture('Circle.exe'),
    'win32',
  );
  const unpacked = fixture('resources', 'app.asar.unpacked', 'dist', 'tools');
  assert.deepEqual(tools, {
    runtimeExecutable: join(unpacked, 'node', 'bin', 'node.exe'),
    adapterPath: join(unpacked, 'js-debug', 'src', 'dapDebugServer.js'),
    ghPath: join(unpacked, 'gh', 'bin', 'gh.exe'),
    nodeExecutable: fixture('Circle.exe'),
  });
});
