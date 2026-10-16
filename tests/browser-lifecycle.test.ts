import assert from 'node:assert/strict';
import childProcesses, { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { cleanup, scratch } from './helpers.js';
import { ownedStartupBrowser } from './browser-startup-fixture.js';

async function stopOwned(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('an operation error from a living owned child is not an observed exit', async (t) => {
  const root = scratch(t);
  const child = spawn(
    process.execPath,
    ['-e', "process.send('ready'); process.on('message', () => {});"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  cleanup(t, () => stopOwned(child));
  await once(child, 'message');
  const browser = new ChromeBrowser({
    executable: process.execPath,
    trustFile: join(root, 'trust.json'),
  });
  const waiting = (browser as any).waitForExit(child, 30);
  child.emit(
    'error',
    Object.assign(Error('fixture operation refused'), { code: 'EPERM' }),
  );
  assert.equal(await waiting, false);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(process.kill(child.pid!, 0), true);
  assert.equal(child.listenerCount('error'), 0);
});

test('a Windows normal termination helper can finish beyond the browser exit wait', async (t) => {
  const root = scratch(t);
  const browser = new ChromeBrowser({
    executable: process.execPath,
    trustFile: join(root, 'trust.json'),
    closeTimeout: 40,
  });
  const execute = childProcesses.execFile;
  let helper: ChildProcess | undefined;
  let options: any;
  let readyObserved = false;
  let releaseRequested = false;
  let ready!: () => void;
  const prepared = new Promise<void>((resolve) => {
    ready = resolve;
  });
  t.mock.method(
    childProcesses,
    'execFile',
    (file: any, args: any, ...rest: any[]) => {
      if (file !== 'taskkill') return (execute as any)(file, args, ...rest);
      options = typeof rest[0] === 'object' ? rest[0] : undefined;
      helper = (execute as any)(
        process.execPath,
        [
          '-e',
          "process.stdin.once('data', () => process.exit(0)); process.stdout.write('ready');",
        ],
        ...rest,
      );
      helper!.stdout!.once('data', () => {
        readyObserved = true;
        ready();
      });
      return helper!;
    },
  );
  syncBuiltinESMExports();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const stopping = (browser as any).stopProcess(
    { pid: 1_073_741_824, exitCode: null, signalCode: null },
    true,
  ) as Promise<void>;
  void stopping.catch(() => {});
  try {
    await Promise.race([
      prepared,
      stopping.then(() => {
        throw Error('the helper completed before its release gate');
      }),
    ]);
    // The parent withholds completion after readiness for longer than the exit
    // observation budget. No command is retried and no machine-speed guess is used.
    await delay(60);
    assert(helper);
    assert.equal(
      helper.exitCode,
      null,
      'the helper is still waiting for its parent',
    );
    assert.equal(
      helper.signalCode,
      null,
      'the browser exit wait must not kill the helper',
    );
    releaseRequested = true;
    helper.stdin!.end('release');
    await stopping;
    assert.equal(helper.exitCode, 0);
    assert.equal(helper.signalCode, null);
    assert.equal(options.timeout, 3000);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    if (helper) await stopOwned(helper);
    await stopping.catch(() => {});
    t.mock.restoreAll();
    syncBuiltinESMExports();
    t.diagnostic(
      JSON.stringify({
        readyObserved,
        releaseRequested,
        browserExitWaitMs: 40,
        helperTimeoutMs: options?.timeout,
        helperExitCode: helper?.exitCode,
        helperSignal: helper?.signalCode,
      }),
    );
  }
});

test('a Windows taskkill helper has an independent three-second bound and actually exits when it never answers', async (t) => {
  const root = scratch(t);
  const browser = new ChromeBrowser({
    executable: process.execPath,
    trustFile: join(root, 'trust.json'),
    closeTimeout: 40,
  });
  const state = browser as any;
  const execute = childProcesses.execFile;
  let helper: ChildProcess | undefined;
  let options: any;
  t.mock.method(
    childProcesses,
    'execFile',
    (file: any, args: any, ...rest: any[]) => {
      if (file !== 'taskkill') return (execute as any)(file, args, ...rest);
      options = typeof rest[0] === 'object' ? rest[0] : undefined;
      helper = (execute as any)(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        ...rest,
      );
      return helper!;
    },
  );
  syncBuiltinESMExports();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const child = { pid: 1_073_741_824, exitCode: null, signalCode: null };
  const stopping = state.stopProcess(child, true);
  void stopping.catch(() => {});
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(
      options?.timeout,
      3000,
      'the helper deadline is independent of the browser exit wait',
    );
    await assert.rejects(
      Promise.race([
        stopping,
        new Promise((_resolve, reject) => {
          watchdog = setTimeout(
            () =>
              reject(Error('fixture watchdog: taskkill helper stayed alive')),
            5000,
          );
        }),
      ]),
      (error) => {
        assert(error instanceof Error);
        assert.doesNotMatch(error.message, /fixture watchdog/);
        return true;
      },
    );
    assert.equal(options.timeout, 3000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert(helper);
    assert(helper.exitCode !== null || helper.signalCode !== null);
    assert.equal(helper.killed, true);
  } finally {
    clearTimeout(watchdog);
    Object.defineProperty(process, 'platform', platform);
    if (helper) await stopOwned(helper);
    await stopping.catch(() => {});
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

for (const helperExitCode of [0, 7])
  test(
    helperExitCode === 0
      ? 'a successful forced tree helper is followed by one native owned-root stop when the root stays alive'
      : 'a failed forced tree helper preserves its error without a native-root stop',
    async (t) => {
      const fixture = ownedStartupBrowser(t, 'unused', false, undefined, 40);
      const state = fixture.browser as any;
      await state.start();
      const child = fixture.child();
      const nativeStop = t.mock.method(child, 'kill', child.kill.bind(child));
      const execute = childProcesses.execFile;
      const helpers: ChildProcess[] = [];
      const treeStops: string[][] = [];
      t.mock.method(
        childProcesses,
        'execFile',
        (file: any, args: any, ...rest: any[]) => {
          if (file !== 'taskkill') return (execute as any)(file, args, ...rest);
          treeStops.push(args);
          // A real helper reports a known result without changing the owned root.
          const helper = (execute as any)(
            process.execPath,
            ['-e', `process.exit(${helperExitCode})`],
            ...rest,
          ) as ChildProcess;
          helpers.push(helper);
          return helper;
        },
      );
      syncBuiltinESMExports();
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      state.processGroups.clear();
      try {
        if (helperExitCode === 0) {
          await fixture.browser.close();
          assert(child.exitCode !== null || child.signalCode !== null);
        } else {
          await assert.rejects(fixture.browser.close(), (error) => {
            assert(error instanceof Error);
            assert.equal((error as any).code, helperExitCode);
            return true;
          });
          assert.equal(child.exitCode, null);
          assert.equal(child.signalCode, null);
        }
        assert.deepEqual(treeStops, [
          ['/PID', String(child.pid), '/T'],
          ['/PID', String(child.pid), '/T', '/F'],
        ]);
        assert.equal(nativeStop.mock.callCount(), helperExitCode === 0 ? 1 : 0);
        if (helperExitCode === 0)
          assert.deepEqual(nativeStop.mock.calls[0]!.arguments, ['SIGKILL']);
        assert.equal(helpers.length, 2);
        assert(
          helpers.every(
            (helper) =>
              helper.exitCode === helperExitCode && helper.signalCode === null,
          ),
        );
      } finally {
        t.diagnostic(
          JSON.stringify({
            treeHelperCalls: treeStops.length,
            helperExitCodes: helpers.map((helper) => helper.exitCode),
            nativeStopsBeforeSafety: nativeStop.mock.callCount(),
            rootExitObservedBeforeSafety:
              child.exitCode !== null || child.signalCode !== null,
          }),
        );
        Object.defineProperty(process, 'platform', platform);
        await stopOwned(child);
        for (const helper of helpers) await stopOwned(helper);
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    },
  );

for (const exitsAfterHelperError of [true, false])
  test(
    exitsAfterHelperError
      ? 'a failed Windows force helper still waits for its owned root to exit after the callback'
      : 'a failed Windows force helper retains its original error and live root after the exit wait',
    async (t) => {
      const timeout = exitsAfterHelperError ? 1000 : 40;
      const fixture = ownedStartupBrowser(
        t,
        'unused',
        false,
        undefined,
        timeout,
      );
      const state = fixture.browser as any;
      await state.start();
      const child = fixture.child();
      const nativeStop = t.mock.method(child, 'kill', child.kill.bind(child));
      const actualWait = state.waitForExit.bind(state);
      const waits: number[] = [];
      const stops: boolean[] = [];
      const helpers: ChildProcess[] = [];
      let forceError: unknown;
      let forceCallbackDelivered = false;
      t.mock.method(
        state,
        'waitForExit',
        (owned: ChildProcess, budget: number) => {
          assert.equal(owned, child);
          waits.push(budget);
          // Model the two already-expired earlier phases. The post-force phase
          // below uses the real listener and its unchanged exit-observation budget.
          if (waits.length < 3) return Promise.resolve(false);
          assert.equal(forceCallbackDelivered, true);
          assert.equal(child.exitCode, null);
          assert.equal(child.signalCode, null);
          const waiting = actualWait(owned, budget);
          if (exitsAfterHelperError) child.send({ exit: true });
          return waiting;
        },
      );
      t.mock.method(
        state,
        'stopProcess',
        (owned: ChildProcess, force: boolean) => {
          assert.equal(owned, child);
          stops.push(force);
          return new Promise<void>((_resolve, reject) => {
            const helper = childProcesses.execFile(
              process.execPath,
              ['-e', 'process.exit(7)'],
              { timeout: 3000, windowsHide: true },
              (error) => {
                assert(error);
                if (force) {
                  assert.equal(child.exitCode, null);
                  assert.equal(child.signalCode, null);
                  forceError = error;
                  forceCallbackDelivered = true;
                }
                reject(error);
              },
            );
            helpers.push(helper);
          });
        },
      );
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      state.processGroups.clear();
      try {
        if (exitsAfterHelperError) {
          await fixture.browser.close();
          assert.equal(child.exitCode, 23);
          assert.equal(child.signalCode, null);
          assert.equal(state.ownedRoots.has(child), false);
        } else {
          await assert.rejects(
            fixture.browser.close(),
            (error) => error === forceError,
          );
          assert.equal(child.exitCode, null);
          assert.equal(child.signalCode, null);
          assert.equal(process.kill(child.pid!, 0), true);
          assert.equal(state.ownedRoots.has(child), true);
        }
        assert.deepEqual(waits, [timeout, Math.min(timeout, 1000), timeout]);
        assert.deepEqual(stops, [false, true]);
        assert.equal(nativeStop.mock.callCount(), 0);
        assert.equal(helpers.length, 2);
        assert(helpers.every((helper) => helper.exitCode === 7));
      } finally {
        Object.defineProperty(process, 'platform', platform);
        await stopOwned(child);
        for (const helper of helpers) await stopOwned(helper);
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    },
  );

test('closing after a broken protocol and a new launch stops both owned roots', async (t) => {
  const fixture = ownedStartupBrowser(t, 'unused', false, undefined, 40);
  const state = fixture.browser as any;
  const roots: ChildProcess[] = [];
  cleanup(t, async () => {
    for (const child of roots) await stopOwned(child);
  });
  await state.start();
  roots.push(fixture.child());
  state.cdp.close();
  assert.equal(roots[0]!.exitCode, null);
  await state.start();
  roots.push(fixture.child());
  assert.notEqual(roots[0], roots[1]);
  // Isolate root ownership from the separate POSIX descendant-group safeguard.
  state.processGroups.clear();
  state.groupRunning = async () => false;
  state.stopProcess = async (child: ChildProcess) => stopOwned(child);
  await fixture.browser.close();
  assert.equal(
    roots.every(
      (child) => child.exitCode !== null || child.signalCode !== null,
    ),
    true,
    'every spawned root must be observed exiting',
  );
});

test('a failed owned root does not prevent stopping the others and remains owned for a later close', async (t) => {
  const fixture = ownedStartupBrowser(t, 'unused', false, undefined, 40);
  const state = fixture.browser as any;
  const roots: ChildProcess[] = [];
  cleanup(t, async () => {
    for (const child of roots) await stopOwned(child);
  });
  await state.start();
  roots.push(fixture.child());
  state.cdp.close();
  await state.start();
  roots.push(fixture.child());
  state.processGroups.clear();
  state.processGroups.add(roots[0]!.pid);
  state.groupRunning = async (pid: number) =>
    pid === roots[0]!.pid &&
    roots[0]!.exitCode === null &&
    roots[0]!.signalCode === null;
  let refuse = true;
  const failure = Error('fixture owned root termination refused');
  let repeatedGroupStops = 0;
  const kill = process.kill.bind(process);
  t.mock.method(
    process,
    'kill',
    (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -roots[0]!.pid! && signal === 'SIGKILL') {
        repeatedGroupStops++;
        throw failure;
      }
      return kill(pid, signal);
    },
  );
  state.stopProcess = async (child: ChildProcess) => {
    if (child === roots[0] && refuse) throw failure;
    await stopOwned(child);
  };
  await assert.rejects(fixture.browser.close(), (error) => error === failure);
  assert.equal(
    repeatedGroupStops,
    0,
    'the same failed group stop is not retried in this cleanup',
  );
  assert.equal(roots[0]!.exitCode, null);
  assert.equal(roots[0]!.signalCode, null);
  assert(roots[1]!.exitCode !== null || roots[1]!.signalCode !== null);
  refuse = false;
  await fixture.browser.close();
  assert(roots[0]!.exitCode !== null || roots[0]!.signalCode !== null);
});
