import type { CircleEvent } from './events.js';
import { toolCallLine } from './headless.js';

export interface AgentActivityState {
  activity: string;
  lastStep?: string;
  thinking: string;
}

const HEADING = /^\s*(?:#{1,6}\s+)?\*\*(.+?)\*\*\s*:?\s*$/;
const STATE_WORDS = new Set([
  'working',
  'waiting for you',
  'done',
  'failed',
  'interrupted',
]);
const SUMMARY_MAX_CHARS = 120;

function sanitizeSummary(text: string): string | undefined {
  const clean = text
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || /^\d+$/.test(clean) || /^[0-9a-f]{7,64}$/i.test(clean))
    return undefined;
  const chars = Array.from(clean);
  return chars.length <= SUMMARY_MAX_CHARS
    ? clean
    : chars.slice(0, SUMMARY_MAX_CHARS - 1).join('') + '…';
}

function stripInlineMarks(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(?:^\*\*+|\*\*+$|^__+|__+$)/g, '');
}

/** Extract a single-line summary from streaming or completed reasoning text. */
export function thinkingActivitySummary(text: string): string | undefined {
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[\u200b\u200c\u200d\ufeff\u2060\u00ad]/g, '');
  const lines = cleaned.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i]!.match(HEADING);
    if (match) {
      const heading = sanitizeSummary(stripInlineMarks(match[1]!));
      if (heading) return heading;
    }
  }
  const latestLine = lines
    .at(-1)!
    .replace(/^\s*(?:#{1,6}\s+|(?:[-*+]|\d+\.)\s+)+/, '');
  const plain = stripInlineMarks(latestLine);
  const sentence = plain
    .split(/(?:[。！？!?；;]+|\.\s+(?=[A-Z\u4e00-\u9fff"'`(]))/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  return sentence ? sanitizeSummary(sentence) : undefined;
}

/** Advance subagent activity state from a bus event, preserving lastStep across round starts. */
export function stepAgentActivity(
  state: AgentActivityState | undefined,
  event: Pick<CircleEvent, 'kind' | 'payload'>,
): AgentActivityState {
  const lastStep =
    state?.lastStep ??
    (state?.activity && !STATE_WORDS.has(state.activity)
      ? state.activity
      : undefined);
  const thinking = state?.thinking ?? '';
  if (event.kind === 'run_start')
    return { activity: 'working', lastStep: undefined, thinking: '' };
  if (event.kind === 'tool_waiting')
    return { activity: 'waiting for you', lastStep, thinking: '' };
  if (event.kind === 'tool_call' || event.kind === 'tool_start') {
    const line = toolCallLine(
      String(event.payload.name ?? 'tool'),
      event.payload.args,
    ).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    return { activity: line, lastStep: line, thinking: '' };
  }
  if (event.kind === 'llm_start')
    return { activity: lastStep ?? 'working', lastStep, thinking: '' };
  if (event.kind === 'steer')
    return {
      activity: state?.activity ?? lastStep ?? 'working',
      lastStep,
      thinking: '',
    };
  if (event.kind === 'llm_token') {
    if (!event.payload.thinking)
      return {
        activity: state?.activity ?? lastStep ?? 'working',
        lastStep,
        thinking,
      };
    const next = thinking + String(event.payload.text ?? '');
    const summary = thinkingActivitySummary(next);
    return summary
      ? { activity: summary, lastStep: summary, thinking: next }
      : {
          activity: state?.activity ?? lastStep ?? 'working',
          lastStep,
          thinking: next,
        };
  }
  if (event.kind === 'llm_end') {
    const raw = (event.payload.message as { thinking?: unknown } | undefined)
      ?.thinking;
    const summary =
      typeof raw === 'string' ? thinkingActivitySummary(raw) : undefined;
    return summary
      ? { activity: summary, lastStep: summary, thinking: '' }
      : {
          activity: state?.activity ?? lastStep ?? 'working',
          lastStep,
          thinking: '',
        };
  }
  if (event.kind === 'run_end')
    return { activity: 'done', lastStep, thinking: '' };
  if (event.kind === 'run_error')
    return {
      activity: event.payload.interrupted ? 'interrupted' : 'failed',
      lastStep,
      thinking: '',
    };
  return {
    activity: state?.activity ?? lastStep ?? 'working',
    lastStep,
    thinking,
  };
}

/** Summaries come from the actual tool events and thinking summaries, never the agent's initial task or raw JSON. */
export function nextAgentActivity(
  previous: string | undefined,
  event: Pick<CircleEvent, 'kind' | 'payload'>,
): string {
  return stepAgentActivity(
    previous !== undefined ? { activity: previous, thinking: '' } : undefined,
    event,
  ).activity;
}
