import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimePerformanceDiagnostics } from '../src/runtime-performance-diagnostics.js';
import { scratch } from '../../../tests/helpers.js';

test('worker diagnostics require both opt-in and scratch test profile, and keep bounded metadata', (t) => {
  const dataFolder = scratch(t),
    path = join(dataFolder, 'performance-worker-events.jsonl');
  for (const config of [
    { testProfile: false, enabled: true },
    { testProfile: true, enabled: false },
  ])
    assert.equal(
      createRuntimePerformanceDiagnostics({ ...config, dataFolder }),
      undefined,
    );
  assert.equal(existsSync(path), false);
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
