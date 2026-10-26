import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { RuntimeSupervisor as Supervisor } from '../src/runtime-supervisor.ts';
import type { WorkspaceServiceEvent } from '../src/workspace-protocol.ts';
import type { RuntimeUpdate } from '../src/runtime-protocol.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeRuntimeExit,
  redactRuntimeOutput,
  RUNTIME_RESTART_DELAY_MS,
} from '../src/runtime-exit.ts';
import { SESSION_LEASE_STALE_MS } from '../../../src/session_lock.ts';

class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  sent: Record<string, unknown>[] = [];
  postMessage(value: Record<string, unknown>) {
    this.sent.push(structuredClone(value));
    if (value.name === 'close')
      queueMicrotask(() =>
        this.emit('message', {
          type: 'reply',
          reply: { id: value.id, ok: true },
        }),
      );
  }
  kill() {
    this.emit('exit', 0);
  }
}
const globals = globalThis as typeof globalThis & {
  __circleUtilityFork?: () => Child;
};
async function fixture(
  run: (
    supervisor: Supervisor,
    child: Child,
    children: Child[],
  ) => Promise<void>,
  options: Record<string, unknown> = {},
  first?: Record<string, unknown>,
) {
  const children: Child[] = [];
  globals.__circleUtilityFork = () => {
    // Each start is a new process with its own token epoch.
    const child = new Child();
    const epoch = `epoch-${children.length}`;
    children.push(child);
    queueMicrotask(() =>
      child.emit('message', {
        type: 'update',
        update: {
          seq: 1,
          connected: true,
          tokenStream: { epoch, seq: 0 },
          snapshot: first ?? {
            sessions: [],
            runtime: { connected: true },
          },
        },
      }),
    );
    return child;
  };
  const bundled = await build({
    entryPoints: [
      fileURLToPath(new URL('../src/runtime-supervisor.ts', import.meta.url)),
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'isolated-utility-process',
        setup(plugin) {
          plugin.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron',
            namespace: 'test',
          }));
          plugin.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents:
              'export const utilityProcess={fork(){return globalThis.__circleUtilityFork()}}',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const { RuntimeSupervisor } = (await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}#${Math.random()}`
  )) as {
    RuntimeSupervisor: new (
      home: string,
      directory: string,
      openUrl?: (url: string) => void,
      options?: Record<string, unknown>,
    ) => Supervisor;
  };
  const supervisor = new RuntimeSupervisor(
    '/synthetic/home',
    '/synthetic/application',
    () => {},
    options,
  );
  try {
    await supervisor.start();
    await run(supervisor, children[0]!, children);
  } finally {
    await supervisor.close();
    delete globals.__circleUtilityFork;
  }
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('workspace events use independent subscribers and survive a failing consumer', () =>
  fixture(async (supervisor, child) => {
    let fullSnapshots = 0;
    supervisor.subscribe(() => fullSnapshots++);
    const events: WorkspaceServiceEvent[] = [];
    supervisor.onWorkspaceEvent(() => {
      throw Error('view gone');
    });
    const unsubscribe = supervisor.onWorkspaceEvent((event) =>
      events.push(event),
    );
    const event: WorkspaceServiceEvent = {
      workspaceId: 'w',
      sessionId: 's',
      service: 'terminal',
      resourceId: 'pty',
      epoch: 'one',
      seq: 1,
      at: 'now',
      data: { chunk: 'real event payload' },
    };
    child.emit('message', { type: 'workspace-event', event });
    assert.deepEqual(events, [event]);
    assert.equal(fullSnapshots, 0);
    unsubscribe();
    child.emit('message', {
      type: 'workspace-event',
      event: { ...event, seq: 2 },
    });
    assert.equal(events.length, 1);
    assert.equal(supervisor.state().seq, 1);
  }));
test('private credential requests execute once and never reach snapshot listeners', () =>
  fixture(async (supervisor, child) => {
    let puts = 0,
      snapshots = 0;
    const values = new Map<string, string>();
    supervisor.subscribe(() => snapshots++);
    supervisor.onCredentials({
      get: async (key) => values.get(key),
      put: async (key, value) => {
        puts++;
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    });
    const request = {
      type: 'credential-request',
      id: 'put_one',
      operation: 'put',
      key: 'github:fixture',
      value: 'fixture-secret',
    };
    child.emit('message', request);
    child.emit('message', request);
    await settle();
    child.emit('message', request);
    await settle();
    assert.equal(puts, 1);
    child.emit('message', {
      type: 'credential-request',
      id: 'get_one',
      operation: 'get',
      key: 'github:fixture',
    });
    await settle();
    assert.deepEqual(
      child.sent.find((message) => message.id === 'get_one'),
      {
        type: 'credential-reply',
        id: 'get_one',
        ok: true,
        value: 'fixture-secret',
      },
    );
    assert.equal(snapshots, 0);
    assert.equal(
      JSON.stringify(supervisor.state()).includes('fixture-secret'),
      false,
    );
  }));
test('credential completion for an exited worker cannot be delivered to a new owner', () =>
  fixture(async (supervisor, child) => {
    let complete!: (value: string) => void;
    supervisor.onCredentials({
      get: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      put: async () => {},
      delete: async () => {},
    });
    child.emit('message', {
      type: 'credential-request',
      id: 'pending',
      operation: 'get',
      key: 'fixture',
    });
    await settle();
    child.emit('exit', 1);
    complete('fixture-secret');
    await settle();
    assert.equal(
      child.sent.some((message) => message.id === 'pending'),
      false,
    );
  }));

test('token deltas hydrate runtimeState without publishing full snapshots and deleted sessions stay deleted', () =>
  fixture(async (supervisor, child) => {
    const snapshot = {
      sessions: [{ id: 's', messages: [], branchIds: [], leafId: null }],
      runtime: { connected: true },
    };
    child.emit('message', {
      type: 'update',
      update: {
        seq: 2,
        connected: true,
        snapshot,
        tokenStream: { epoch: 'tokens', seq: 0 },
      },
    });
    let fulls = 0,
      deltas = 0;
    supervisor.subscribe(() => fulls++);
    supervisor.onTokenDelta(() => deltas++);
    child.emit('message', {
      type: 'token-delta',
      delta: {
        epoch: 'tokens',
        seq: 1,
        baseSeq: 2,
        sessionId: 's',
        streamId: 'stream',
        parentId: null,
        text: 'last visible chunk',
        at: 'now',
      },
    });
    assert.equal(fulls, 0);
    assert.equal(deltas, 1);
    assert.equal(
      supervisor.state().snapshot.sessions[0].messages[0].text,
      'last visible chunk',
    );
    child.emit('message', {
      type: 'update',
      update: {
        seq: 3,
        connected: true,
        snapshot: { ...snapshot, sessions: [] },
        tokenStream: { epoch: 'tokens', seq: 1 },
      },
    });
    child.emit('message', {
      type: 'token-delta',
      delta: {
        epoch: 'tokens',
        seq: 1,
        baseSeq: 2,
        sessionId: 's',
        streamId: 'stream',
        parentId: null,
        text: 'late duplicate',
        at: 'now',
      },
    });
    assert.equal(supervisor.state().snapshot.sessions.length, 0);
    assert.equal(deltas, 1);
  }));

test('runtime exit retires stale execution claims and rejects further commands without inventing completion', () =>
  fixture(async (supervisor, child) => {
    const running = {
      id: 'running',
      state: 'waiting',
      turn: { verb: 'working', startedAt: 1, waited: 0, tokens: 4 },
      queue: [{ id: 'q', text: 'not sent', kind: 'follow-up' }],
      messages: [
        {
          id: 'tool',
          role: 'tool',
          text: 'partial',
          tool: {
            id: 'call',
            name: 'shell',
            status: 'running',
            output: 'partial',
          },
        },
      ],
    };
    const idle = { id: 'idle', state: 'idle', messages: [], queue: [] };
    child.emit('message', {
      type: 'update',
      update: {
        seq: 2,
        connected: true,
        snapshot: {
          sessions: [running, idle],
          runtime: { connected: true, configured: true },
          agents: [
            {
              id: 'a',
              status: 'completed',
              task: { runtimeState: 'running', state: 'running' },
            },
          ],
          jobs: [
            { id: 'j', state: 'running' },
            { id: 'finished', state: 'completed' },
          ],
          interactions: [
            { id: 'approve', status: 'pending' },
            { id: 'old', status: 'recorded' },
          ],
          requests: [],
        },
      },
    });
    const command = supervisor.command({
      id: 'in-flight',
      name: 'state',
      payload: {},
    });
    const rejected = assert.rejects(command, /runtime exited/);
    child.emit('exit', 9);
    await rejected;
    const state = supervisor.state();
    assert.equal(state.connected, false);
    assert.equal(state.snapshot.sessions[0].state, 'paused');
    assert.equal(state.snapshot.sessions[0].turn, undefined);
    assert.equal(
      state.snapshot.sessions[0].messages[0].tool?.status,
      'unknown',
    );
    assert.equal(state.snapshot.sessions[0].messages[0].text, 'partial');
    assert.equal(
      state.snapshot.sessions[0].queue.length,
      1,
      'unsent queue is preserved for explicit recovery',
    );
    assert.equal(state.snapshot.sessions[1].state, 'idle');
    assert.equal(state.snapshot.jobs[0].state, 'interrupted');
    assert.equal(state.snapshot.jobs[1].state, 'completed');
    assert.equal(state.snapshot.agents[0].status, 'unknown');
    assert.deepEqual(
      state.snapshot.interactions.map((row) => row.id),
      ['old'],
    );
    await assert.rejects(
      supervisor.command({ id: 'later', name: 'abort', payload: {} }),
      /disconnected/,
    );
    assert.equal(running.state, 'waiting', 'source snapshot is immutable');
  }));

test('public runtime commands cannot smuggle the native file-capability message tag', () =>
  fixture(async (supervisor, child) => {
    const done = supervisor.command({
      id: 'public-with-private-tag',
      name: 'state',
      payload: {},
      type: 'external-file-capability',
      operation: 'grant',
      sessionId: 'owner',
      path: '/synthetic/external.txt',
      access: 'readwrite',
    } as Parameters<Supervisor['command']>[0]);
    const sent = child.sent.at(-1)!;
    assert.deepEqual(sent, {
      id: 'public-with-private-tag',
      name: 'state',
      payload: {},
      sessionId: 'owner',
    });
    child.emit('message', { type: 'reply', reply: { id: sent.id, ok: true } });
    await done;
  }));

test('native picker grants and revokes use a separate private worker envelope', () =>
  fixture(async (supervisor, child) => {
    const pending = supervisor.grantExternalFile(
      'owner',
      '/synthetic/external.txt',
      'readwrite',
    );
    const sent = child.sent.at(-1)!;
    assert.equal(sent.type, 'external-file-capability');
    assert.equal(sent.operation, 'grant');
    assert.equal(sent.name, undefined);
    const grant = {
      id: 'capability-id',
      sessionId: 'owner',
      path: '/synthetic/external.txt',
      access: 'readwrite',
    };
    child.emit('message', {
      type: 'reply',
      reply: { id: sent.id, ok: true, data: grant },
    });
    assert.deepEqual(await pending, grant);
    const revoke = supervisor.revokeExternalFileGrant('owner', grant.id);
    const request = child.sent.at(-1)!;
    assert.equal(request.operation, 'revoke');
    assert.equal(request.grantId, grant.id);
    child.emit('message', {
      type: 'reply',
      reply: { id: request.id, ok: true, data: { revoked: true } },
    });
    assert.deepEqual(await revoke, { revoked: true });
  }));

test('a native grant receipt arriving after timeout is revoked before it can become untracked authority', async (t) =>
  fixture(async (supervisor, child) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = supervisor.grantExternalFile(
        'owner',
        '/synthetic/external.txt',
        'read',
      );
      const sent = child.sent.at(-1)!;
      const rejected = assert.rejects(pending, /timed out/);
      t.mock.timers.tick(30_000);
      await rejected;
      child.emit('message', {
        type: 'reply',
        reply: {
          id: sent.id,
          ok: true,
          data: {
            id: 'late-capability',
            sessionId: 'owner',
            path: '/synthetic/external.txt',
            access: 'read',
          },
        },
      });
      const revoke = child.sent.at(-1)!;
      assert.equal(revoke.type, 'external-file-capability');
      assert.equal(revoke.operation, 'revoke');
      assert.equal(revoke.grantId, 'late-capability');
      child.emit('message', {
        type: 'reply',
        reply: { id: revoke.id, ok: true, data: { revoked: true } },
      });
      await settle();
    } finally {
      t.mock.timers.reset();
    }
  }));

test('exit codes say what is known: crashpad without a handler, out of memory, a plain exit', () => {
  // Issue #140: Windows reported 4294930435, crashpad's
  // kTerminationCodeNotConnectedToHandler; signed it is -36861.
  for (const code of [4294930435, -36861]) {
    const exit = describeRuntimeExit(code);
    assert.equal(exit.reason, 'crashed');
    assert.equal(exit.code, '4294930435 (0xFFFF7003)');
    assert.equal(
      exit.message,
      'Circle runtime crashed (4294930435 (0xFFFF7003))',
    );
    assert.match(exit.detail ?? '', /no crash handler is connected/);
  }
  // What Electron's utility process wrote when its heap ran out (measured on
  // Electron 44, macOS: exit code 5, the same lines on stderr).
  const stderr =
    '[39663:1019/020233.186686:ERROR:electron/shell/common/node_bindings.cc:195] OOM error in V8: MarkCompactCollector: young object promotion failed Allocation failed - JavaScript heap out of memory\n';
  assert.equal(describeRuntimeExit(4294930435, stderr).reason, 'out-of-memory');
  assert.equal(
    describeRuntimeExit(5, stderr).message,
    'Circle runtime ran out of memory (5)',
  );
  assert.equal(describeRuntimeExit(0xe0000008).reason, 'out-of-memory');
  assert.equal(describeRuntimeExit(0xc0000005).reason, 'crashed');
  assert.deepEqual(describeRuntimeExit(9), {
    reason: 'exited',
    code: '9',
    message: 'Circle runtime exited (9)',
  });
  assert.equal(describeRuntimeExit(null).code, 'unknown');
  assert.equal(
    redactRuntimeOutput(
      'Authorization: Bearer abc.def-123 api_key=sk-live-' +
        '1234567890 "token": "ghp_abcdefghijkl"',
    ).match(/abc\.def|1234567890|abcdefghijkl/g),
    null,
  );
});

test("the automatic restart waits until the dead runtime's session leases are stale", () => {
  assert(RUNTIME_RESTART_DELAY_MS > SESSION_LEASE_STALE_MS);
});

const configured = {
  sessions: [
    {
      id: 's',
      state: 'running',
      turn: { verb: 'thinking', startedAt: 1, waited: 0, tokens: 0 },
      queue: [],
      messages: [{ id: 'u', role: 'user', text: 'long task' }],
    },
  ],
  runtime: { connected: true, configured: true, hasKey: true },
};
async function scratchLog(t: import('node:test').TestContext) {
  const folder = await mkdtemp(join(tmpdir(), 'circle-runtime-log-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return join(folder, 'logs', 'runtime.log');
}

test('an unexpected exit keeps the saved connection, says why, logs stderr and restarts once', async (t) => {
  const logFile = await scratchLog(t);
  await fixture(
    async (supervisor, child, children) => {
      const updates: RuntimeUpdate[] = [];
      supervisor.subscribe((update) => updates.push(update));
      child.stderr.emit(
        'data',
        'request failed Authorization: Bearer secret-value-123\n<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n',
      );
      child.emit('exit', 4294930435);
      const stopped = supervisor.state();
      assert.equal(stopped.connected, false);
      assert.equal(stopped.snapshot.runtime?.configured, true);
      assert.equal(stopped.snapshot.runtime?.hasKey, true);
      assert.equal(stopped.snapshot.runtime?.stopped?.reason, 'out-of-memory');
      assert.equal(stopped.snapshot.runtime?.stopped?.restarting, true);
      assert.equal(
        stopped.snapshot.runtime?.error,
        'Circle runtime ran out of memory (4294930435 (0xFFFF7003))',
      );
      assert.equal(stopped.snapshot.sessions[0].state, 'paused');
      assert.equal(stopped.snapshot.sessions[0].turn, undefined);
      // The new process starts and its own snapshot replaces the stopped one.
      while (children.length < 2) await settle();
      await settle();
      const restarted = supervisor.state();
      assert.equal(restarted.connected, true);
      assert.equal(restarted.snapshot.runtime?.stopped, undefined);
      // Commands go to the new process.
      void supervisor
        .command({ id: 'after', name: 'state', payload: {} })
        .catch(() => {});
      assert.equal(children[1]!.sent.at(-1)?.id, 'after');
      const log = await readFile(logFile, 'utf8');
      assert.match(
        log,
        /runtime stopped: Circle runtime ran out of memory \(4294930435 \(0xFFFF7003\)\)/,
      );
      assert.match(log, /JavaScript heap out of memory/);
      assert.match(log, /runtime restarted/);
      assert.equal(log.includes('secret-value-123'), false);
      // A second unexpected exit soon after is not restarted again.
      children[1]!.emit('exit', 4294930435);
      for (let i = 0; i < 10; i++) await settle();
      assert.equal(children.length, 2);
      const left = supervisor.state();
      assert.equal(left.snapshot.runtime?.stopped?.restarting, false);
      assert.equal(left.snapshot.runtime?.stopped?.reason, 'crashed');
      assert.equal(left.snapshot.runtime?.configured, true);
      assert.match(
        await readFile(logFile, 'utf8'),
        /not restarted automatically/,
      );
      // The person can still start it.
      await supervisor.restart();
      assert.equal(children.length, 3);
      assert.equal(supervisor.state().connected, true);
      assert(
        updates.some((update) => update.snapshot.runtime?.stopped?.restarting),
      );
    },
    { logFile, restartDelayMs: 0, version: 'test' },
    configured,
  );
});

test('a runtime that stops while it is asked to close lets Circle quit', () =>
  fixture(async (supervisor, child) => {
    // A signal to every process of the application stops the runtime just as the main
    // process asks it to close: the close is never answered
    child.postMessage = (value) => {
      child.sent.push(structuredClone(value));
      if (value.name === 'close')
        queueMicrotask(() => child.emit('exit', null));
    };
    await supervisor.close();
    assert.equal(child.sent.at(-1)?.name, 'close');
  }));

test('a runtime that never answers its close is killed so Circle can quit', () =>
  fixture(async (supervisor, child) => {
    child.postMessage = (value) => {
      child.sent.push(structuredClone(value));
    };
    let killed = false;
    child.kill = () => {
      killed = true;
      child.emit('exit', null);
    };
    const started = Date.now();
    const clean = await supervisor.close(50);
    assert.equal(clean, false);
    assert.ok(killed);
    assert.equal(child.sent.at(-1)?.name, 'close');
    assert.ok(
      Date.now() - started < 5000,
      'the close was not bounded by its limit',
    );
  }));

test('a runtime that refuses to close is ended rather than keeping Circle up', () =>
  fixture(async (supervisor, child) => {
    child.postMessage = (value) => {
      child.sent.push(structuredClone(value));
      if (value.name === 'close')
        queueMicrotask(() =>
          child.emit('message', {
            type: 'reply',
            reply: { id: value.id, ok: false, error: 'jobs are running' },
          }),
        );
    };
    let killed = false;
    child.kill = () => {
      killed = true;
      child.emit('exit', 0);
    };
    assert.equal(await supervisor.close(50), false);
    assert.ok(killed);
  }));

test('a runtime that ignores the kill settles the close after the exit limit', () =>
  fixture(
    async (supervisor, child) => {
      child.postMessage = (value) => {
        child.sent.push(structuredClone(value));
      };
      child.kill = () => {}; // never exits; the fake child has no pid to SIGKILL
      const started = Date.now();
      const clean = await supervisor.close(50);
      assert.equal(clean, false);
      assert.ok(
        Date.now() - started < 5000,
        'the exit was not bounded by its limit',
      );
      // Lets the process go: the unanswered command's own timer is retired with it
      child.emit('exit', null);
    },
    { closeExitMs: 50 },
  ));

test('quitting while a restart waits for stale leases cancels it', async (t) => {
  const logFile = await scratchLog(t);
  const started = Date.now();
  await fixture(
    async (_supervisor, child, children) => {
      child.emit('exit', 1);
      assert.equal(children.length, 1);
    },
    { logFile, restartDelayMs: 60_000 },
    configured,
  );
  assert(Date.now() - started < 30_000, 'close did not wait for the restart');
});

test('worker exit immediately retires its compaction but not another process ownership claim', async (t) => {
  const logFile = await scratchLog(t);
  await fixture(
    async (supervisor, child) => {
      child.emit('exit', 9);
      const rows = supervisor.state().snapshot.sessions;
      assert.equal(
        rows.find((row) => row.id === 'own')!.compaction!.status,
        'interrupted',
      );
      assert.equal(
        rows.find((row) => row.id === 'own')!.compaction!.recoverable,
        true,
      );
      assert.equal(
        rows.find((row) => row.id === 'own')!.compaction!.liveTokens,
        0,
      );
      assert.equal(
        rows.find((row) => row.id === 'foreign')!.compaction!.status,
        'running',
      );
    },
    { logFile, restartDelayMs: 60000 },
    {
      ...configured,
      runtime: { ...configured.runtime, processId: 42 },
      sessions: [
        {
          ...configured.sessions[0],
          id: 'own',
          compaction: {
            operationId: 'a',
            ownerProcessId: 42,
            status: 'running',
            liveTokens: 12,
            recoverable: false,
          },
        },
        {
          ...configured.sessions[0],
          id: 'foreign',
          occupied: true,
          compaction: {
            operationId: 'b',
            ownerProcessId: 99,
            status: 'running',
            liveTokens: 8,
            recoverable: false,
          },
        },
      ],
    },
  );
});

test('what the runtime says of the terminal tabs reaches the window only when it is well formed, and a tab action is the runtime’s to answer', async (t) => {
  const logFile = await scratchLog(t);
  await fixture(
    async (supervisor, child) => {
      const updates: unknown[] = [];
      const record = (update: unknown) => void updates.push(update);
      supervisor.onTerminalTabs(record);
      const row = {
        id: 'local:abc',
        terminal: 'abc',
        ordinal: 1,
        state: 'operating',
        allowed: true,
      };
      child.emit('message', {
        type: 'terminal-tabs',
        conversation: 'c1',
        rows: [row],
      });
      // a row whose id is not its terminal's, or a conversation that is not an id
      child.emit('message', {
        type: 'terminal-tabs',
        conversation: 'c1',
        rows: [{ ...row, id: 'local:other' }],
      });
      child.emit('message', {
        type: 'terminal-tabs',
        conversation: '../c1',
        rows: [row],
      });
      assert.deepEqual(updates, [{ conversation: 'c1', rows: [row] }]);
      // a window opened later (macOS reopening the application) is told at once
      const later: unknown[] = [];
      supervisor.onTerminalTabs((update) => later.push(update));
      assert.deepEqual(later, [{ conversation: 'c1', rows: [row] }]);
      // the first window takes over again
      supervisor.onTerminalTabs(record);
      const taken = supervisor.terminalTabControl('c1', 'local:abc', 'take');
      const controls = () =>
        child.sent.filter((message) => message.type === 'terminal-tab-control');
      assert.deepEqual(
        { ...controls()[0], id: undefined },
        {
          type: 'terminal-tab-control',
          id: undefined,
          conversation: 'c1',
          session: 'local:abc',
          action: 'take',
        },
      );
      const held = { ...row, state: 'held', held: 'attach' };
      child.emit('message', {
        type: 'terminal-tab-reply',
        id: controls()[0]!.id,
        ok: true,
        rows: [held],
      });
      assert.deepEqual(await taken, [held]);
      const refused = supervisor.terminalTabControl('c1', 'local:abc', 'stop');
      child.emit('message', {
        type: 'terminal-tab-reply',
        id: controls()[1]!.id,
        ok: false,
        error: 'no terminal local:abc in this conversation',
      });
      await assert.rejects(
        refused,
        /no terminal local:abc in this conversation/,
      );
      // the runtime ends: the action under way fails and the window forgets the tabs
      const pending = supervisor.terminalTabControl(
        'c1',
        'local:abc',
        'return',
      );
      child.emit('exit', 1);
      await assert.rejects(pending, /the runtime stopped/);
      assert.equal(updates.at(-1), 'gone');
      // and a window opened after that has nothing old to show
      const afterwards: unknown[] = [];
      supervisor.onTerminalTabs((update) => afterwards.push(update));
      assert.deepEqual(afterwards, []);
    },
    { logFile, restartDelayMs: 60_000 },
    configured,
  );
});
