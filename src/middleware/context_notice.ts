import { randomUUID } from 'node:crypto';
import type { Message } from '../types.js';

/** The share of the window at which Circle replaces the earlier conversation with a summary. */
export const AUTO_COMPACT_SHARE = 0.85;
/** How far toward that point the context comes before the model hears of it, once. */
export const CONTEXT_NOTICE_SHARE = 0.8;

const thousands = (tokens: number): string =>
  `${Math.max(1, Math.round(tokens / 1000))}k`;

/**
 * Where Circle summarizes the earlier conversation: at 85% of the window, or sooner when a
 * request would no longer fit beside the room kept for the answer.
 */
export function compactionPoint(budget: {
  window: number;
  availableInput: number;
}): number {
  return Math.min(budget.window * AUTO_COMPACT_SHARE, budget.availableInput);
}

/**
 * Once per context: when a request has come most of the way to the point where Circle
 * summarizes the earlier conversation, the model hears how much it uses and where that point
 * is, so it can keep what it still needs first. `context` names the current context (the
 * summary's cutoff, or none yet) and goes into the notice's id, which the model never sees: a
 * notice the summary kept among the newest messages belongs to the context before, so the
 * next context hears it again. A subagent has no compact_conversation.
 */
export function contextReminder(
  projected: Message[],
  budget: { input: number; window: number; availableInput: number },
  context: string,
  canCompact: boolean,
): Message | undefined {
  const point = compactionPoint(budget);
  if (
    !(point > 0) ||
    budget.input < point * CONTEXT_NOTICE_SHARE ||
    budget.input >= point
  )
    return undefined;
  const prefix = `context-reminder:${context}:`;
  if (
    projected.some(
      (message) =>
        message.internal === 'context_reminder' &&
        message.id.startsWith(prefix),
    )
  )
    return undefined;
  const keep = canCompact
    ? 'keep what you still need (open steps, decisions, file paths) in the todo list or a file, or call compact_conversation at a good stopping point with a hint of what to keep'
    : 'state what you still need (open steps, decisions, file paths) in your next message, so the summary keeps it';
  return {
    id: prefix + randomUUID(),
    role: 'user',
    internal: 'context_reminder',
    content: `<system-reminder data-source="circle-context">\nContext: about ${thousands(budget.input)} of the model's ${thousands(budget.window)} tokens. At about ${thousands(point)} Circle replaces the earlier conversation with a summary. Before then, ${keep}.\n</system-reminder>`,
  };
}
