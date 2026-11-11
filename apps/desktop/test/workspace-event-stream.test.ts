import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  stat,
  appendFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  WorkspaceEventStream,
  leaseDatabaseName,
  type EventInput,
} from '../src/workspace/event-stream.ts';
import { WorkspaceStreamStore } from '../../workbench/src/model/workspace-stream-store.ts';
import { spawnPty } from '../src/workspace/native-pty.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const progressDirectory =
  process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR ??
  join(tmpdir(), 'circle-runtime-progress');
mkdirSync(progressDirectory, { recursive: true });
const progressPath = join(
  progressDirectory,
  `event-stream-${process.platform}-${process.pid}-${randomUUID()}.jsonl`,
);
function progress(phase: string, data: Record<string, unknown> = {}) {
  appendFileSync(
    progressPath,
    JSON.stringify({
      phase,
      at: new Date().toISOString(),
      pid: process.pid,
      ...data,
    }) + '\n',
  );
}
function test(name: string, run: () => unknown | Promise<unknown>) {
  return nodeTest(name, async () => {
    progress('case-start', { name });
    try {
      await run();
      progress('case-complete', { name });
    } catch (error) {
      progress('case-failed', { name, error: String(error) });
      throw error;
    }
  });
}
process.once('beforeExit', () =>
  progress('natural-before-exit', {
    resources: process.getActiveResourcesInfo(),
  }),
);

const input = (text: string): EventInput => ({
  workspaceId: 'w',
  sessionId: 's',
  service: 'terminal',
  resourceId: 'pty1',
  data: { text },
});
async function fixture(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'circle-stream-'));
  progress('fixture-created', { dir });
  try {
    await run(join(dir, 'events.jsonl'));
  } finally {
    progress('fixture-cleanup-start', { dir });
    await rm(dir, { recursive: true, force: true });
    progress('fixture-cleanup-complete', { dir });
  }
}
test('persists every producer record, bounded cache and paginated reload replay', () =>
  fixture(async (path) => {
    let stream = await WorkspaceEventStream.open(path, { ringBytes: 500 });
    const seen: number[] = [];
    stream.subscribe((event) => seen.push(event.seq));
    stream.subscribe(() => {
      throw Error('renderer disconnected');
    });
    await Promise.all(
      Array.from({ length: 80 }, (_, n) => stream.append(input(`行${n}`))),
    );
    assert.equal(seen.length, 80);
    assert.ok(stream.cachedBytes <= 500);
    const oldEpoch = stream.epoch;
    await stream.close();
    stream = await WorkspaceEventStream.open(path, { ringBytes: 500 });
    assert.notEqual(stream.epoch, oldEpoch);
    assert.equal((await stream.append(input('after restart'))).seq, 81);
    let cursor = { offset: 0, seq: 0 };
    const texts: unknown[] = [];
    for (;;) {
      const page = await stream.replay(cursor, 7);
      texts.push(...page.events.map((event) => event.data.text));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    assert.deepEqual(texts, [
      ...Array.from({ length: 80 }, (_, n) => `行${n}`),
      'after restart',
    ]);
    await assert.rejects(
      stream.replay({ offset: 1, seq: 0 }),
      /JSON|gap|Unexpected/,
    );
    await assert.rejects(
      stream.replay({ offset: cursor.offset, seq: 0 }),
      /gap/,
    );
    await stream.close();
  }));
test('killed producer partial tail is removed while committed evidence remains', () =>
  fixture(async (path) => {
    const stream = await WorkspaceEventStream.open(path);
    await stream.append(input('committed'));
    await stream.close();
    await appendFile(path, '{"incomplete":');
    const reopened = await WorkspaceEventStream.open(path);
    await reopened.append(input('next'));
    assert.equal((await reopened.replay()).events.length, 2);
    assert.ok(!(await readFile(path, 'utf8')).includes('incomplete'));
    await reopened.close();
  }));
test('disk failure is explicit, publishes nothing and poisons writes until reopening', () =>
  fixture(async (path) => {
    const stream = await WorkspaceEventStream.open(path, {
      beforeWrite: async () => {
        throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
      },
    });
    let count = 0;
    stream.subscribe(() => count++);
    await assert.rejects(stream.append(input('lost?')), /persistence failed/);
    await assert.rejects(stream.append(input('retry?')), /persistence failed/);
    assert.equal(count, 0);
    assert.equal(stream.cursor.seq, 0);
    assert.equal((await readFile(path)).length, 0);
    await stream.close();
  }));
test('invalid large input does not poison following valid append', () =>
  fixture(async (path) => {
    const stream = await WorkspaceEventStream.open(path, {
      maxEventBytes: 512,
    });
    await assert.rejects(
      stream.append(input('x'.repeat(1000))),
      /maximum size/,
    );
    assert.equal((await stream.append(input('small'))).seq, 1);
    await stream.close();
  }));
test('complete corrupted evidence fails closed rather than skipping records', () =>
  fixture(async (path) => {
    const stream = await WorkspaceEventStream.open(path);
    await stream.append(input('saved'));
    await stream.close();
    await appendFile(path, '{}\n');
    await assert.rejects(WorkspaceEventStream.open(path), /corrupt/);
  }));

test('queued records snapshot producer data and reject overflow explicitly', () =>
  fixture(async (path) => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = await WorkspaceEventStream.open(path, {
      maxPendingBytes: 400,
      beforeWrite: () => wait,
    });
    const source = input('original');
    const saved = stream.append(source);
    source.data.text = 'mutated';
    await assert.rejects(stream.append(input('x'.repeat(400))), /backpressure/);
    release();
    assert.equal((await saved).data.text, 'original');
    const closing = stream.close();
    await assert.rejects(stream.append(input('too late')), /closed/);
    await closing;
    const reopened = await WorkspaceEventStream.open(path);
    assert.equal((await reopened.replay()).events[0].data.text, 'original');
    await reopened.close();
  }));

test('mixed task/PTY producer cursors survive journal replay without conflation', () =>
  fixture(async (path) => {
    const stream = await WorkspaceEventStream.open(path);
    const source = (
      service: 'tasks' | 'terminal',
      seq: number,
      text: string,
    ) => ({
      ...input(text),
      service,
      resourceId: service === 'terminal' ? 'pty1' : 'task1',
      epoch: `${service}-epoch`,
      seq,
      at: 'source-time',
    });
    // A real PTY is already independently sequenced before subscribing. Task
    // events interleave; journal global 1/2/3 must not become PTY 41/42.
    await stream.appendSource(source('terminal', 41, 'first chunk'));
    await stream.appendSource(source('tasks', 1, 'running'));
    await stream.appendSource(source('terminal', 42, 'second chunk'));
    await stream.appendSource(source('tasks', 2, 'completed'));
    const page = await stream.replay();
    assert.deepEqual(
      page.events.map((event) => event.seq),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      page.events.map((event) => event.sourceSeq),
      [41, 1, 42, 2],
    );
    const store = new WorkspaceStreamStore();
    for (const event of page.events)
      assert.equal(store.apply(event), 'applied');
    for (const event of page.events)
      assert.equal(store.apply(event), 'duplicate');
    const ptyEvents = store.snapshot(
      WorkspaceStreamStore.resourceKey(page.events[0]),
    );
    assert.deepEqual(
      ptyEvents.map((event) => event.sourceSeq),
      [41, 42],
    );
    assert.deepEqual(
      ptyEvents.map((event) => event.sourceEpoch),
      ['terminal-epoch', 'terminal-epoch'],
    );
    // Raw terminal replay cursor is the last producer sequence, not journal #3.
    const rawReplayAfter = ptyEvents.at(-1)!.sourceSeq!;
    assert.equal(rawReplayAfter, 42);
    const remainingRawRecords = [41, 42, 43].filter(
      (seq) => seq > rawReplayAfter,
    );
    assert.deepEqual(remainingRawRecords, [43]);
    await stream.close();
  }));

test('real PTY bytes and task-state records replay with separate source sequences', () =>
  fixture(async (path) => {
    const stream = await WorkspaceEventStream.open(path);
    const toTask = (seq: number, state: string) =>
      stream.appendSource({
        ...input(state),
        service: 'tasks',
        resourceId: 'task1',
        epoch: 'task-epoch',
        seq,
        at: new Date().toISOString(),
      });
    await toTask(1, 'queued');
    await toTask(2, 'running');
    let terminalSequence = 0;
    const writes: Promise<unknown>[] = [];
    const processPty = spawnPty(
      process.execPath,
      [
        '-e',
        'process.stdout.write(`native-pty:${!!process.stdout.isTTY}\\n`); setTimeout(() => process.exit(0), 60)',
      ],
      {
        name: 'xterm',
        cols: 80,
        rows: 24,
        cwd: dirname(path),
        env: {
          ...process.env,
          HOME: dirname(path),
          CIRCLE_HOME: dirname(path),
        },
      },
      (error) => {
        progress('pty-transport-error', { error: String(error) });
        throw error;
      },
    );
    progress('pty-created', { ptyPid: processPty.pid });
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        processPty.kill();
        reject(Error('PTY test timeout'));
      }, 5000);
      processPty.onData((text) => {
        writes.push(
          stream.appendSource({
            ...input(text),
            epoch: 'pty-epoch',
            seq: ++terminalSequence,
            at: new Date().toISOString(),
          }),
        );
      });
      processPty.onExit(({ exitCode }) => {
        progress('pty-public-exit', { exitCode });
        clearTimeout(timer);
        if (exitCode !== 0) reject(Error(`PTY exited ${exitCode}`));
        else resolve();
      });
    });
    await exited;
    await Promise.all(writes);
    progress('pty-journal-writes-complete', { count: writes.length });
    await toTask(3, 'completed');
    const page = await stream.replay();
    const store = new WorkspaceStreamStore();
    for (const event of page.events)
      assert.equal(store.apply(event), 'applied');
    for (const event of page.events)
      assert.equal(store.apply(event), 'duplicate');
    const ptyRows = page.events.filter((event) => event.service === 'terminal');
    assert.match(
      ptyRows.map((event) => event.data.text).join(''),
      /native-pty:true/,
    );
    assert.equal(ptyRows[0].sourceSeq, 1);
    assert.equal(ptyRows[0].seq, 3);
    assert.equal(ptyRows.at(-1)!.sourceSeq, terminalSequence);
    assert.deepEqual(
      page.events
        .filter((event) => event.service === 'tasks')
        .map((event) => event.sourceSeq),
      [1, 2, 3],
    );
    await stream.close();
  }));

test('a second in-process writer is refused without changing committed evidence and close is idempotent', () =>
  fixture(async (path) => {
    const first = await WorkspaceEventStream.open(path);
    await first.append(input('original evidence'));
    const original = await readFile(path);
    await assert.rejects(WorkspaceEventStream.open(path), /active writer/);
    assert.deepEqual(await readFile(path), original);
    const closing = first.close();
    assert.equal(first.close(), closing);
    await closing;
    const next = await WorkspaceEventStream.open(path);
    assert.equal((await next.append(input('next owner'))).seq, 2);
    assert.deepEqual(
      (await next.replay()).events.map((event) => event.data.text),
      ['original evidence', 'next owner'],
    );
    await next.close();
  }));

test('another process cannot write and a killed owner releases its lease for durable replay', () =>
  fixture(async (path) => {
    const module = new URL('../src/workspace/event-stream.ts', import.meta.url)
      .href;
    const loader = new URL(
      '../../../node_modules/tsx/dist/loader.mjs',
      import.meta.url,
    ).href;
    const script = `
      const {stat}=await import('node:fs/promises');
      const {WorkspaceEventStream}=await import(${JSON.stringify(module)});
      const path=${JSON.stringify(path)};
      const stream=await WorkspaceEventStream.open(path);
      await stream.append(${JSON.stringify(input('crash survivor'))});
      process.on('message', async (phase)=>{
        if (phase === 'after-local-contention') {
          try { await WorkspaceEventStream.open(path); throw Error('local writer accepted'); }
          catch (error) { if (!String(error).includes('active writer')) throw error; }
        }
        const identity=await stat(path+'.owner.sqlite');
        process.send({phase,pid:process.pid,transaction:stream.writerLease.isTransaction,
          closed:stream.closed,closing:stream.closing,dev:identity.dev,ino:identity.ino});
      });
      process.send({phase:'ready'});
    `;
    const child = spawn(
      process.execPath,
      ['--import', loader, '--input-type=module', '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    const exited = once(child, 'close');
    progress('lease-child-spawned', { childPid: child.pid, module, loader });
    child.on('close', (code, signal) =>
      progress('lease-child-close', { code, signal }),
    );
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += chunk;
      progress('lease-child-stderr', { text: String(chunk) });
    });
    const message = (phase: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.off('message', received);
          child.off('close', closed);
          child.off('error', failed);
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const closed = () =>
          failed(Error(`journal child exited during ${phase}: ${stderr}`));
        const received = (value: Record<string, unknown>) => {
          if (value.phase !== phase) return;
          cleanup();
          progress('lease-child-state', value);
          resolve(value);
        };
        const timer = setTimeout(
          () =>
            failed(Error(`journal child timed out during ${phase}: ${stderr}`)),
          10000,
        );
        child.on('message', received);
        child.once('close', closed);
        child.once('error', failed);
        if (phase !== 'ready') child.send(phase);
      });
    const checkOwner = async (phase: string) => {
      const state = await message(phase);
      const identity = await stat(path + '.owner.sqlite');
      assert.equal(state.pid, child.pid);
      assert.equal(state.transaction, true);
      assert.equal(state.closed, false);
      assert.equal(state.closing, false);
      assert.equal(state.dev, identity.dev);
      assert.equal(state.ino, identity.ino);
      return state;
    };
    try {
      await message('ready');
      const before = await checkOwner('after-local-contention');
      const original = await readFile(path);
      progress('second-lease-open-start');
      let unexpected: WorkspaceEventStream | undefined;
      try {
        await assert.rejects(async () => {
          unexpected = await WorkspaceEventStream.open(path);
        }, /active writer/);
      } finally {
        const after = await checkOwner('after-contention');
        // The folder shows which kind of lock each side took: SQLite falls back to a
        // `.lock` entry of its own when it cannot take a lock on the file itself, and two
        // sides holding different kinds do not exclude each other.
        progress('lease-contention-evidence', {
          before,
          after,
          unexpected: !!unexpected,
          entries: await readdir(dirname(path)),
        });
        await unexpected?.close();
      }
      progress('second-lease-rejected');
      assert.deepEqual(await readFile(path), original);
      progress('lease-child-kill-request');
      child.kill('SIGKILL');
      await exited;
      progress('recovery-lease-open-start');
      const recovered = await WorkspaceEventStream.open(path);
      progress('recovery-lease-open-complete');
      assert.equal(
        (await recovered.replay()).events[0].data.text,
        'crash survivor',
      );
      assert.equal((await recovered.append(input('after crash'))).seq, 2);
      await recovered.close();
      progress('recovery-lease-close-complete');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    }
  }));

test('reopening and replay reads never overwrite the committed prefix when appending', () =>
  fixture(async (path) => {
    const first = await WorkspaceEventStream.open(path);
    await first.append(input('committed 中文 prefix'));
    await first.close();
    const prefix = await readFile(path);
    const second = await WorkspaceEventStream.open(path);
    try {
      await second.replay(undefined, 1);
      await second.append(input('second'));
      await second.replay(undefined, 1);
      await second.appendBatch([input('third'), input('fourth')]);
      assert.deepEqual(
        (await readFile(path)).subarray(0, prefix.length),
        prefix,
      );
      assert.deepEqual(
        (await second.replay()).events.map((event) => event.data.text),
        ['committed 中文 prefix', 'second', 'third', 'fourth'],
      );
    } finally {
      await second.close();
    }
    const third = await WorkspaceEventStream.open(path);
    try {
      assert.equal((await third.replay()).events.length, 4);
    } finally {
      await third.close();
    }
  }));

test('a directory journal is rejected intact and its failed open releases the writer lease', () =>
  fixture(async (path) => {
    await mkdir(path);
    await assert.rejects(
      WorkspaceEventStream.open(path),
      /EISDIR|directory|regular file/i,
    );
    assert.equal((await stat(path)).isDirectory(), true);
    await rm(path, { recursive: true });
    const stream = await WorkspaceEventStream.open(path);
    try {
      assert.equal(
        (await stream.append(input('after rejected directory'))).seq,
        1,
      );
      assert.equal(
        (await stream.replay()).events[0].data.text,
        'after rejected directory',
      );
    } finally {
      await stream.close();
    }
  }));

test('the writer lease names the lock it takes, on a folder with spaces and marks in its name', async () => {
  // Elsewhere SQLite has one way to lock a file and takes the path as it is.
  assert.equal(
    leaseDatabaseName('/data/a b/x.sqlite', 'linux'),
    '/data/a b/x.sqlite',
  );
  assert.equal(
    leaseDatabaseName('C:\\data\\x.sqlite', 'win32'),
    'C:\\data\\x.sqlite',
  );
  // On macOS it would pick one per file: the lease asks for the file's own lock.
  assert.equal(
    leaseDatabaseName('/data/a b/#1 100%/x.sqlite', 'darwin'),
    'file:///data/a%20b/%231%20100%25/x.sqlite?vfs=unix-posix',
  );
  // Windows allows no question mark in a name.
  const dir = await mkdtemp(
    join(
      tmpdir(),
      `circle stream 中文 #1 100% ${process.platform === 'win32' ? '' : '?'}-`,
    ),
  );
  try {
    const path = join(dir, 'events.jsonl');
    const first = await WorkspaceEventStream.open(path);
    await first.append(input('named lock'));
    await assert.rejects(WorkspaceEventStream.open(path), /active writer/);
    // The name reached SQLite whole: the lease is this file, and no `.lock` entry stands
    // in for a lock on it.
    assert.deepEqual(
      (await readdir(dir)).filter((name) => !name.endsWith('-journal')).sort(),
      ['events.jsonl', 'events.jsonl.owner.sqlite'],
    );
    await first.close();
    const next = await WorkspaceEventStream.open(path);
    assert.equal((await next.append(input('next owner'))).seq, 2);
    await next.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
