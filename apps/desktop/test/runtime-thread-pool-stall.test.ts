import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeSupervisor as Supervisor } from '../src/runtime-supervisor.ts';
import type { RuntimeUpdate } from '../src/runtime-protocol.ts';
import { patience } from './helpers/patience.mjs';

async function until(check: () => boolean, description: string) {
  const end = Date.now() + patience(8000);
  while (!check()) {
    if (Date.now() > end) throw Error(`timed out: ${description}`);
    await delay(10);
  }
}

/** A runtime child: it answers close, and its kill ends it as SIGKILL would. */
class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  sent: Record<string, unknown>[] = [];
  kills = 0;
  exited = false;
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
    this.kills++;
    if (this.exited) return;
    this.exited = true;
    queueMicrotask(() => this.emit('exit', 9));
  }
}
const globals = globalThis as typeof globalThis & {
  __circleUtilityFork?: () => Child;
};

async function fixture(
  run: (context: {
    supervisor: Supervisor;
    children: Child[];
    updates: RuntimeUpdate[];
    log: () => Promise<string>;
  }) => Promise<void>,
  options: Record<string, unknown> = {},
) {
  const temp = await mkdtemp(join(tmpdir(), 'circle-pool-stall-'));
  const logFile = join(temp, 'logs', 'runtime.log');
  const children: Child[] = [];
  globals.__circleUtilityFork = () => {
    const child = new Child();
    children.push(child);
    queueMicrotask(() =>
      child.emit('message', {
        type: 'update',
        update: {
          seq: children.length,
          connected: true,
          tokenStream: { epoch: `epoch-${children.length}`, seq: 0 },
          snapshot: {
            sessions: [],
            runtime: { connected: true, configured: true },
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
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}#${Math.random()}`
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
    { logFile, version: 'test', restartDelayMs: 0, ...options },
  );
  const updates: RuntimeUpdate[] = [];
  supervisor.subscribe((update) => updates.push(update));
  try {
    await supervisor.start();
    await run({
      supervisor,
      children,
      updates,
      log: () => readFile(logFile, 'utf8').catch(() => ''),
    });
  } finally {
    await supervisor.close();
    delete globals.__circleUtilityFork;
    await rm(temp, { recursive: true, force: true });
  }
}

const stall = (child: Child, waitedMs = 41_000) =>
  child.emit('message', {
    type: 'thread-pool-stalled',
    waitedMs,
    pending: {
      FSReqPromise: 50_118,
      FSReqCallback: 3,
      GetAddrInfoReqWrap: 1,
      '/Users/someone/project': 1,
    },
  });

test(
  'a runtime whose thread pool stalled is ended, said to have stopped handling files, and started again once',
  { timeout: patience(10000) },
  async () => {
    await fixture(async ({ supervisor, children, updates, log }) => {
      const first = children[0]!;
      stall(first);
      await until(() => first.exited, 'the stalled runtime was ended');
      assert.equal(first.kills, 1);
      const stopped = updates.find((update) => !update.connected);
      assert(stopped, 'the windows were told the runtime stopped');
      assert.equal(
        stopped.snapshot.runtime?.error,
        'Circle runtime stopped handling files',
      );
      assert.equal(stopped.snapshot.runtime?.stopped?.reason, 'stalled');
      assert.equal(stopped.snapshot.runtime?.stopped?.restarting, true);
      // Started again by itself, as after a crash.
      await until(
        () => children.length === 2 && supervisor.connected,
        'a new runtime is running',
      );
      const text = await log();
      assert.match(
        text,
        /runtime thread pool stalled: a file operation went unanswered for 41s · waiting: FSReqPromise 50118, FSReqCallback 3, GetAddrInfoReqWrap 1 · ending the runtime/,
      );
      assert.match(
        text,
        /runtime stopped: Circle runtime stopped handling files · its thread pool stopped taking work, so Circle ended it\nup \d+s · restarting in 0s/,
      );
      assert.doesNotMatch(text, /someone/, 'no path reaches the log');
    });
  },
);

test(
  'a second stall soon after leaves the runtime stopped; stale and repeated reports change nothing',
  { timeout: patience(10000) },
  async () => {
    await fixture(async ({ supervisor, children, updates, log }) => {
      const first = children[0]!;
      stall(first);
      stall(first);
      await until(() => first.exited, 'the stalled runtime was ended');
      assert.equal(first.kills, 1, 'one report, one kill');
      await until(
        () => children.length === 2 && supervisor.connected,
        'restarted once',
      );
      const second = children[1]!;
      // A report from the runtime that is gone is not about this one.
      stall(first);
      await delay(50);
      assert.equal(second.kills, 0);
      assert.equal(supervisor.connected, true);
      stall(second);
      await until(() => second.exited, 'the second stalled runtime was ended');
      await until(
        () => updates.at(-1)?.connected === false,
        'the windows were told',
      );
      await delay(50);
      assert.equal(children.length, 2, 'not started a third time');
      const last = updates.at(-1)!;
      assert.equal(last.snapshot.runtime?.stopped?.reason, 'stalled');
      assert.equal(last.snapshot.runtime?.stopped?.restarting, false);
      assert.match(await log(), /not restarted automatically/);
    });
  },
);

test(
  'a command the runtime never answers is logged with its workspace service and method, never its parameters',
  { timeout: patience(10000) },
  async () => {
    await fixture(
      async ({ supervisor, log }) => {
        await assert.rejects(
          supervisor.command({
            id: '00000000-0000-4000-8000-000000000001',
            name: 'workspace-service',
            sessionId: 'session',
            payload: {
              service: 'git',
              method: 'changes',
              params: { path: '/Users/someone/private-project' },
            },
          }),
          /timed out/,
        );
        await assert.rejects(
          supervisor.command({
            id: '00000000-0000-4000-8000-000000000002',
            name: 'state',
            payload: {},
          }),
          /timed out/,
        );
        await assert.rejects(
          supervisor.command({
            id: '00000000-0000-4000-8000-000000000003',
            name: 'workspace-service',
            sessionId: 'session',
            payload: { service: 'not-a-service', method: 'x' },
          }),
          /timed out/,
        );
        const text = await log();
        assert.match(
          text,
          /runtime command timed out: workspace-service git\.changes after \d+s/,
        );
        assert.match(text, /runtime command timed out: state after \d+s/);
        assert.match(
          text,
          /runtime command timed out: workspace-service after \d+s/,
          'an unknown service is not named',
        );
        assert.doesNotMatch(text, /private-project|not-a-service/);
      },
      { commandTimeoutMs: 40 },
    );
  },
);
