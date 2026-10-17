import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceLabel } from '../src/model/workspace-label';
import { PreviewRuntime } from '../src/model/state';
import { setLanguage } from '../src/i18n';
const generated = 'a0b1c2d3e4f5678901234567-2';
function fixture() {
  const snapshot = new PreviewRuntime().getSnapshot();
  const owner = {
    ...snapshot.agents[0],
    id: 'actual-child',
    resourceSessionId: 'actual-child',
    workspaceId: 'actual-worktree',
    name: 'Implement login',
    task: {
      id: 'login',
      attempt: 2,
      state: 'running' as const,
      access: 'write' as const,
      baseline: 'abc',
    },
  };
  return { workspace: { id: 'actual-worktree', name: generated }, owner };
}
test('verified generated task workspaces use the actual agent name in both languages', () => {
  const { workspace, owner } = fixture();
  for (const [lang, expected] of [
    ['en', 'isolated copy for Implement login'],
    ['zh-CN', 'Implement login 的隔离副本'],
  ] as const) {
    setLanguage(lang);
    assert.equal(workspaceLabel(workspace, [owner]), expected);
  }
  setLanguage('en');
  assert.equal(
    workspaceLabel({ ...workspace, name: 'customer-project' }, [owner]),
    'customer-project',
  );
  assert.equal(
    workspaceLabel(workspace, [{ ...owner, name: generated }]),
    'isolated task copy',
  );
  // A reviewer reads the worker's copy; the worker names it.
  assert.equal(
    workspaceLabel(workspace, [
      owner,
      {
        ...owner,
        id: 'review-child',
        resourceSessionId: 'review-child',
        name: 'review: Implement login',
        task: { ...owner.task, role: 'reviewer' as const },
      },
    ]),
    'isolated copy for Implement login',
  );
});
test('a folder-shaped name never invents ownership, roles or navigation changes', () => {
  const { workspace, owner } = fixture();
  for (const agents of [
    [],
    [{ ...owner, workspaceId: 'parent' }],
    [{ ...owner, resourceSessionId: 'parent' }],
    [{ ...owner, task: undefined }],
  ]) {
    assert.equal(workspaceLabel(workspace, agents), generated);
  }
  assert.equal(owner.resourceSessionId, 'actual-child');
  assert.equal(owner.workspaceId, 'actual-worktree');
});

test('a folder with no project uses the same words as the home screen', () => {
  assert.equal(workspaceLabel({ name: 'unscoped' }), 'work without a project');
  assert.equal(
    workspaceLabel({ name: 'unscoped', kind: 'scratch' }),
    'work without a project',
  );
  assert.equal(
    workspaceLabel({ name: 'notes', kind: 'scratch' }),
    'work without a project',
  );
  assert.equal(workspaceLabel({ name: 'circle' }), 'circle');
});
