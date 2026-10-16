import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  'browser close verifies actual descendants when a process group existence probe is refused',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = scratch(t);
    const fixture = await cancellationFixture(t, root);
    writeFileSync(
      join(root, 'grandchild.cjs'),
      readFileSync(join(root, 'grandchild.cjs'), 'utf8') +
        "\nprocess.on('SIGTERM',()=>{});\n",
    );
    const child = spawn(process.execPath, [join(root, 'parent.cjs')], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
    });
    const browser = browserWithChild(child);
    cleanup(t, () => browser.close());
    await fixture.ready();
    const kill = process.kill.bind(process);
    const probe = t.mock.method(
      process,
      'kill',
      (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -child.pid! && signal === 0)
          throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        return kill(pid, signal);
      },
    );
    try {
      await browser.close();
    } finally {
      probe.mock.restore();
    }
    assert(child.exitCode !== null || child.signalCode !== null);
    assert.equal(await fixture.release(), 'closed');
    assert.equal(existsSync(join(root, 'late')), false);
  },
);

test(
  'refused descendant termination keeps browser cleanup retryable until the actual process exits',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = scratch(t);
    const fixture = await cancellationFixture(t, root);
    writeFileSync(
      join(root, 'grandchild.cjs'),
      readFileSync(join(root, 'grandchild.cjs'), 'utf8') +
        "\nprocess.on('SIGTERM',()=>{});\n",
    );
    const child = spawn(process.execPath, [join(root, 'parent.cjs')], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
    });
    const browser = browserWithChild(child);
    const state = browser as any;
    let closed = false;
    state.cdp.close = () => {
      closed = true;
    };
    cleanup(t, () => browser.close());
    const { pid: descendant } = await fixture.ready();
    const kill = process.kill.bind(process);
    const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    const stop = t.mock.method(
      process,
      'kill',
      (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -child.pid! && signal === 'SIGKILL') throw denied;
        return kill(pid, signal);
      },
    );
    try {
      await assert.rejects(browser.close(), denied);
      assert.equal(closed, false);
      assert.equal(
        kill(descendant, 0),
        true,
        'the owned descendant is still alive',
      );
    } finally {
      stop.mock.restore();
    }
    await browser.close();
    assert.equal(closed, true);
    assert.equal(await fixture.release(), 'closed');
    assert.equal(existsSync(join(root, 'late')), false);
  },
);

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

function liveChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 1_073_741_824,
    exitCode: null as number | null,
    signalCode: null,
  }) as unknown as ChildProcess;
}

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

test(
  'permission-denied group probes still verify actual owned processes and exit',
  { skip: process.platform === 'win32' },
  async (t) => {
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
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
    const kill = process.kill.bind(process);
    t.mock.method(
      process,
      'kill',
      (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -child.pid! && signal === 0)
          throw Object.assign(new Error('probe denied'), { code: 'EPERM' });
        return kill(pid, signal);
      },
    );
    const browser = browserWithChild(child);
    assert.equal(
      await (browser as any).groupRunning(child.pid),
      true,
      'EPERM must not mean exited',
    );
    await browser.close();
    assert.notEqual(child.signalCode, null);
    assert.equal(
      await (browser as any).groupRunning(child.pid),
      false,
      'ps confirms no runnable member after actual exit',
    );
  },
);

test(
  'permission-denied termination retains owned groups for retry',
  { skip: process.platform === 'win32' },
  async (t) => {
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    cleanup(t, () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    const kill = process.kill.bind(process);
    t.mock.method(
      process,
      'kill',
      (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -child.pid!)
          throw Object.assign(new Error('termination denied'), {
            code: 'EPERM',
          });
        return kill(pid, signal);
      },
    );
    const browser = new ChromeBrowser({
      executable: process.execPath,
      closeTimeout: 40,
    });
    const state = browser as any;
    state.cdp = {
      close: () => {
        throw new Error('must not confirm cleanup');
      },
    };
    state.processGroups.add(child.pid);
    await assert.rejects(browser.close(), /termination denied/);
    assert.equal(state.processGroups.has(child.pid), true);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  },
);

test(
  'a denied probe with unavailable process inspection cannot confirm exit',
  { skip: process.platform === 'win32' },
  async (t) => {
    const originalPath = process.env.PATH;
    process.env.PATH = scratch(t);
    t.after(() => {
      process.env.PATH = originalPath;
    });
    t.mock.method(process, 'kill', () => {
      throw Object.assign(new Error('probe denied'), { code: 'EPERM' });
    });
    const browser = new ChromeBrowser({ executable: process.execPath });
    await assert.rejects((browser as any).groupRunning(1_073_741_824), {
      code: 'ENOENT',
    });
  },
);

test(
  'process inspection has its own bounded budget when the browser exit grace period is shorter than ps startup',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = scratch(t);
    const marker = join(root, 'inspection-started');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      join(root, 'ps'),
      `#!/bin/sh\nprintf '%s' "$$" > ${quote(marker)}\n/bin/sleep 0.12\nexec /bin/ps "$@"\n`,
      { mode: 0o755 },
    );
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    const browser = new ChromeBrowser({
      executable: process.execPath,
      closeTimeout: 40,
      processInspectionTimeout: 1000,
    });
    const owned = browser as any;
    owned.processGroups.add(child.pid);
    owned.cdp = { close: () => {} };
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = root;
      const started = Date.now();
      assert.equal(await owned.groupRunning(child.pid), true);
      assert.ok(Date.now() - started >= 100, 'the actual delayed ps ran');
      assert.ok(existsSync(marker), 'the inspection process really started');
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      await browser.close();
      await exited;
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(owned.processGroups.has(child.pid), false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await exited;
    }
  },
);

test(
  'a never-ending process inspector fails within its bound and retains the real browser group for a successful close retry',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = join(scratch(t), 'inspection fixture with spaces');
    mkdirSync(root);
    const inspectorPid = join(root, 'inspector.pid');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    // Record the actual inspector PID before blocking on its open stdin pipe.
    // Ignore TERM so a timeout that only sends TERM still fails this regression.
    writeFileSync(
      join(root, 'ps'),
      `#!/bin/sh\ntrap '' TERM\nprintf '%s' "$$" > ${quote(inspectorPid)}\nexec /bin/cat\n`,
      { mode: 0o755 },
    );
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    const browser = new ChromeBrowser({
      executable: process.execPath,
      closeTimeout: 1000,
      processInspectionTimeout: 1000,
    });
    const owned = browser as any;
    let closed = false;
    owned.processGroups.add(child.pid);
    owned.cdp = {
      close: () => {
        closed = true;
      },
    };
    const previousPath = process.env.PATH;
    let closing: Promise<void> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const restorePath = () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    };
    try {
      process.env.PATH = root;
      closing = browser.close();
      const outcome = await Promise.race([
        closing.then(
          () => ({ status: 'closed' as const }),
          (error: any) => ({ status: 'failed' as const, error }),
        ),
        new Promise<{ status: 'blocked' }>((resolve) => {
          watchdog = setTimeout(() => resolve({ status: 'blocked' }), 2000);
        }),
      ]);
      assert.equal(
        outcome.status,
        'failed',
        'a stuck ps must fail instead of hanging or confirming exit',
      );
      if (outcome.status !== 'failed') return;
      assert.equal(outcome.error.killed, true);
      assert.equal(outcome.error.signal, 'SIGKILL');
      assert.equal(closed, false);
      assert.equal(owned.processGroups.has(child.pid), true);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.ok(
        existsSync(inspectorPid),
        'the real inspector fixture started and never exited by itself',
      );
      const pid = Number(readFileSync(inspectorPid, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      restorePath();
      await browser.close();
      await exited;
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(owned.processGroups.has(child.pid), false);
      assert.equal(closed, true);
    } finally {
      clearTimeout(watchdog);
      restorePath();
      if (existsSync(inspectorPid)) {
        try {
          process.kill(Number(readFileSync(inspectorPid, 'utf8')), 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await closing?.catch(() => {});
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await exited;
    }
  },
);
