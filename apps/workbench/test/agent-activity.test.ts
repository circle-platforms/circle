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
