import type { AgentRecord } from './types';
import { t } from '../i18n/index.ts';

/** Localize only interface state words; tool names/paths remain the actual event text. */
export function agentActivityText(
  agent: Pick<AgentRecord, 'status' | 'activity' | 'description'>,
): string {
  if (agent.status === 'waiting' || agent.activity === 'waiting for you')
    return t('waiting for you');
  if (!agent.activity || agent.activity === 'working') return t('working');
  if (agent.activity === 'done') return t('done');
  if (agent.activity === 'failed') return t('failed');
  if (agent.activity === 'interrupted') return t('interrupted');
  return agent.activity;
}
