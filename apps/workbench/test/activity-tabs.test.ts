import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityTabWhenDebugHidden,
  forcedActivityTab,
} from '../src/features/activity-tabs.ts';

test('a debug-file request opens debug only while developer tools are on', () => {
  const request = {
    kind: 'activity',
    selection: 'original',
    showDebug: true,
    hasSourceRequest: true,
  };
  assert.equal(forcedActivityTab(request), 'debug');
  assert.equal(forcedActivityTab({ ...request, showDebug: false }), undefined);
  assert.equal(
    forcedActivityTab({ ...request, hasSourceRequest: false }),
    undefined,
  );
  assert.equal(
    forcedActivityTab({
      kind: 'activity',
      selection: 'debug',
      showDebug: true,
      hasSourceRequest: false,
    }),
    'debug',
  );
  assert.equal(
    forcedActivityTab({
      kind: 'activity',
      selection: 'task:abc',
      showDebug: true,
      hasSourceRequest: true,
    }),
    'tasks',
  );
});

test('hiding debug leaves that tab and does not disturb tasks', () => {
  assert.equal(
    activityTabWhenDebugHidden('activity', false, 'debug'),
    'original',
  );
  assert.equal(
    activityTabWhenDebugHidden('activity', false, 'tasks'),
    undefined,
  );
  assert.equal(
    activityTabWhenDebugHidden('activity', true, 'debug'),
    undefined,
  );
});
