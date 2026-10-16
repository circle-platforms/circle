import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRuntimePerformanceDiagnostics,
  runtimeCommandDiagnosticMetadata,
} from '../src/runtime-performance-diagnostics.js';
import { scratch } from '../../../tests/helpers.js';

test('worker diagnostics require both opt-in and scratch test profile, and keep bounded metadata', (t) => {
  const dataFolder = scratch(t);
  for (const config of [
    { testProfile: false, enabled: true },
    { testProfile: true, enabled: false },
  ])
    assert.equal(
      createRuntimePerformanceDiagnostics({ ...config, dataFolder }),
      undefined,
    );
  assert.deepEqual(readdirSync(dataFolder), []);
  const diagnostic = createRuntimePerformanceDiagnostics({
    testProfile: true,
    enabled: true,
    dataFolder,
    maxBytes: 250,
  })!;
  diagnostic.record('command-start', {
    id: 'owned-id',
    name: 'workspace-service',
    service: 'terminal',
    method: 'replay',
  });
  diagnostic.record('command-end', {
    id: 'owned-id',
    name: 'workspace-service',
  });
  for (let i = 0; i < 100; i++)
    diagnostic.record('overflow', { id: 'bounded' });
  diagnostic.close();
  diagnostic.close();
  diagnostic.record('closed', { id: 'must-not-write' });
  const path = diagnostic.status.path;
  const rows = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(rows[0].phase, 'command-start');
  assert.equal(rows[0].method, 'replay');
  assert.equal(rows.at(-1).phase, 'diagnostics-closed');
  assert.ok(rows.at(-1).dropped > 0);
  assert.ok(Buffer.byteLength(readFileSync(path)) < 500);
  assert.ok(!readFileSync(path, 'utf8').includes('must-not-write'));
});

test('same-profile worker epochs can restart and I/O failures cannot abort measured dispatch or close', (t) => {
  const dataFolder = scratch(t);
  const first = createRuntimePerformanceDiagnostics({
    testProfile: true,
    enabled: true,
    dataFolder,
  })!;
  first.record('first', {});
  first.close();
  const second = createRuntimePerformanceDiagnostics({
    testProfile: true,
    enabled: true,
    dataFolder,
  })!;
  assert.notEqual(first.status.path, second.status.path);
  second.close();
  assert.equal(readdirSync(dataFolder).length, 2);
  const nonDirectory = join(dataFolder, 'file');
  writeFileSync(nonDirectory, 'x');
  const unavailable = createRuntimePerformanceDiagnostics({
    testProfile: true,
    enabled: true,
    dataFolder: nonDirectory,
  })!;
  // Windows reports a missing child path when an intermediate component is a
  // file. POSIX reports that component as not a directory. Neither may succeed.
  assert.equal(
    unavailable.status.unavailable,
    process.platform === 'win32' ? 'ENOENT' : 'ENOTDIR',
  );
  assert.doesNotThrow(() => {
    unavailable.record('command-start', {});
    unavailable.record('command-end', {});
    unavailable.close();
  });
  assert.equal(readFileSync(nonDirectory, 'utf8'), 'x');
  assert.equal(existsSync(unavailable.status.path), false);
  assert.equal(unavailable.status.bytes, 0);
  const failedWrite = createRuntimePerformanceDiagnostics({
    testProfile: true,
    enabled: true,
    dataFolder,
    io: {
      write: () => {
        writeFileSync(dataFolder, 'cannot write a directory');
        return 0;
      },
    },
  })!;
  const effects: string[] = [];
  assert.doesNotThrow(() => {
    failedWrite.record('command-start', {});
    effects.push('reply');
    failedWrite.record('workspace-event-sent', {});
    effects.push('emit');
    failedWrite.close();
    effects.push('close');
  });
  assert.match(failedWrite.status.unavailable!, /EISDIR/);
  assert.deepEqual(effects, ['reply', 'emit', 'close']);
});
test('only known workspace-service enum metadata is copied, never arbitrary payload primitives', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  assert.deepEqual(
    runtimeCommandDiagnosticMetadata({
      id,
      name: 'workspace-service',
      payload: {
        service: 'terminal',
        method: 'replay',
        params: { secret: 'never' },
      },
    }),
    { id, name: 'workspace-service', service: 'terminal', method: 'replay' },
  );
  for (const command of [
    { id, name: 'prompt', payload: { service: 'secret', method: 'secret' } },
    {
      id,
      name: 'workspace-service',
      payload: { service: 'terminal', method: 'secret' },
    },
    {
      id: 'secret-text',
      name: 'secret-text',
      payload: { service: 'secret', method: 'secret' },
    },
  ])
    assert.ok(
      !JSON.stringify(runtimeCommandDiagnosticMetadata(command)).includes(
        'secret',
      ),
    );
});
