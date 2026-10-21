import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptTerminalEvent,
  mergeTerminalSnapshot,
  readTerminalOutput,
} from '../src/model/terminal-stream.ts';
import type {
  TerminalEvent,
  TerminalSnapshot,
} from '../../desktop/src/workspace/terminal.ts';

const event = (sequence: number, terminalId = 'terminal-a'): TerminalEvent => ({
  terminalId,
  sequence,
  owner: 'owner',
  sessionId: 'session',
  epoch: 'epoch',
  kind: 'data',
  data: 'output',
  at: '2026-10-16T00:00:00Z',
});

test('copy captures all saved output at its initial cursor even while new service logs arrive', async () => {
  const lines = Array.from({ length: 600 }, (_, index) => `line ${index}\r\n`);
  const copied = await readTerminalOutput('terminal-a', async (cursor) => {
    const start = cursor;
    const updates = lines
      .slice(start, start + 37)
      .map((line, index) => ({ ...event(start + index + 1), data: line }));
    return {
      events: updates,
      nextSequence: updates.at(-1)?.sequence ?? cursor,
      hasMore: true,
      snapshot: {
        lastSequence: cursor === 0 ? 600 : 100000,
      } as TerminalSnapshot,
    };
  });
  assert.equal(copied, lines.join(''));
  await assert.rejects(
    readTerminalOutput('terminal-a', async () => ({
      events: [],
      nextSequence: 0,
      hasMore: true,
      snapshot: { lastSequence: 1 } as TerminalSnapshot,
    })),
    /could not be recovered/,
  );
});

test('metadata does not reorder tabs or regress a newer terminal state', () => {
  const a = { id: 'a', lastSequence: 5, status: 'running' } as TerminalSnapshot;
  const b = { id: 'b', lastSequence: 8, status: 'running' } as TerminalSnapshot;
  const updated = mergeTerminalSnapshot([a, b], {
    ...a,
    lastSequence: 9,
    status: 'exited',
  });
  assert.deepEqual(
    updated.map((item) => item.id),
    ['a', 'b'],
  );
  assert.equal(updated[0]!.status, 'exited');
  assert.equal(
    mergeTerminalSnapshot(updated, { ...a, lastSequence: 7 }),
    updated,
  );
  const hidden = mergeTerminalSnapshot(updated, {
    ...updated[0]!,
    hidden: true,
  });
  assert.equal(hidden[0]!.hidden, true);
  assert.equal(
    mergeTerminalSnapshot(hidden, {
      ...updated[0]!,
      hidden: undefined,
      status: 'exited',
    })[0]!.hidden,
    true,
  );
});

test('reconnection replays each output once and rejects cross-terminal or missing history', () => {
  let cursor = 0;
  let displayed = '';
  for (const update of [event(1), event(2), event(1), event(2), event(3)]) {
    const next = acceptTerminalEvent('terminal-a', cursor, update);
    if (next !== cursor) displayed += update.data;
    cursor = next;
  }
  assert.equal(cursor, 3);
  assert.equal(displayed, 'outputoutputoutput');
  assert.throws(
    () => acceptTerminalEvent('terminal-a', cursor, event(5)),
    /sequence gap/,
  );
  assert.throws(
    () => acceptTerminalEvent('terminal-a', cursor, event(4, 'terminal-b')),
    /another terminal/,
  );
  assert.throws(
    () => acceptTerminalEvent('terminal-a', cursor, event(-1)),
    /invalid/,
  );
});
