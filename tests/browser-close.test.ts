import assert from 'node:assert/strict';
import childProcess, { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { AgentRuntime } from '../src/runtime.js';
import { SessionRuntimeManager } from '../src/session_manager.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { cancellationFixture, cleanup, scratch } from './helpers.js';

function browserWithChild(child: ChildProcess) {
  const browser = new ChromeBrowser({
    executable: process.execPath,
    closeTimeout: 40,
  });
  const state = browser as any;
  state.child = child;
  state.cdp = { send: async () => {}, close: () => {} };
  return browser;
}

test('browser close waits for its actual owned descendant to exit before returning', async (t) => {
  const root = scratch(t);
  const fixture = await cancellationFixture(t, root);
  if (process.platform !== 'win32')
    writeFileSync(
      join(root, 'grandchild.cjs'),
      readFileSync(join(root, 'grandchild.cjs'), 'utf8') +
        "\nprocess.on('SIGTERM',()=>{});\n",
    );
  const child = spawn(process.execPath, [join(root, 'parent.cjs')], {
    cwd: root,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  const browser = browserWithChild(child);
  cleanup(t, () => browser.close());
  await fixture.ready();
  const closing = browser.close();
  assert.equal(
    browser.close(),
    closing,
    'simultaneous closes share one cleanup',
  );
  await closing;
  assert(child.exitCode !== null || child.signalCode !== null);
  assert.equal(await fixture.release(), 'closed');
});

test(
  'browser close escalates an ignored graceful signal and awaits the actual exit',
  { skip: process.platform === 'win32' },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    cleanup(t, () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    const browser = browserWithChild(child);
    await browser.close();
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(child.exitCode, null);
  },
);

test('browser cleanup failure rejects and remains retryable instead of confirming deletion', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 1_073_741_824,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => false,
  }) as unknown as ChildProcess;
  const browser = browserWithChild(child);
  await assert.rejects(
    browser.close(),
    /browser process did not stop|taskkill/i,
  );
  (child as unknown as { exitCode: number | null }).exitCode = 0;
  child.emit('exit', 0, null);
  await browser.close();
});

for (const live of [false, true])
  test(`browser close checks an EPERM process-group probe for ${live ? 'live members and preserves a refused cleanup' : 'zombies before confirming exit'}`, async (t) => {
    const pid = 1_073_741_824;
    const probeError = Object.assign(new Error('group probe refused'), {
      code: 'EPERM',
    });
    const forceError = Object.assign(new Error('forced group stop refused'), {
      code: 'EPERM',
    });
    const signals: (number | NodeJS.Signals | undefined)[] = [];
    let running = live;
    let tableChecks = 0;
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    t.mock.method(
      process,
      'kill',
      (target: number, signal?: NodeJS.Signals | number) => {
        assert.equal(target, -pid);
        signals.push(signal);
        if (signal === 0) throw probeError;
        assert.equal(signal, 'SIGKILL');
        throw forceError;
      },
    );
    t.mock.method(childProcess, 'execFile', ((
      file: string,
      args: readonly string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      assert.equal(file, 'ps');
      assert.deepEqual(args, ['-A', '-o', 'pgid=,stat=']);
      tableChecks++;
      callback(null, `${pid} Z\n${pid} ${running ? 'S' : 'Z'}\n`, '');
      return new EventEmitter() as ChildProcess;
    }) as unknown as typeof childProcess.execFile);
    syncBuiltinESMExports();
    const browser = new ChromeBrowser({ executable: process.execPath });
    const state = browser as any;
    state.processGroups.add(pid);
    let closed = false;
    state.cdp = { close: () => (closed = true) };
    if (live) {
      await assert.rejects(browser.close(), forceError);
      assert.equal(state.processGroups.has(pid), true);
      assert.equal(closed, false);
      assert.deepEqual(signals, [0, 'SIGKILL']);
      running = false;
    }
    await browser.close();
    assert.equal(state.processGroups.has(pid), false);
    assert.equal(closed, true);
    assert.equal(tableChecks, live ? 2 : 1);
    assert.deepEqual(signals, live ? [0, 'SIGKILL', 0] : [0]);
  });

function liveChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 1_073_741_824,
    exitCode: null as number | null,
    signalCode: null,
  }) as unknown as ChildProcess;
}

test('browser close awaits actual exit when forced termination reports failure before the exit event', async () => {
  const child = liveChild();
  const browser = browserWithChild(child);
  const state = browser as any;
  const attempts: boolean[] = [];
  let closed = false;
  let exited = false;
  state.cdp.close = () => {
    assert.equal(exited, true);
    closed = true;
  };
  state.stopProcess = async (_child: ChildProcess, force: boolean) => {
    attempts.push(force);
    if (force)
      setImmediate(() => {
        assert.equal(closed, false);
        exited = true;
        (child as unknown as { exitCode: number | null }).exitCode = 1;
        child.emit('exit', 1, null);
      });
    throw new Error('termination command failed before the exit event');
  };
  await browser.close();
  assert.deepEqual(attempts, [false, true]);
  assert.equal(exited, true);
  assert.equal(closed, true);
  assert.notEqual(child.exitCode, null);
});

test('a child process error without exit does not confirm browser cleanup', async () => {
  const child = liveChild();
  const browser = browserWithChild(child);
  const waiting: Promise<boolean> = (browser as any).waitForExit(child, 40);
  child.emit('error', new Error('termination refused'));
  assert.equal(await waiting, false);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test('browser close escalates a refused graceful termination instead of rejecting before force', async () => {
  const child = liveChild();
  const browser = browserWithChild(child);
  const state = browser as any;
  const attempts: boolean[] = [];
  let closed = false;
  state.cdp.close = () => {
    closed = true;
  };
  state.stopProcess = async (_child: ChildProcess, force: boolean) => {
    attempts.push(force);
    if (!force)
      throw new Error(
        'the process can only be terminated forcefully (with /F)',
      );
    (child as unknown as { exitCode: number | null }).exitCode = 1;
    child.emit('exit', 1, null);
  };
  await browser.close();
  assert.deepEqual(attempts, [false, true]);
  assert.notEqual(child.exitCode, null);
  assert.equal(closed, true);
});

test('refused forced browser termination retains session history until a successful deletion retry', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const child = liveChild();
  const browser = browserWithChild(child);
  const state = browser as any;
  const forcedError = new Error('forced termination refused');
  const attempts: boolean[] = [];
  let refuseForce = true;
  let closed = false;
  state.cdp.close = () => {
    closed = true;
  };
  state.stopProcess = async (_child: ChildProcess, force: boolean) => {
    attempts.push(force);
    if (!force) throw new Error('graceful termination refused');
    if (refuseForce) throw forcedError;
    (child as unknown as { exitCode: number | null }).exitCode = 1;
    child.emit('exit', 1, null);
  };
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model: new ScriptedModel([
      { message: { id: 'answer', role: 'assistant', content: 'saved answer' } },
    ]),
    headless: true,
    beforeDelete: () => browser.close(),
  });
  const sessions = new SessionRuntimeManager(() => {
    throw new Error('unexpected runtime creation');
  });
  sessions.register(runtime);
  cleanup(t, () => sessions.close());
  await runtime.harness.run('keep this history until the browser stops');
  const id = runtime.session.id;
  const messages = runtime.store.messages(id);
  await assert.rejects(sessions.delete(id, { confirmed: true }), forcedError);
  assert.deepEqual(attempts, [false, true]);
  assert.equal(closed, false);
  assert.equal(child.exitCode, null);
  assert.equal(sessions.lifecycle(id), 'deleting');
  assert(runtime.store.get(id));
  assert.deepEqual(runtime.store.messages(id), messages);
  refuseForce = false;
  await sessions.delete(id, { confirmed: true });
  assert.deepEqual(attempts, [false, true, false, true]);
  assert.equal(closed, true);
  assert.equal(sessions.lifecycle(id), 'deleted');
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  assert.equal(store.get(id), undefined);
});
