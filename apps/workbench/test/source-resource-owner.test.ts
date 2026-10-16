import test from 'node:test';
import assert from 'node:assert/strict';
import { agentSourceOwner } from '../src/model/source-resource-owner.ts';
test('child source owners require complete host identity and permission without parent fallback', () => {
  assert.deepEqual(
    agentSourceOwner({
      id: 'child',
      resourceSessionId: 'child',
      workspaceId: 'worktree',
      readOnly: true,
    }),
    { sessionId: 'child', workspaceId: 'worktree', readOnly: true },
  );
  for (const record of [
    { id: 'child' },
    { id: '', resourceSessionId: '', workspaceId: 'worktree', readOnly: false },
    {
      id: 'child',
      workspaceId: 'worktree',
      resourceSessionId: 'parent',
      readOnly: false,
    },
    { id: 'child', workspaceId: 'worktree', resourceSessionId: 'child' },
    {
      id: 'child',
      workspaceId: '',
      resourceSessionId: 'child',
      readOnly: false,
    },
  ])
    assert.equal(agentSourceOwner(record), null);
});
