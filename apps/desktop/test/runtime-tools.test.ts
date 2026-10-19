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
      'darwin',
    ),
    {
      commandSupervisorPath: fixture(
        'application',
        'dist',
        'tools',
        'command-supervisor.mjs',
      ),
      runtimeExecutable: fixture(
        'application',
        'dist',
        'tools',
        'node',
        'bin',
        'node',
      ),
      ghPath: fixture('application', 'dist', 'tools', 'gh', 'bin', 'gh'),
    },
  );
});
test('packaged executables resolve outside asar', () => {
  const resources = fixture('Circle.app', 'Contents', 'Resources');
  const tools = workspaceToolsForWorker(
    pathToFileURL(join(resources, 'app.asar', 'dist', 'runtime-worker.mjs'))
      .href,
    'darwin',
  );
  const unpacked = join(resources, 'app.asar.unpacked', 'dist', 'tools');
  assert.deepEqual(tools, {
    commandSupervisorPath: join(unpacked, 'command-supervisor.mjs'),
    runtimeExecutable: join(unpacked, 'node', 'bin', 'node'),
    ghPath: join(unpacked, 'gh', 'bin', 'gh'),
  });
});
test('Windows tool names use native executable suffixes', () => {
  const tools = workspaceToolsForWorker(
    pathToFileURL(
      fixture('resources', 'app.asar', 'dist', 'runtime-worker.mjs'),
    ).href,
    'win32',
  );
  const unpacked = fixture('resources', 'app.asar.unpacked', 'dist', 'tools');
  assert.deepEqual(tools, {
    commandSupervisorPath: join(unpacked, 'command-supervisor.mjs'),
    runtimeExecutable: join(unpacked, 'node', 'bin', 'node.exe'),
    ghPath: join(unpacked, 'gh', 'bin', 'gh.exe'),
  });
});
