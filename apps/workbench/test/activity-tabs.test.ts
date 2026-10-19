import test from 'node:test';
import assert from 'node:assert/strict';
import { forcedActivityTab } from '../src/features/activity-tabs.ts';

test('a task selection opens the tasks tab of the activity panel only', () => {
  assert.equal(
    forcedActivityTab({ kind: 'activity', selection: 'task:abc' }),
    'tasks',
  );
  assert.equal(
    forcedActivityTab({ kind: 'activity', selection: 'original' }),
    undefined,
  );
  // The debug tab is gone; an old selection naming it opens nothing.
  assert.equal(
    forcedActivityTab({ kind: 'activity', selection: 'debug' }),
    undefined,
  );
  assert.equal(
    forcedActivityTab({ kind: 'changes', selection: 'task:abc' }),
    undefined,
  );
});
