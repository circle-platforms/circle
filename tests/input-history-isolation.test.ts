import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { InputHistory } from '../src/tui/input_history.js';
import { scratch } from './helpers.js';

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
