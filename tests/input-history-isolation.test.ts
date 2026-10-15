import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs, { readFileSync, type PathLike } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { InputHistory } from '../src/tui/input_history.js';
import { scratch } from './helpers.js';

function restoreFs(t: TestContext): void {
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('a transient history rename failure retries publication without dropping the entry', (t) => {
  const path = join(scratch(t), 'history');
  const history = new InputHistory(path);
  history.add('first');
  const rename = fs.renameSync;
  let attempts = 0;
  restoreFs(t);
  t.mock.method(fs, 'renameSync', (source: PathLike, target: PathLike) => {
    if (target === path && ++attempts === 1)
      throw Object.assign(new Error('temporarily busy history'), {
        code: 'EPERM',
      });
    return rename(source, target);
  });
  syncBuiltinESMExports();
  history.add('second');
  assert.equal(attempts, 2);
  assert.deepEqual(new InputHistory(path).items, ['first', 'second']);
  history.add('third');
  assert.deepEqual(new InputHistory(path).items, ['first', 'second', 'third']);
});

test('a transient locked history read never overwrites another terminal with a stale snapshot', (t) => {
  const path = join(scratch(t), 'history');
  const history = new InputHistory(path);
  history.add('A first');
  new InputHistory(path).add('B second');
  const read = fs.readFileSync;
  let attempts = 0;
  restoreFs(t);
  t.mock.method(fs, 'readFileSync', ((
    ...args: Parameters<typeof fs.readFileSync>
  ) => {
    if (args[0] === path && ++attempts === 1)
      throw Object.assign(new Error('temporarily busy history'), {
        code: 'EBUSY',
      });
    return read(...args);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  history.add('A third');
  assert.equal(attempts, 2);
  assert.deepEqual(new InputHistory(path).items, [
    'A first',
    'B second',
    'A third',
  ]);
});

test('unpublished history entries survive a permission failure and merge with later terminal writes', (t) => {
  const path = join(scratch(t), 'history');
  const history = new InputHistory(path);
  history.add('A first');
  const rename = fs.renameSync;
  let denied = true;
  let refused = 0;
  restoreFs(t);
  t.mock.method(fs, 'renameSync', (source: PathLike, target: PathLike) => {
    if (target === path && denied) {
      refused++;
      throw Object.assign(new Error('history is read-only'), {
        code: 'EACCES',
      });
    }
    return rename(source, target);
  });
  syncBuiltinESMExports();
  history.add('A pending');
  history.add('A pending');
  assert.equal(refused, 2, 'permanent permission errors are not retried');
  assert.equal(history.up('A draft'), 'A pending');
  assert.equal(history.down(), 'A draft');
  assert.deepEqual(new InputHistory(path).items, ['A first']);
  denied = false;
  new InputHistory(path).add('B second');
  history.add('A third');
  assert.deepEqual(new InputHistory(path).items, [
    'A first',
    'B second',
    'A pending',
    'A third',
  ]);
});

test('a denied locked read leaves the saved history intact and retains the unsaved entry', (t) => {
  const path = join(scratch(t), 'history');
  const history = new InputHistory(path);
  history.add('A first');
  new InputHistory(path).add('B second');
  const read = fs.readFileSync;
  let denied = true;
  let refused = 0;
  restoreFs(t);
  t.mock.method(fs, 'readFileSync', ((
    ...args: Parameters<typeof fs.readFileSync>
  ) => {
    if (args[0] === path && denied) {
      refused++;
      throw Object.assign(new Error('history is read-only'), {
        code: 'EACCES',
      });
    }
    return read(...args);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  history.add('A pending');
  assert.equal(refused, 1);
  assert.deepEqual(JSON.parse(read(path, 'utf8')).items, [
    'A first',
    'B second',
  ]);
  assert.deepEqual(history.items, ['A first', 'A pending']);
  denied = false;
  history.add('A third');
  assert.deepEqual(new InputHistory(path).items, [
    'A first',
    'B second',
    'A pending',
    'A third',
  ]);
});

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
      history.add(process.argv[2] + ' ' + index);
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
