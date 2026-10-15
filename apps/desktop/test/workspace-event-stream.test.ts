import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  WorkspaceEventStream,
  type EventInput,
} from '../src/workspace/event-stream.ts';
import { WorkspaceStreamStore } from '../../workbench/src/model/workspace-stream-store.ts';
import { spawn as spawnPty } from 'node-pty';

const input = (text: string): EventInput => ({
  workspaceId: 'w',
  sessionId: 's',
  service: 'terminal',
  resourceId: 'pty1',
  data: { text },
});
async function fixture(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'circle-stream-'));
  try {
    await run(join(dir, 'events.jsonl'));
  } finally {
    await rm(dir, { recursive: true, force: true });
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
    );
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
        clearTimeout(timer);
        if (exitCode !== 0) reject(Error(`PTY exited ${exitCode}`));
        else resolve();
      });
    });
    await exited;
    await Promise.all(writes);
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
