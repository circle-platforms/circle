import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, type TestContext } from 'node:test';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { InputHistory } from '../src/tui/input_history.js';
import {
  historyFileOperation,
  InputHistoryIoError,
} from '../src/tui/input_history_file.js';
import { cleanup, scratch } from './helpers.js';
function fault(code: string) {
  return Object.assign(new Error('controlled filesystem failure'), { code });
}
function patch<K extends keyof typeof fs>(
  t: TestContext,
  key: K,
  value: (typeof fs)[K],
): void {
  const original = fs[key];
  Object.assign(fs, { [key]: value });
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(fs, { [key]: original });
    syncBuiltinESMExports();
  });
}
function stored(path: string): string[] {
  return JSON.parse(fs.readFileSync(path, 'utf8')).items;
}

test('a Windows-style sharing conflict on the final publish retains all sixty actual history entries', (t) => {
  const path = join(scratch(t), 'history'),
    views = ['A', 'B', 'C'].map(() => new InputHistory(path));
  const rename = fs.renameSync;
  let failures = 0,
    armed = false;
  patch(t, 'renameSync', ((source, destination) => {
    if (armed && destination === path) {
      armed = false;
      failures++;
      throw fault('EPERM');
    }
    return rename(source, destination);
  }) as typeof fs.renameSync);
  for (let i = 0; i < 20; i++)
    for (let p = 0; p < 3; p++) {
      if (i === 19 && p === 2) armed = true;
      assert.equal(views[p]!.add(['A', 'B', 'C'][p] + ' ' + i), true);
    }
  assert.equal(failures, 1);
  assert.equal(stored(path).length, 60);
  for (const prefix of ['A', 'B', 'C'])
    assert.deepEqual(
      stored(path).filter((item) => item.startsWith(prefix + ' ')),
      Array.from({ length: 20 }, (_, i) => prefix + ' ' + i),
    );
});

test('an unrecoverable publish failure exposes its stage and retains only pending deltas for a later merge', (t) => {
  const path = join(scratch(t), 'history'),
    a = new InputHistory(path);
  assert.equal(a.add('A first'), true);
  const b = new InputHistory(path);
  const rename = fs.renameSync;
  let fail = true,
    calls = 0;
  patch(t, 'renameSync', ((source, destination) => {
    if (
      fail &&
      destination === path &&
      JSON.parse(fs.readFileSync(source, 'utf8')).items.at(-1) === 'A second'
    ) {
      calls++;
      throw fault('ENOSPC');
    }
    return rename(source, destination);
  }) as typeof fs.renameSync);
  assert.equal(a.add('A second'), false);
  assert.equal(calls, 1, 'capacity errors are never retried blindly');
  assert.ok(a.persistenceError instanceof InputHistoryIoError);
  assert.equal((a.persistenceError as InputHistoryIoError).stage, 'publish');
  assert.equal((a.persistenceError as InputHistoryIoError).code, 'ENOSPC');
  assert.equal(a.pendingCount, 1);
  assert.deepEqual(stored(path), ['A first']);
  assert.deepEqual(a.items, ['A first', 'A second']);
  assert.equal(b.add('B concurrent'), true);
  fail = false;
  assert.equal(a.add('A third'), true);
  assert.deepEqual(stored(path), [
    'A first',
    'B concurrent',
    'A second',
    'A third',
  ]);
  assert.equal(a.pendingCount, 0);
  assert.equal(a.persistenceError, undefined);
});

test('a failed strict disk read cannot publish a stale browsing snapshot over another process history', (t) => {
  const path = join(scratch(t), 'history'),
    a = new InputHistory(path);
  a.add('A first');
  const b = new InputHistory(path);
  b.add('B second');
  const read = fs.readFileSync;
  let failed = 0,
    fail = true;
  patch(t, 'readFileSync', ((
    target: fs.PathOrFileDescriptor,
    ...args: unknown[]
  ) => {
    if (fail && target === path) {
      failed++;
      throw fault('EIO');
    }
    return Reflect.apply(read, fs, [target, ...args]);
  }) as typeof fs.readFileSync);
  assert.equal(a.add('A third'), false);
  assert.equal(failed, 1);
  assert.equal((a.persistenceError as InputHistoryIoError).stage, 'read');
  assert.equal(a.pendingCount, 1);
  fail = false;
  assert.deepEqual(stored(path), ['A first', 'B second']);
  assert.equal(a.flush(), true);
  assert.deepEqual(stored(path), ['A first', 'B second', 'A third']);
});

for (const method of ['mkdirSync', 'rmdirSync'] as const)
  test(`transient lock ${method} sharing failures are bounded and do not lose the committed input`, (t) => {
    const path = join(scratch(t), 'history'),
      history = new InputHistory(path),
      original = fs[method];
    let failures = 0;
    patch(t, method, ((target: fs.PathLike, ...args: unknown[]) => {
      if (target === path + '.lock' && failures === 0) {
        failures++;
        throw fault('EACCES');
      }
      return Reflect.apply(original, fs, [target, ...args]);
    }) as (typeof fs)[typeof method]);
    assert.equal(history.add('one exact input'), true);
    assert.equal(failures, 1);
    assert.deepEqual(stored(path), ['one exact input']);
    assert.equal(fs.existsSync(path + '.lock'), false);
  });

test('persistent permission failure is bounded, explicit and preserves the pending entry until a separate retry', (t) => {
  const path = join(scratch(t), 'history'),
    history = new InputHistory(path),
    rename = fs.renameSync;
  let blocked = true,
    calls = 0;
  patch(t, 'renameSync', ((source, destination) => {
    if (blocked && destination === path) {
      calls++;
      throw fault('EPERM');
    }
    return rename(source, destination);
  }) as typeof fs.renameSync);
  const started = Date.now();
  assert.equal(history.add('kept in this process'), false);
  assert(
    calls >= 1 && calls <= 9,
    'stop at the attempt cap or elapsed deadline, whichever comes first',
  );
  assert(Date.now() - started < 1500, 'sharing backoff has a finite deadline');
  assert.equal(history.pendingCount, 1);
  assert.equal((history.persistenceError as InputHistoryIoError).code, 'EPERM');
  assert.equal(fs.existsSync(path), false);
  blocked = false;
  assert.equal(history.flush(), true);
  assert.deepEqual(stored(path), ['kept in this process']);
  assert.equal(history.pendingCount, 0);
});

test('sharing retry independently enforces the attempt cap and elapsed deadline', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let cappedCalls = 0;
  assert.throws(
    () =>
      historyFileOperation('publish', () => {
        cappedCalls++;
        throw fault('EPERM');
      }),
    (error) =>
      error instanceof InputHistoryIoError &&
      error.stage === 'publish' &&
      error.code === 'EPERM',
  );
  assert.equal(
    cappedCalls,
    9,
    'the attempt cap applies even when no clock time advances',
  );
  let timedCalls = 0;
  assert.throws(
    () =>
      historyFileOperation('publish', () => {
        timedCalls++;
        now += 251;
        throw fault('EBUSY');
      }),
    (error) => error instanceof InputHistoryIoError && error.code === 'EBUSY',
  );
  assert.equal(
    timedCalls,
    1,
    'a slow failed call exhausts the deadline without another filesystem call',
  );
});

test('fresh views keep their navigation draft while failed deltas merge without erasing legacy multiline history', (t) => {
  const path = join(scratch(t), 'history');
  fs.writeFileSync(path, 'legacy one\nlegacy two\n');
  const a = new InputHistory(path),
    b = new InputHistory(path);
  assert.equal(a.up('unsent draft'), 'legacy two');
  assert.equal(b.add('new\nmultiline'), true);
  assert.equal(a.down(), 'unsent draft');
  assert.equal(a.up('parked'), 'new\nmultiline');
  assert.equal(a.add('new\nmultiline'), true);
  assert.deepEqual(stored(path), [
    'legacy one',
    'legacy two',
    'new\nmultiline',
  ]);
  assert.equal(a.pendingCount, 0);
});

test('the real composer reports a history write failure, retains the entry in memory and clears the draft without sending a model request', async (t) => {
  const { SessionApp } = await import('../src/tui/session_app.js');
  const { ScriptedModel } = await import('../src/testing.js');
  const { defaultSettings } = await import('../src/settings.js');
  const { renderScreen } = await import('../src/tui/render.js');
  const { buildPalette, setPalette, DEFAULT_DARK, DEFAULT_LIGHT } =
    await import('../src/ink/theme.js');
  const { stripAnsi } = await import('../src/ink/string_width.js');
  const home = scratch(t),
    workspace = scratch(t),
    settings = defaultSettings(),
    model = new ScriptedModel();
  const app = new SessionApp(workspace, home, settings),
    ui = app as any;
  // Register with scratch ownership so the real SQLite connection closes before
  // its directory is removed. Independent t.after hooks run after scratch cleanup.
  cleanup(t, () => app.close());
  ui.screen.render = () => {};
  app.terminal = {
    platform: process.platform,
    write: () => {},
    input: () => {},
    kill: () => {},
  };
  await app.attach({ workspace, home, settings, model, headless: true });
  const rename = fs.renameSync;
  patch(t, 'renameSync', ((source, destination) => {
    if (destination === ui.history.path) throw fault('ENOSPC');
    return rename(source, destination);
  }) as typeof fs.renameSync);
  ui.composer.paste('keep this cancelled draft');
  ui.handle({ type: 'key', key: 'ctrl+c', char: '' });
  assert.equal(app.state.draft, '');
  assert.equal(model.requests.length, 0);
  assert.equal(ui.history.pendingCount, 1);
  assert.deepEqual(ui.history.items, ['keep this cancelled draft']);
  assert.ok(
    app.state.notices.some((notice) =>
      notice.includes('input history publish failed (ENOSPC)'),
    ),
  );
  for (const colors of [DEFAULT_DARK, DEFAULT_LIGHT]) {
    setPalette(buildPalette(...colors));
    assert.match(
      renderScreen(app.state, 100, 30).map(stripAnsi).join('\n'),
      /input history publish failed \(ENOSPC\)/,
    );
  }
});

test('three actual terminal processes retain all entries when each final atomic publish encounters a sharing conflict', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const path = join(scratch(t), 'history'),
    module = new URL('../src/tui/input_history.ts', import.meta.url).href;
  const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {setTimeout as delay} from 'node:timers/promises';import {InputHistory} from ${JSON.stringify(module)};const path=process.argv[1],prefix=process.argv[2],history=new InputHistory(path),rename=fs.renameSync;let index=-1,injected=0;fs.renameSync=(from,to)=>{if(to===path&&index===19&&!injected){injected++;throw Object.assign(new Error('controlled sharing conflict'),{code:'EPERM'});}return rename(from,to);};syncBuiltinESMExports();for(index=0;index<20;index++){if(!history.add(prefix+' '+index))throw new Error(JSON.stringify({code:history.persistenceError?.code,stage:history.persistenceError?.stage,message:history.persistenceError?.message,pendingCount:history.pendingCount}));await delay(1);}process.stdout.write(JSON.stringify({prefix,injected,pendingCount:history.pendingCount}));`;
  const results = await Promise.all(
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
  for (const result of results) {
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.injected, 1);
    assert.equal(receipt.pendingCount, 0);
  }
  const actual = new InputHistory(path).items;
  assert.equal(actual.length, 60);
  for (const prefix of ['A', 'B', 'C'])
    assert.deepEqual(
      actual.filter((item) => item.startsWith(prefix + ' ')),
      Array.from({ length: 20 }, (_, index) => prefix + ' ' + index),
    );
});
