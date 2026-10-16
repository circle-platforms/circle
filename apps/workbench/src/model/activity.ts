import type { AgentRecord } from './types';
import { t } from '../i18n/index.ts';

/** Keep the legacy coarse status contract while displaying the real task state. */
export function agentState(
  agent: Pick<AgentRecord, 'status' | 'task'>,
): string {
  return agent.task?.state === 'succeeded'
    ? 'completed'
    : (agent.task?.state ?? agent.status);
}
export function isAgentActive(
  agent: Pick<AgentRecord, 'status' | 'task'>,
): boolean {
  return agent.task
    ? ['queued', 'preparing', 'running', 'waiting', 'cancelling'].includes(
        agent.task.state,
      )
    : agent.status !== 'completed';
}

/** Localize only interface state words; tool names/paths remain the actual event text. */
export function agentActivityText(
  agent: Pick<AgentRecord, 'status' | 'activity' | 'description' | 'task'>,
): string {
  const state = agentState(agent);
  if (state === 'failed') return t('failed');
  if (state === 'cancelled') return t('cancelled');
  if (state === 'interrupted') return t('interrupted');
  if (state === 'needs_review') return t('needs review');
  if (state === 'blocked') return t('blocked');
  if (state === 'queued') return t('queued');
  if (state === 'preparing') return t('preparing workspace');
  if (state === 'cancelling') return t('stopping…');
  if (state === 'completed') return t('done');
  if (agent.status === 'waiting' || agent.activity === 'waiting for you')
    return t('waiting for you');
  if (!agent.activity || agent.activity === 'working') return t('working');
  if (agent.activity === 'done') return t('done');
  if (agent.activity === 'failed') return t('failed');
  if (agent.activity === 'interrupted') return t('interrupted');
  return agent.activity;
}
