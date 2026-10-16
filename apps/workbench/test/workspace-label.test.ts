import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceLabel } from '../src/model/workspace-label.ts';

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
