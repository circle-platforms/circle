import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentActivityText,
  agentState,
  isAgentActive,
} from '../src/model/activity';
import type { AgentRecord } from '../src/model/types';
import { setLanguage } from '../src/i18n/index';

const taskAgent = (
  state: NonNullable<AgentRecord['task']>['state'],
): AgentRecord => ({
  id: 'real-child',
  sessionId: 'parent',
  name: 'Review files',
  description: 'Review files',
  status: 'completed',
  model: 'scripted',
  tokens: 0,
  messages: [],
  task: {
    id: 'task',
    attempt: 1,
    state,
    access: 'readonly',
    baseline: 'a'.repeat(40),
  },
});
test('native terminal states preserve their real meaning instead of the legacy completed bucket', () => {
  for (const state of [
    'failed',
    'cancelled',
    'interrupted',
    'needs_review',
    'blocked',
  ] as const) {
    const agent = taskAgent(state);
    assert.equal(agentState(agent), state);
    assert.equal(isAgentActive(agent), false);
    assert.notEqual(agentActivityText(agent), 'done');
    assert.notEqual(agentActivityText(agent), 'working');
  }
  assert.equal(agentState(taskAgent('succeeded')), 'completed');
  assert.equal(agentActivityText(taskAgent('succeeded')), 'done');
});
test('only actual live native states stay in the running strip and core agents retain their contract', () => {
  for (const state of [
    'queued',
    'preparing',
    'running',
    'waiting',
    'cancelling',
  ] as const)
    assert.equal(isAgentActive(taskAgent(state)), true);
  const legacy = taskAgent('failed');
  delete legacy.task;
  legacy.status = 'running';
  assert.equal(agentState(legacy), 'running');
  assert.equal(isAgentActive(legacy), true);
  legacy.status = 'completed';
  assert.equal(isAgentActive(legacy), false);
});

test('legacy failure and interruption activity retains priority over a completed coarse status in both languages', () => {
  try {
    for (const language of ['en', 'zh-CN'] as const) {
      setLanguage(language);
      const agent = taskAgent('failed');
      delete agent.task;
      agent.activity = 'failed';
      assert.equal(
        agentActivityText(agent),
        language === 'en' ? 'failed' : '失败',
      );
      agent.activity = 'interrupted';
      assert.equal(
        agentActivityText(agent),
        language === 'en' ? 'interrupted' : '已中断',
      );
      assert.equal(
        agentActivityText(taskAgent('waiting')),
        language === 'en' ? 'waiting for you' : '等待你处理',
      );
    }
  } finally {
    setLanguage('en');
  }
});

test('unreconciled history keeps its ledger state but never reports an active agent', () => {
  const agent = taskAgent('running');
  agent.task!.recovery = 'needs_reconciliation';
  assert.equal(agent.task!.state, 'running');
  assert.equal(agentState(agent), 'needs_review');
  assert.equal(isAgentActive(agent), false);
  assert.equal(agentActivityText(agent), 'needs review');
});

test('worker execution can finish while acceptance and an independent reviewer remain active', () => {
  const worker = taskAgent('running');
  worker.task!.runtimeState = 'succeeded';
  worker.task!.role = 'worker';
  assert.equal(agentState(worker), 'completed');
  assert.equal(agentActivityText(worker), 'done');
  assert.equal(isAgentActive(worker), false);
  assert.equal(worker.task!.state, 'running');
  const reviewer = taskAgent('running');
  reviewer.task!.runtimeState = 'running';
  reviewer.task!.role = 'reviewer';
  assert.equal(agentState(reviewer), 'running');
  assert.equal(isAgentActive(reviewer), true);
  worker.task!.state = 'needs_review';
  assert.equal(agentState(worker), 'completed');
  assert.equal(
    worker.task!.state,
    'needs_review',
    'completion never changes the acceptance result',
  );
  worker.task!.runtimeState = 'needs_review';
  assert.equal(agentState(worker), 'needs_review');
  assert.notEqual(agentActivityText(worker), 'done');
});
