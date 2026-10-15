import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceEventStream,
  type EventInput,
} from '../src/workspace/event-stream.ts';

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
