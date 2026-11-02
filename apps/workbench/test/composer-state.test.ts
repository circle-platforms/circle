import test from 'node:test';
import assert from 'node:assert/strict';
import { composerState } from '../src/model/composer-state.ts';
import type { Session } from '../src/model/types.ts';

const idle: Pick<
  Session,
  'state' | 'mode' | 'readOnly' | 'turn' | 'compaction'
> = {
  state: 'idle',
  mode: 'manual',
  readOnly: false,
};
const turn = { startedAt: 1, waited: 0, tokens: 0, verb: 'thinking' };
test('composer follows idle, plan, running, request, resumed, completed and stopped states', () => {
  assert.equal(composerState(idle, 0), 'default');
  const plan = { ...idle, mode: 'plan' as const };
  assert.equal(composerState(plan, 0), 'plan');
  assert.equal(composerState({ ...plan, turn }, 0), 'working');
  assert.equal(composerState({ ...plan, turn }, 2), 'attention');
  assert.equal(composerState({ ...plan, turn }, 0), 'working');
  assert.equal(composerState(plan, 0), 'plan');
  assert.equal(composerState({ ...plan, state: 'paused', turn }, 0), 'plan');
  assert.equal(composerState({ ...idle, state: 'waiting' }, 0), 'working');
  assert.equal(composerState({ ...idle, state: 'paused' }, 1), 'attention');
  assert.equal(
    composerState(idle, 0),
    'default',
    'another session has no inherited work',
  );
});
test('manual, accept-edits and auto do not borrow state colours from plan or requests', () => {
  for (const mode of ['manual', 'accept-edits', 'auto'] as const) {
    assert.equal(composerState({ ...idle, mode }, 0), 'default');
    assert.equal(composerState({ ...idle, mode }, 1), 'attention');
  }
  assert.equal(
    composerState({ ...idle, mode: undefined, readOnly: true }, 0),
    'plan',
  );
});
