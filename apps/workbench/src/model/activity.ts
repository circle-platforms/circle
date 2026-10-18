import type { AgentRecord } from './types';
import { t } from '../i18n/index.ts';

/** Execution state is separate from task acceptance; legacy agents retain their contract. */
export function agentState(
  agent: Pick<AgentRecord, 'status' | 'task'>,
): string {
  if (agent.status === 'unknown') return 'unknown';
  if (agent.task?.recovery === 'needs_reconciliation') return 'needs_review';
  const state = agent.task?.runtimeState ?? agent.task?.state ?? agent.status;
  return state === 'succeeded' ? 'completed' : state;
}
export function isAgentActive(
  agent: Pick<AgentRecord, 'status' | 'task'>,
): boolean {
  if (agent.status === 'unknown') return false;
  if (agent.task?.recovery === 'needs_reconciliation') return false;
  return agent.task
    ? ['queued', 'preparing', 'running', 'waiting', 'cancelling'].includes(
        agent.task.runtimeState ?? agent.task.state,
      )
    : agent.status !== 'completed';
}

/** Localize only interface state words; tool names/paths remain the actual event text. */
export function agentActivityText(
  agent: Pick<AgentRecord, 'status' | 'activity' | 'description' | 'task'>,
): string {
  const state = agentState(agent);
  if (state === 'unknown') return t('disconnected');
  if (state === 'failed') return t('failed');
  if (state === 'cancelled') return t('cancelled');
  if (state === 'interrupted') return t('interrupted');
  if (state === 'needs_review') return t('needs review');
  if (state === 'blocked') return t('blocked');
  if (state === 'queued') return t('queued');
  if (state === 'preparing') return t('preparing workspace');
  if (state === 'cancelling') return t('stopping…');
  if (
    state === 'completed' &&
    (agent.task?.runtimeState === 'succeeded' ||
      agent.task?.state === 'succeeded')
  )
    return t('done');
  if (state === 'waiting') return t('waiting for you');
  if (agent.status === 'waiting' || agent.activity === 'waiting for you')
    return t('waiting for you');
  if (!agent.activity) return state === 'completed' ? t('done') : t('working');
  if (agent.activity === 'working') return t('working');
  if (agent.activity === 'done') return t('done');
  if (agent.activity === 'failed') return t('failed');
  if (agent.activity === 'interrupted') return t('interrupted');
  return agent.activity;
}
