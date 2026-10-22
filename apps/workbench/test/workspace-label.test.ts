import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceHint, workspaceLabel } from '../src/model/workspace-label';
import type { Workspace } from '../src/model/types';
import { PreviewRuntime } from '../src/model/state';
import { setLanguage } from '../src/i18n';
const generated = 'a0b1c2d3e4f5678901234567-2';
function folder(id: string, name: string, path: string): Workspace {
  return {
    id,
    name,
    path,
    branch: '',
    trusted: true,
    kind: 'project',
    instructions: [],
  };
}
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

test('two folders of one name say which folder each sits in', () => {
  const repo = folder('repo', 'circle', 'D:\\circle');
  const old = folder(
    'old',
    'circle',
    'C:\\Users\\me\\Circle\\runtime-home\\workspace',
  );
  const alone = folder('alone', 'docs-site', 'D:\\docs-site');
  const all = [repo, old, alone];
  assert.equal(workspaceHint(repo, all), 'D:');
  assert.equal(workspaceHint(old, all), 'runtime-home');
  assert.equal(workspaceHint(alone, all), '');
  // The nearest folder that differs, not the whole path.
  const payments = folder('p', 'app', 'C:\\work\\payments\\app');
  const archive = folder('a', 'app', 'C:\\work\\archive\\app');
  assert.equal(workspaceHint(payments, [payments, archive]), 'payments');
  assert.equal(workspaceHint(archive, [payments, archive]), 'archive');
  // One name all the way up: the hint grows until the two differ.
  const c = folder('c', 'app', 'C:\\work\\app\\app');
  const d = folder('d', 'app', 'D:\\work\\app\\app');
  assert.equal(workspaceHint(c, [c, d]), 'C:/work/app');
  assert.equal(workspaceHint(d, [c, d]), 'D:/work/app');
});
