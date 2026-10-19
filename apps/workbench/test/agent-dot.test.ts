import test from 'node:test';
import assert from 'node:assert/strict';
import { agentDot } from '../src/model/activity.ts';
import type { AgentRecord } from '../src/model/types.ts';

const agent = (extra: Partial<AgentRecord>) =>
  ({ status: 'running', ...extra }) as AgentRecord;

test('a subagent or task dot says whether it works, waits, failed or is done', () => {
  assert.equal(agentDot(agent({ status: 'running' })), 'run');
  assert.equal(agentDot(agent({ status: 'waiting' })), 'wait');
  assert.equal(agentDot(agent({ status: 'running' }), true), 'wait');
  assert.equal(agentDot(agent({ status: 'completed' })), 'done');
  // a subagent that ended with a failure says so in its activity, not in its status
  assert.equal(
    agentDot(agent({ status: 'completed', activity: 'failed' })),
    'fail',
  );
  assert.equal(
    agentDot(agent({ status: 'completed', activity: 'interrupted' })),
    'fail',
  );
  // a task's own state decides for a task
  const task = (state: string) =>
    agent({
      status: 'running',
      task: { id: 't', state } as AgentRecord['task'],
    });
  assert.equal(agentDot(task('running')), 'run');
  assert.equal(agentDot(task('needs_review')), 'wait');
  assert.equal(agentDot(task('failed')), 'fail');
  assert.equal(agentDot(task('succeeded')), 'done');
  assert.equal(agentDot(task('cancelled')), 'done');
  // a runtime that lost track of it says nothing more than done
  assert.equal(agentDot(agent({ status: 'unknown' })), 'done');
});
