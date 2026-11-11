import test from 'node:test';
import assert from 'node:assert/strict';
import { composerActivity } from '../src/model/composer-activity';
import type { Session } from '../src/model/types';

const idle = { id: 'current', state: 'idle' as const };
const working = {
  ...idle,
  state: 'waiting' as const,
  turn: { verb: 'working', startedAt: 1, waited: 0, tokens: 0 },
};
test('composer tracks the actual turn through streaming and tool gaps, with session-scoped waiting', () => {
  assert.equal(composerActivity(idle, []), 'idle');
  assert.equal(composerActivity(working, []), 'working');
  assert.equal(
    composerActivity(
      { ...working, turn: { ...working.turn, tokens: 200 } },
      [],
    ),
    'working',
  );
  assert.equal(
    composerActivity(working, [{ sessionId: 'other', status: 'pending' }]),
    'working',
  );
  assert.equal(
    composerActivity(working, [{ sessionId: 'current', status: 'pending' }]),
    'waiting',
  );
  assert.equal(composerActivity(working, [], true), 'waiting');
  assert.equal(composerActivity(working, [], false, true), 'waiting');
  assert.equal(composerActivity(working, [], false, false), 'working');
  // The person stopped the turn: it has ended, whatever is still being torn down.
  assert.equal(composerActivity({ ...idle, state: 'paused' }, []), 'idle');
  assert.equal(composerActivity({ ...working, state: 'paused' }, []), 'idle');
  assert.equal(
    composerActivity({ ...working, state: 'paused' }, [
      { sessionId: 'current', status: 'pending' },
    ]),
    'idle',
  );
  for (const patch of [
    { occupied: true },
    { lifecycle: 'deleting' as const },
    { archivedAt: 'today' },
  ])
    assert.equal(composerActivity({ ...working, ...patch }, []), 'idle');
  assert.equal(
    composerActivity(idle, [{ sessionId: 'current', status: 'pending' }], true),
    'idle',
  );
  assert.equal(
    composerActivity(
      { ...idle, compaction: { status: 'running' } as Session['compaction'] },
      [],
    ),
    'working',
  );
});
