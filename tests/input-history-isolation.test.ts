import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs, { readFileSync, readdirSync, type PathLike } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { InputHistory } from '../src/tui/input_history.js';
import { scratch } from './helpers.js';
import lockfile from 'proper-lockfile';

const ioError = (code: string) =>
  Object.assign(new Error(`injected ${code}`), { code });

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`a transient ${code} atomic publish does not lose an entry or another view's browsing state`, (t) => {
    const directory = scratch(t);
    const path = join(directory, 'history');
    const writer = new InputHistory(path);
    writer.add('first');
    const observer = new InputHistory(path);
    assert.equal(observer.up('parked draft'), 'first');
    const peer = new InputHistory(path);
    peer.add('peer entry');
    const rename = fs.renameSync;
    let failures = 0;
    const mocked = t.mock.method(
      fs,
      'renameSync',
      (...[source, target]: Parameters<typeof fs.renameSync>) => {
        if (target === path && failures++ === 0) throw ioError(code);
        return rename(source, target);
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      mocked.mock.restore();
      syncBuiltinESMExports();
    });
    writer.add('retried entry');
    assert.deepEqual(new InputHistory(path).items, [
      'first',
      'peer entry',
      'retried entry',
    ]);
    assert.equal(observer.down(), 'parked draft');
    assert.equal(observer.up('new draft'), 'retried entry');
    assert.deepEqual(readdirSync(directory), ['history']);
  });
}

test('a transient locked read never replaces newer peer entries with a stale browsing snapshot', (t) => {
  const path = join(scratch(t), 'history');
  const stale = new InputHistory(path);
  stale.add('first');
  const peer = new InputHistory(path);
  peer.add('peer entry');
  const read = fs.readFileSync;
  let failures = 0;
  const mocked = t.mock.method(
    fs,
    'readFileSync',
    (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === path && failures++ === 0) throw ioError('EBUSY');
      return Reflect.apply(read, fs, args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  stale.add('new entry');
  assert.deepEqual(new InputHistory(path).items, [
    'first',
    'peer entry',
    'new entry',
  ]);
});

test('a transient lock acquisition failure retries the history transaction', (t) => {
  const path = join(scratch(t), 'history');
  const history = new InputHistory(path);
  history.add('first');
  const lock = lockfile.lockSync;
  let attempts = 0;
  t.mock.method(
    lockfile,
    'lockSync',
    (...[target, options]: Parameters<typeof lockfile.lockSync>) => {
      if (target === path && attempts++ === 0) throw ioError('EPERM');
      return lock(target, options);
    },
  );
  history.add('new entry');
  assert.deepEqual(new InputHistory(path).items, ['first', 'new entry']);
  assert.equal(attempts, 2);
});

test('persistent failures stay bounded and pending entries survive browsing and a later peer merge', (t) => {
  const path = join(scratch(t), 'history');
  const history = new InputHistory(path);
  history.add('first');
  const rename = fs.renameSync;
  let blocked = true;
  let attempts = 0;
  const mocked = t.mock.method(
    fs,
    'renameSync',
    (...[source, target]: Parameters<typeof fs.renameSync>) => {
      if (blocked && target === path) {
        attempts++;
        throw ioError('EBUSY');
      }
      return rename(source, target);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const started = performance.now();
  assert.doesNotThrow(() => history.add('pending one'));
  const elapsed = performance.now() - started;
  // Each refused operation is retried within the one-second window the history
  // shares with the settings lock; the synchronous Enter path still returns.
  assert.ok(attempts > 1, 'a transient refusal is retried');
  assert.ok(elapsed < 5000, `transient retries are bounded (${elapsed} ms)`);
  assert.equal(history.up('unsent draft'), 'pending one');
  assert.equal(history.down(), 'unsent draft');
  blocked = false;
  const peer = new InputHistory(path);
  peer.add('peer entry');
  history.add('pending two');
  assert.deepEqual(new InputHistory(path).items, [
    'first',
    'peer entry',
    'pending one',
    'pending two',
  ]);
});

test('non-transient read failures preserve the file and retry pending input only on a later add', (t) => {
  const path = join(scratch(t), 'history');
  const history = new InputHistory(path);
  history.add('first');
  const peer = new InputHistory(path);
  peer.add('peer entry');
  const original = readFileSync(path, 'utf8');
  const read = fs.readFileSync;
  let blocked = true;
  let attempts = 0;
  const mocked = t.mock.method(
    fs,
    'readFileSync',
    (...args: Parameters<typeof fs.readFileSync>) => {
      if (blocked && args[0] === path) {
        attempts++;
        throw ioError('EIO');
      }
      return Reflect.apply(read, fs, args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  assert.doesNotThrow(() => history.add('pending entry'));
  assert.equal(attempts, 1);
  assert.equal(Reflect.apply(read, fs, [path, 'utf8']), original);
  blocked = false;
  history.add('next entry');
  assert.deepEqual(new InputHistory(path).items, [
    'first',
    'peer entry',
    'pending entry',
    'next entry',
  ]);
});

test('pending history keeps its maximum, multiline entries and consecutive duplicate behavior', (t) => {
  const path = join(scratch(t), 'history');
  const history = new InputHistory(path, 3);
  history.add('first');
  const rename = fs.renameSync;
  let blocked = true;
  let attempts = 0;
  const mocked = t.mock.method(
    fs,
    'renameSync',
    (...[source, target]: Parameters<typeof fs.renameSync>) => {
      if (blocked && target === path) {
        attempts++;
        throw ioError('EROFS');
      }
      return rename(source, target);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  for (const entry of ['second', 'third\nline', 'third\nline', 'fourth'])
    history.add(entry);
  assert.equal(attempts, 4, 'non-transient failures are not retried');
  assert.deepEqual(history.items, ['second', 'third\nline', 'fourth']);
  assert.equal(history.beginSearch('third'), 'third\nline');
  assert.equal(history.endSearch(true), 'third');
  blocked = false;
  history.add('fifth');
  assert.deepEqual(new InputHistory(path, 3).items, [
    'third\nline',
    'fourth',
    'fifth',
  ]);
});

test('temporary cleanup failure cannot duplicate a successfully published pending batch', (t) => {
  const directory = scratch(t);
  const path = join(directory, 'history');
  const history = new InputHistory(path);
  const rename = fs.renameSync;
  let blocked = true;
  const renamed = t.mock.method(
    fs,
    'renameSync',
    (...[source, target]: Parameters<typeof fs.renameSync>) => {
      if (blocked && target === path) throw ioError('EROFS');
      return rename(source, target);
    },
  );
  syncBuiltinESMExports();
  history.add('pending one');
  blocked = false;
  const remove = fs.rmSync;
  const removed = t.mock.method(
    fs,
    'rmSync',
    (...args: Parameters<typeof fs.rmSync>) => {
      if (
        String(args[0]).startsWith(path + '.') &&
        String(args[0]).endsWith('.tmp')
      )
        throw ioError('EBUSY');
      return Reflect.apply(remove, fs, args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    renamed.mock.restore();
    removed.mock.restore();
    syncBuiltinESMExports();
  });
  history.add('pending two');
  history.add('last');
  assert.deepEqual(new InputHistory(path).items, [
    'pending one',
    'pending two',
    'last',
  ]);
  assert.deepEqual(readdirSync(directory), ['history']);
});

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
  // Windows reports sharing violations as EACCES too, so each publication retries
  // it within the bounded window before keeping the entry pending.
  assert.ok(
    refused > 2,
    'each refused publication is retried and then given up',
  );
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
  assert.ok(
    refused > 1,
    'the refused locked read is retried and then given up',
  );
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
  const expected = ['A', 'B', 'C'].flatMap((prefix) =>
    Array.from({ length: 20 }, (_, index) => prefix + ' ' + index),
  );
  assert.equal(
    actual.length,
    60,
    JSON.stringify({
      missing: expected.filter((entry) => !actual.includes(entry)),
      duplicates: actual.filter(
        (entry, index) => actual.indexOf(entry) !== index,
      ),
    }),
  );
  for (const prefix of ['A', 'B', 'C'])
    assert.deepEqual(
      actual.filter((entry) => entry.startsWith(prefix + ' ')),
      Array.from({ length: 20 }, (_, index) => prefix + ' ' + index),
    );
});

test('independent terminal processes retain all 60 entries after each suffers a transient publish failure', async (t) => {
  const path = join(scratch(t), 'history');
  const module = new URL('../src/tui/input_history.ts', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { InputHistory } from ${JSON.stringify(module)};
    const original = fs.renameSync;
    let failed = false;
    fs.renameSync = (source, target) => {
      if (target === process.argv[1] && !failed) {
        failed = true;
        throw Object.assign(new Error('injected Windows sharing error'), { code: 'EPERM' });
      }
      return original(source, target);
    };
    syncBuiltinESMExports();
    const history = new InputHistory(process.argv[1]);
    for (let index = 0; index < 20; index++) history.add(process.argv[2] + ' ' + index);
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
  const expected = ['A', 'B', 'C'].flatMap((prefix) =>
    Array.from({ length: 20 }, (_, index) => prefix + ' ' + index),
  );
  assert.equal(
    actual.length,
    60,
    JSON.stringify({
      missing: expected.filter((entry) => !actual.includes(entry)),
      duplicates: actual.filter(
        (entry, index) => actual.indexOf(entry) !== index,
      ),
    }),
  );
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
