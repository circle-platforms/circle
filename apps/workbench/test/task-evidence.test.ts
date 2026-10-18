import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskRecord } from '../../desktop/src/workspace/task-store';
import { taskEvidence } from '../src/model/task-evidence.ts';

const task = (result: unknown, attempt = 2): TaskRecord => ({
  spec: {
    id: 'task-a',
    prompt: 'check',
    workspace: '/synthetic',
    baseline: 'base',
    dependencies: [],
    acceptanceCriteria: ['files match'],
    access: 'write',
    resource: 'agent',
  },
  state: 'needs_review',
  attempt,
  createdAt: 1,
  updatedAt: 2,
  result: result as TaskRecord['result'],
});
test('only exact task and attempt evidence is projected, never worker completion prose', () => {
  assert.equal(taskEvidence(task('all tests passed')), null);
  assert.equal(
    taskEvidence(task({ taskId: 'task-a', attempt: 1, checks: [] })),
    null,
  );
  assert.equal(
    taskEvidence(task({ taskId: 'other', attempt: 2, checks: [] })),
    null,
  );
  const result = taskEvidence(
    task({ taskId: 'task-a', attempt: 2, answer: 'passed', checks: [] }),
  );
  assert.deepEqual(result?.checks, []);
});
test('command failure, missing exit and human review stay distinct without invented success', () => {
  const checks = taskEvidence(
    task({
      taskId: 'task-a',
      attempt: 2,
      changes: {
        paths: ['src/demo.ts', null],
        sha256: 'a'.repeat(64),
        head: 'head',
      },
      checks: [
        {
          criterion: 'files match',
          status: 'failed',
          source: 'command',
          evidence: 'assertion failed',
          command: 'npm test',
          exitCode: 1,
        },
        {
          criterion: 'files match',
          status: 'needs_review',
          source: 'inspection',
          evidence: 'no oracle',
        },
        {
          criterion: 'files match',
          status: 'passed',
          source: 'independent-review',
          reviewer: 'human',
          evidence: 'checked file bytes',
        },
        {
          criterion: 'files match',
          status: 'passed',
          source: 'worker',
          evidence: 'trust me',
        },
      ],
    }),
  );
  assert.equal(checks?.checks.length, 3);
  assert.equal(checks?.checks[0]?.exitCode, 1);
  assert.equal(checks?.checks[0]?.status, 'failed');
  assert.equal(checks?.checks[1]?.exitCode, undefined);
  assert.equal(checks?.checks[2]?.source, 'human');
  assert.deepEqual(checks?.paths, ['src/demo.ts']);
});
