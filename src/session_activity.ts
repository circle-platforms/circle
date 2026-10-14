import type { CircleEvent } from './events.js';
import { toolCallLine } from './headless.js';

/** Summaries come from the actual tool events, never the agent's initial task or raw JSON. */
export function nextAgentActivity(
  previous: string | undefined,
  event: Pick<CircleEvent, 'kind' | 'payload'>,
): string {
  if (event.kind === 'tool_waiting') return 'waiting for you';
  if (event.kind === 'tool_call' || event.kind === 'tool_start')
    return toolCallLine(
      String(event.payload.name ?? 'tool'),
      event.payload.args,
    ).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  if (event.kind === 'llm_start' || event.kind === 'run_start')
    return 'working';
  if (event.kind === 'run_end') return 'done';
  if (event.kind === 'run_error')
    return event.payload.interrupted ? 'interrupted' : 'failed';
  return previous ?? 'working';
}
