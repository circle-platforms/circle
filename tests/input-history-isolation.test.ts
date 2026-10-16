import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { InputHistory } from '../src/tui/input_history.js';
import { scratch } from './helpers.js';

async function historyFault(
  path: string,
  operation:
    | 'readFileSync'
    | 'mkdirSync'
    | 'writeFileSync'
    | 'renameSync'
    | 'rmSync'
    | 'lockSync',
  code: string,
  recover: boolean,
): Promise<{ failed: number; pending: string[] }> {
  const module = new URL('../src/tui/input_history.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { dirname } from 'node:path';
    import lockfile from 'proper-lockfile';
    import { InputHistory } from ${JSON.stringify(module)};
    const path = process.argv[1];
    const history = new InputHistory(path);
    const append = (text) => execFileSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      'import { InputHistory } from ' + ${JSON.stringify(JSON.stringify(module))} +
        '; new InputHistory(process.argv[1]).add(process.argv[2]);',
      path, text,
    ]);
    append('another terminal');
    const target = ${JSON.stringify(operation)} === 'lockSync' ? lockfile : fs;
    const original = target[${JSON.stringify(operation)}];
    let failed = 0;
    target[${JSON.stringify(operation)}] = (...args) => {
      const historyFile = ${JSON.stringify(operation)} === 'renameSync' ? args[1] : args[0];
      const isHistory = ${JSON.stringify(operation)} === 'writeFileSync' || ${JSON.stringify(operation)} === 'rmSync'
        ? String(historyFile).startsWith(path + '.') && String(historyFile).endsWith('.tmp')
        : String(historyFile) === (${JSON.stringify(operation)} === 'mkdirSync' ? dirname(path) : path);
      if (isHistory && (!${recover} || !failed)) {
        failed++;
        throw Object.assign(new Error('synthetic Windows sharing failure'), { code: ${JSON.stringify(code)} });
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    let pending;
    try {
      history.add('pending entry');
      pending = history.items;
    } finally {
      target[${JSON.stringify(operation)}] = original;
      syncBuiltinESMExports();
    }
    if (!${recover}) {
      const committed = ${JSON.stringify(operation)} === 'rmSync';
      assert.deepEqual(new InputHistory(path).items,
        ['first', 'another terminal', ...(committed ? ['pending entry'] : [])]);
      assert(pending.includes('pending entry'));
      append('after failure');
      assert.equal(history.up('unsent'), committed ? 'after failure' : 'pending entry');
      history.add('recovered entry');
    }
    process.stdout.write(JSON.stringify({ failed, pending }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    script,
    path,
  ]);
  return JSON.parse(stdout);
}

test('separate history views merge writes while retaining their own browsing draft and cursor', (t) => {
  const path = join(scratch(t), 'history');
  const a = new InputHistory(path);
  a.add('A first');
  const b = new InputHistory(path);
  assert.equal(a.up('A unsent'), 'A first');
  b.add('B second');
  assert.equal(a.down(), 'A unsent');
  assert.equal(a.up('A parked'), 'B second');
  a.add('A third');
  assert.deepEqual(new InputHistory(path).items, [
    'A first',
    'B second',
    'A third',
  ]);
  assert.equal(b.up('B unsent'), 'A third');
  assert.equal(b.up('ignored'), 'B second');
  assert.equal(b.down(), 'A third');
  assert.equal(b.down(), 'B unsent');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).items, [
    'A first',
    'B second',
    'A third',
  ]);
  assert(readFileSync(path, 'utf8').startsWith('{"format":"circle-history"'));
});

test('independent terminal processes append every history entry without stale snapshot overwrites', async (t) => {
  const path = join(scratch(t), 'history');
  const module = new URL('../src/tui/input_history.ts', import.meta.url).href;
  const script = `
    import { InputHistory } from ${JSON.stringify(module)};
    import { setTimeout as delay } from 'node:timers/promises';
    const history = new InputHistory(process.argv[1]);
    for (let index = 0; index < 20; index++) {
      const entry = process.argv[2] + ' ' + index;
      if (!history.add(entry)) {
        throw new Error(JSON.stringify({ entry,
          stage: history.persistenceError?.stage,
          code: history.persistenceError?.code,
          message: history.persistenceError?.message,
          pendingCount: history.pendingCount,
        }));
      }
      await delay(1);
    }
  `;
  await Promise.all(
    ['A', 'B', 'C'].map((prefix) =>
      promisify(execFile)(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        path,
        prefix,
      ]),
    ),
  );
  const actual = new InputHistory(path).items;
  assert.equal(actual.length, 60);
  for (const prefix of ['A', 'B', 'C'])
    assert.deepEqual(
      actual.filter((entry) => entry.startsWith(prefix + ' ')),
      Array.from({ length: 20 }, (_, index) => prefix + ' ' + index),
    );
});

for (const [operation, code] of [
  ['readFileSync', 'EACCES'],
  ['mkdirSync', 'EPERM'],
  ['writeFileSync', 'EACCES'],
  ['renameSync', 'EPERM'],
  ['lockSync', 'EBUSY'],
] as const)
  test(`history retries a transient ${code} from ${operation} without losing either terminal's entries`, async (t) => {
    const path = join(scratch(t), 'history');
    new InputHistory(path).add('first');
    const receipt = await historyFault(path, operation, code, true);
    assert.equal(receipt.failed, 1, 'the actual file operation was refused');
    assert.deepEqual(new InputHistory(path).items, [
      'first',
      'another terminal',
      'pending entry',
    ]);
  });

test('history does not replay committed entries when temporary-file cleanup fails after the atomic rename', async (t) => {
  const path = join(scratch(t), 'history');
  new InputHistory(path).add('first');
  const receipt = await historyFault(path, 'rmSync', 'EIO', false);
  assert.equal(receipt.failed, 1);
  assert.deepEqual(new InputHistory(path).items, [
    'first',
    'another terminal',
    'pending entry',
    'after failure',
    'recovered entry',
  ]);
});

for (const operation of ['readFileSync', 'renameSync'] as const)
  test(`history retains pending entries after ${operation} fails and merges them on the next successful append`, async (t) => {
    const path = join(scratch(t), 'history');
    new InputHistory(path).add('first');
    const receipt = await historyFault(path, operation, 'EIO', false);
    assert.equal(receipt.failed, 1);
    assert.deepEqual(new InputHistory(path).items, [
      'first',
      'another terminal',
      'after failure',
      'pending entry',
      'recovered entry',
    ]);
  });
