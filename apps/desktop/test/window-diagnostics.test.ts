import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import { appendDiagnosticLog } from '../src/diagnostic-log';
import {
  WINDOW_SAMPLE_MS,
  createWindowDiagnostics,
} from '../src/window-diagnostics';

function fixture() {
  const entries: string[] = [];
  const state = {
    at: 1_000_000,
    renderer: 300,
    panel: 900,
    runtime: 200,
    timer: undefined as (() => void) | undefined,
    interval: 0,
    throws: false,
  };
  const diagnostics = createWindowDiagnostics({
    log: (text) => entries.push(text),
    windowPids: () => [10],
    metrics: () => {
      if (state.throws) throw Error('no metrics');
      return [
        { pid: 10, memory: { workingSetSize: state.renderer * 1024 } },
        { pid: 11, memory: { workingSetSize: state.panel * 1024 } },
        { pid: 12, memory: { workingSetSize: state.runtime * 1024 } },
      ];
    },
    now: () => state.at,
    every: (run, ms) => {
      state.timer = run;
      state.interval = ms;
    },
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(),
  });
  return { diagnostics, entries, state, window };
}

test('a renderer that dies is named with what led up to it', () => {
  const { diagnostics, entries, state, window } = fixture();
  diagnostics.watch('main', window);
  diagnostics.sent('circle:runtime-update', [{ text: 'private words' }]);
  diagnostics.sent('circle:runtime-token-delta', [{ delta: 'more words' }]);
  diagnostics.sent('circle:runtime-token-delta', [{ delta: 'last words' }]);
  state.renderer = 700;
  diagnostics.sample();
  state.at += 90_000;
  window.webContents.emit('render-process-gone', undefined, {
    reason: 'crashed',
    exitCode: 5,
  });
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.match(
    entry,
    /window main renderer gone: reason crashed, exit code 5, 90 s after opening, highest 700 MB/,
  );
  assert.match(entry, /window 700 MB, all 1800 MB/);
  assert.match(entry, /circle:runtime-update 1 \(last \d+ chars\)/);
  assert.match(entry, /circle:runtime-token-delta 2 \(last \d+ chars\)/);
  assert.doesNotMatch(entry, /private|words/);
});

test('only the application windows count, not the pages in browser panels', () => {
  const { diagnostics, entries, state } = fixture();
  state.renderer = 100;
  state.panel = 8000;
  diagnostics.sample();
  assert.deepEqual(entries, []);
});

test('memory reaches the log when it crosses a step, not at every sample', () => {
  const { diagnostics, entries, state } = fixture();
  state.renderer = 1000;
  diagnostics.sample();
  assert.equal(entries.length, 0);
  state.renderer = 1100;
  diagnostics.sample();
  diagnostics.sample();
  assert.equal(entries.length, 1);
  state.renderer = 1500;
  diagnostics.sample();
  assert.equal(entries.length, 1);
  state.renderer = 2600;
  diagnostics.sample();
  assert.equal(entries.length, 2);
  state.renderer = 3000;
  diagnostics.sample();
  assert.equal(entries.length, 2);
  assert.match(entries[1], /window memory: .*window 2600 MB/);
});

test('messages count once, in the sample after they were sent', () => {
  const { diagnostics, entries, state, window } = fixture();
  diagnostics.watch('main', window);
  diagnostics.sent('circle:runtime-update', [{}]);
  diagnostics.sample();
  diagnostics.sample();
  state.at += 1000;
  window.webContents.emit('render-process-gone', undefined, {
    reason: 'oom',
    exitCode: 133,
  });
  const lines = entries[0].split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /circle:runtime-update 1 /);
  assert.doesNotMatch(lines[2], /circle:runtime-update/);
});

test('it keeps twenty minutes of samples and starts again after a crash', () => {
  const { diagnostics, entries, state, window } = fixture();
  diagnostics.watch('main', window);
  for (let index = 0; index < 50; index++) {
    state.at += WINDOW_SAMPLE_MS;
    state.renderer = 1000 + index;
    diagnostics.sample();
  }
  assert.equal(entries.length, 1);
  window.webContents.emit('render-process-gone', undefined, {
    reason: 'crashed',
    exitCode: 5,
  });
  assert.equal(entries[1].split('\n').length, 41);
  assert.match(entries[1], /highest 1049 MB/);
  state.renderer = 1100;
  diagnostics.sample();
  assert.match(entries[2], /window memory: .*window 1100 MB/);
});

test('sampling starts once, however many windows are watched', () => {
  const { diagnostics, state, window } = fixture();
  let timers = 0;
  const other = createWindowDiagnostics({
    log: () => {},
    windowPids: () => [],
    metrics: () => [],
    every: () => timers++,
  });
  other.watch('main', window);
  other.watch('popout', window);
  assert.equal(timers, 1);
  diagnostics.watch('main', window);
  assert.equal(state.interval, WINDOW_SAMPLE_MS);
  assert.equal(typeof state.timer, 'function');
});

test('a window that stops responding says so and for how long', () => {
  const { diagnostics, entries, state, window } = fixture();
  diagnostics.watch('popout', window);
  state.renderer = 640;
  diagnostics.sample();
  state.at += 60_000;
  window.emit('unresponsive');
  state.at += 12_000;
  window.emit('responsive');
  window.emit('responsive');
  assert.deepEqual(entries, [
    'window popout stopped responding 60 s after opening, last sample 640 MB',
    'window popout responding again after 12 s',
  ]);
});

test('another process that dies is logged, one that ended cleanly is not', () => {
  const { diagnostics, entries } = fixture();
  diagnostics.childGone({ type: 'GPU', reason: 'clean-exit', exitCode: 0 });
  diagnostics.childGone({ type: 'GPU', reason: 'crashed', exitCode: 11 });
  diagnostics.childGone({
    type: 'Utility',
    name: 'network',
    reason: 'killed',
    exitCode: 9,
  });
  assert.deepEqual(entries, [
    'process gone: GPU, reason crashed, exit code 11',
    'process gone: Utility network, reason killed, exit code 9',
  ]);
});

test('a failed reading and a value JSON cannot carry change nothing', () => {
  const { diagnostics, entries, state, window } = fixture();
  diagnostics.watch('main', window);
  state.throws = true;
  assert.doesNotThrow(() => diagnostics.sample());
  state.throws = false;
  const loop: { self?: unknown } = {};
  loop.self = loop;
  diagnostics.sent('circle:loop', [loop]);
  assert.doesNotThrow(() => diagnostics.sample());
  window.webContents.emit('render-process-gone', undefined, {
    reason: 'crashed',
    exitCode: 5,
  });
  assert.match(entries[0], /circle:loop 1(,|$)/m);
});

test('a log past a megabyte moves aside and the entry is still written', () => {
  const folder = mkdtempSync(join(tmpdir(), 'circle-diagnostic-log-'));
  const file = join(folder, 'logs', 'runtime.log');
  appendDiagnosticLog(file, '1.2.3', 'first');
  assert.match(readFileSync(file, 'utf8'), /circle 1\.2\.3 .*\nfirst\n\n$/);
  writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
  appendDiagnosticLog(file, undefined, 'second');
  assert.equal(statSync(`${file}.1`).size, 1024 * 1024 + 1);
  assert.match(readFileSync(file, 'utf8'), /circle \? .*\nsecond\n\n$/);
});

test('a log that cannot be written does not reach the caller', () => {
  const folder = mkdtempSync(join(tmpdir(), 'circle-diagnostic-log-'));
  const blocked = join(folder, 'file');
  writeFileSync(blocked, '');
  assert.doesNotThrow(() =>
    appendDiagnosticLog(join(blocked, 'logs', 'runtime.log'), '1', 'lost'),
  );
});

test('C14: isolates samples per window and cleans up closed windows without leaking', async () => {
  const entries: string[] = [];
  const state = {
    at: 2_000_000,
    mainMb: 2500,
    popoutMb: 120,
    mainPid: 101,
    popoutPid: 202,
  };
  const diagnostics = createWindowDiagnostics({
    log: (text) => entries.push(text),
    windowPids: () => [state.mainPid, state.popoutPid].filter((p) => p > 0),
    metrics: () => [
      { pid: 101, memory: { workingSetSize: state.mainMb * 1024 } },
      { pid: 202, memory: { workingSetSize: state.popoutMb * 1024 } },
    ],
    now: () => state.at,
    every: () => {},
  });

  const mainWin = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), {
      id: 1,
      getOSProcessId: () => state.mainPid,
    }),
  });
  const popoutWin = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), {
      id: 2,
      getOSProcessId: () => state.popoutPid,
    }),
  });

  diagnostics.watch('main', mainWin);
  diagnostics.watch('popout', popoutWin);
  diagnostics.sample();
  state.at += 30_000;
  diagnostics.sample();

  popoutWin.webContents.emit('render-process-gone', undefined, {
    reason: 'crashed',
    exitCode: 9,
  });
  const popoutLog = entries.find((entry) =>
    entry.startsWith('window popout renderer gone:'),
  );
  assert.ok(popoutLog, 'logged popout crash');
  assert.match(popoutLog, /highest 120 MB/);
  assert.doesNotMatch(popoutLog, /window 2500 MB/);

  // Main window must keep its own trajectory after popout crashes.
  state.at += 30_000;
  mainWin.webContents.emit('render-process-gone', undefined, {
    reason: 'oom',
    exitCode: 133,
  });
  const mainLog = entries.find((entry) =>
    entry.startsWith('window main renderer gone:'),
  );
  assert.ok(mainLog, 'logged main crash');
  assert.match(mainLog, /highest 2500 MB/);
  assert.match(mainLog, /window 2500 MB/);

  // 200 closed popout windows must be GC-eligible after emitting closed.
  const spawnClosed = (i: number) => {
    const ephemeral = Object.assign(new EventEmitter(), {
      webContents: Object.assign(new EventEmitter(), {
        id: 1000 + i,
        getOSProcessId: () => 5000 + i,
      }),
    });
    const ref = new WeakRef(ephemeral);
    diagnostics.watch(`popout-${i}`, ephemeral);
    ephemeral.emit('closed');
    assert.equal(ephemeral.listenerCount('unresponsive'), 0);
    assert.equal(ephemeral.listenerCount('responsive'), 0);
    assert.equal(ephemeral.webContents.listenerCount('render-process-gone'), 0);
    return ref;
  };
  const refs = Array.from({ length: 200 }, (_, i) => spawnClosed(i));
  await new Promise((resolve) => setImmediate(resolve));
  v8.setFlagsFromString('--expose_gc');
  const gc = vm.runInNewContext('gc') as () => void;
  gc();
  gc();
  const alive = refs.filter((ref) => ref.deref() !== undefined).length;
  assert.equal(alive, 0, `${alive} closed windows stayed strongly referenced`);
});

test('C21: caches live OS PID across crash, records metrics breakdown and renderer heap/Blink, and persists samples to disk', () => {
  const folder = mkdtempSync(join(tmpdir(), 'circle-win-diag-c21-'));
  try {
    const snapshotFile = join(folder, 'logs', 'window-samples.json');
    const entries: string[] = [];
    let currentPid = 707;
    const diagnostics = createWindowDiagnostics({
      log: (text) => entries.push(text),
      windowPids: () => (currentPid > 0 ? [currentPid] : []),
      metrics: () => [
        {
          pid: 707,
          memory: {
            workingSetSize: 512 * 1024,
            peakWorkingSetSize: 640 * 1024,
            privateBytes: 400 * 1024,
          },
        },
      ],
      snapshotFile,
      now: () => 3_000_000,
      every: () => {},
    });

    const win = Object.assign(new EventEmitter(), {
      webContents: Object.assign(new EventEmitter(), {
        id: 77,
        getOSProcessId: () => currentPid,
      }),
    });
    diagnostics.watch('popout', win);
    diagnostics.rendererMemory?.(77, {
      jsHeapMb: 95,
      jsHeapLimitMb: 2048,
      blinkAllocatedMb: 42,
    });
    diagnostics.sample();

    assert.equal(
      existsSync(snapshotFile),
      true,
      'snapshot persisted on sample',
    );
    const persisted = JSON.parse(readFileSync(snapshotFile, 'utf8')) as {
      windows: Record<
        string,
        {
          name: string;
          pid: number;
          highestMb: number;
          samples: Array<{
            windowMb: number;
            privateMb?: number;
            peakMb?: number;
            renderer?: {
              jsHeapMb: number;
              jsHeapLimitMb: number;
              blinkAllocatedMb: number;
            };
          }>;
        }
      >;
    };
    const record = persisted.windows['77'];
    assert.ok(record, 'window id stored in snapshot');
    assert.equal(record.pid, 707);
    assert.equal(record.highestMb, 512);
    assert.equal(record.samples.at(-1)?.privateMb, 400);
    assert.equal(record.samples.at(-1)?.peakMb, 640);
    assert.equal(record.samples.at(-1)?.renderer?.jsHeapMb, 95);
    assert.equal(record.samples.at(-1)?.renderer?.blinkAllocatedMb, 42);

    // Electron returns 0 from getOSProcessId() once the renderer process dies.
    currentPid = 0;
    win.webContents.emit('render-process-gone', undefined, {
      reason: 'oom',
      exitCode: 133,
    });
    assert.equal(entries.length, 1);
    assert.match(entries[0], /highest 512 MB/);
    assert.match(entries[0], /private 400 MB/);
    assert.match(entries[0], /peak 640 MB/);
    assert.match(entries[0], /heap 95\/2048 MB/);
    assert.match(entries[0], /blink 42 MB/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
