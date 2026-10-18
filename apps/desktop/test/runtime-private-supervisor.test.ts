import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { RuntimeSupervisor as Supervisor } from '../src/runtime-supervisor.ts';
import type { WorkspaceServiceEvent } from '../src/workspace-protocol.ts';

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
  run: (supervisor: Supervisor, child: Child) => Promise<void>,
) {
  const child = new Child();
  globals.__circleUtilityFork = () => {
    queueMicrotask(() =>
      child.emit('message', {
        type: 'update',
        update: {
          seq: 1,
          connected: true,
          snapshot: { sessions: [], runtime: { connected: true } },
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
    RuntimeSupervisor: new (home: string, directory: string) => Supervisor;
  };
  const supervisor = new RuntimeSupervisor(
    '/synthetic/home',
    '/synthetic/application',
  );
  try {
    await supervisor.start();
    await run(supervisor, child);
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
