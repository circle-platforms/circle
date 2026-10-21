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
import type { RuntimeCommandWait } from '../src/contracts.ts';
import { patience } from './helpers/patience.mjs';

async function wait(check: () => boolean, description: string) {
  const end = Date.now() + patience(8000);
  while (!check()) {
    if (Date.now() > end) throw Error(`timed out: ${description}`);
    await delay(10);
  }
}

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

/** The supervisor against a runtime child that answers only when the test says so. */
async function fixture(
  run: (supervisor: Supervisor, child: Child) => Promise<void>,
  options: Record<string, unknown> = {},
) {
  const children: Child[] = [];
  globals.__circleUtilityFork = () => {
    const child = new Child();
    children.push(child);
    queueMicrotask(() =>
      child.emit('message', {
        type: 'update',
        update: {
          seq: 1,
          connected: true,
          tokenStream: { epoch: 'epoch-0', seq: 0 },
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
    options,
  );
  try {
    await supervisor.start();
    await run(supervisor, children[0]!);
  } finally {
    await supervisor.close();
    delete globals.__circleUtilityFork;
  }
}

test(
  'a command the runtime keeps is said to the windows, and its answer is said too',
  { timeout: patience(8000) },
  async () => {
    await fixture(
      async (supervisor, child) => {
        const waits: (RuntimeCommandWait | null)[] = [];
        supervisor.onCommandWait((event) => {
          waits.push(event);
        });
        const answer = supervisor.command({
          id: 'held',
          name: 'custom-command',
          payload: {},
        });
        await wait(
          () => waits.some((event) => event !== null),
          'the wait said what the runtime holds',
        );
        const said = waits.find((event) => event !== null)!;
        assert.equal(said.name, 'custom-command');
        assert.equal(said.id, 'held');
        assert.ok(said.waitedMs >= 40, 'the wait counts the seconds it held');
        child.emit('message', {
          type: 'reply',
          reply: { id: 'held', ok: true, data: {} },
        });
        assert.deepEqual(await answer, { id: 'held', ok: true, data: {} });
        assert.equal(waits.at(-1), null, 'the end of the wait is said');
      },
      { commandWaitMs: 40 },
    );
  },
);

test(
  'a command the runtime never answers is said, with what the runtime last wrote',
  { timeout: patience(8000) },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'circle-command-wait-'));
    const logFile = join(root, 'runtime.log');
    try {
      await fixture(
        async (supervisor, child) => {
          // The runtime's own report of what it is waiting on. It never reaches
          // a window; it is kept so this failure can be diagnosed from the log.
          child.stdout.emit('data', 'waiting for the endpoint to answer\n');
          await assert.rejects(
            () =>
              supervisor.command({
                id: 'gone',
                name: 'prompt',
                payload: {},
              }),
            /runtime command timed out; execution state must be checked · prompt \(\d+s\)/,
          );
          const log = await readFile(logFile, 'utf8');
          assert.match(log, /runtime command timed out: prompt/);
          assert.match(log, /waiting for the endpoint to answer/);
        },
        { commandWaitMs: 20, commandTimeoutMs: 120, logFile },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a command that answers inside the moment the person notices is never called busy',
  { timeout: patience(8000) },
  async () => {
    await fixture(
      async (supervisor, child) => {
        const waits: (RuntimeCommandWait | null)[] = [];
        supervisor.onCommandWait((event) => waits.push(event));
        const answer = supervisor.command({
          id: 'quick',
          name: 'state',
          payload: {},
        });
        await delay(10);
        child.emit('message', {
          type: 'reply',
          reply: { id: 'quick', ok: true, data: {} },
        });
        await answer;
        assert.deepEqual(waits, [], 'a short command says nothing');
      },
      { commandWaitMs: 400 },
    );
  },
);
