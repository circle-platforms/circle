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
