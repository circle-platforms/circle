import type { Message } from '../types.js';
import type { ContextState } from '../checkpoint_store.js';
import { envFlag } from '../model_guard.js';
import { isRecord } from '../settings.js';
export function tokenLen(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x20000 && code <= 0x2a6df)
    )
      cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}
export function completeJson(text: string): boolean {
  if (!/^\s*[{[]/.test(text)) return false;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) || Array.isArray(value);
  } catch {
    return false;
  }
}
export interface PruneOptions {
  /** How much recent tool output stays untouched, in tokens. */
  protectTokens?: number;
  /** The least that is shortened in one batch, in tokens. */
  minimumTokens?: number;
  enabled?: boolean;
  /**
   * The most input a request to the model can carry, in tokens: its context window, or its input limit when that is
   * smaller. What stays untouched is sized from it.
   */
  inputLimit?: number;
}
/** The least recent tool output that pruning leaves untouched, in tokens. */
export const PRUNE_PROTECT_FLOOR = 40000;
/** The least that pruning shortens in one batch when it leaves the floor untouched, in tokens. */
export const PRUNE_BATCH_FLOOR = PRUNE_PROTECT_FLOOR / 2;
/**
 * How much recent tool output pruning leaves untouched: a quarter of the most input the model takes (its context
 * window, or its input limit when that is smaller), and never less than the floor. A fixed 40,000 tokens made an
 * agent on a one-million-token model read the same files again and again, because what it had read a few calls ago
 * was already shortened while nine tenths of its window stood empty. A quarter of a window the model's input limit
 * keeps it from filling would never be reached before the conversation is summarized.
 */
export function pruneProtectTokens(inputLimit?: number): number {
  const input =
    typeof inputLimit === 'number' && Number.isFinite(inputLimit)
      ? inputLimit
      : 0;
  return Math.max(PRUNE_PROTECT_FLOOR, Math.floor(input / 4));
}
/**
 * The least that pruning shortens in one batch: half of what it leaves untouched, and never less than the floor's
 * half. A batch rewrites a message as far back as what stays untouched reaches, so the request's cached prefix is
 * lost from there on; where that is a quarter of a large window, a gain of 20,000 tokens would not pay for it.
 */
export function pruneBatchTokens(protect: number): number {
  return Math.max(PRUNE_BATCH_FLOOR, Math.floor(protect / 2));
}
export function nextPruneState(
  messages: Message[],
  state: ContextState,
  options: PruneOptions = {},
): ContextState {
  if (!(options.enabled ?? envFlag('CIRCLE_PRUNE_TOOL_OUTPUTS'))) return state;
  const configured = process.env.CIRCLE_PRUNE_PROTECT_TOKENS;
  const fromEnv = configured ? Number(configured) : NaN;
  const protect =
    options.protectTokens ??
    (Number.isFinite(fromEnv)
      ? fromEnv
      : pruneProtectTokens(options.inputLimit));
  const old = new Set(state.prunedIds);
  const callNames = new Map(
    messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => [call.id, call.name]),
  );
  const latestTodos = messages
    .filter(
      (message) =>
        message.role === 'tool' &&
        (message.name || callNames.get(message.tool_call_id!)) ===
          'write_todos',
    )
    .at(-1);
  let accumulated = 0;
  const candidates: { id: string; tokens: number }[] = [];
  for (const message of [...messages].reverse()) {
    const name = message.name || callNames.get(message.tool_call_id!) || '';
    if (
      message.role !== 'tool' ||
      old.has(message.id) ||
      Boolean(message.attachments?.length) ||
      // its images were left out: its text says so and where they were
      state.droppedMedia?.includes(message.id) ||
      ['question', 'skill'].includes(name) ||
      message === latestTodos ||
      completeJson(message.content)
    )
      continue;
    const size = tokenLen(message.content);
    accumulated += size;
    if (accumulated > protect)
      candidates.push({ id: message.id, tokens: size });
  }
  if (
    candidates.reduce((sum, item) => sum + item.tokens, 0) <
    (options.minimumTokens ?? pruneBatchTokens(protect))
  )
    return state;
  const newIds = candidates.reverse().map((item) => item.id);
  const first = messages.findIndex((message) => newIds.includes(message.id));
  const strip = messages
    .slice(first + 1)
    .filter((message) => message.role === 'assistant')
    .map((message) => message.id);
  return {
    ...state,
    prunedIds: [...state.prunedIds, ...newIds],
    stripThinkingIds: [...new Set([...state.stripThinkingIds, ...strip])],
  };
}
export function pruneMessages(
  messages: Message[],
  state: ContextState,
): Message[] {
  const pruned = new Set(state.prunedIds);
  const stripped = new Set(state.stripThinkingIds);
  return messages.map((message) => {
    if (message.role === 'tool' && pruned.has(message.id))
      return {
        ...message,
        attachments: undefined,
        content: `${Array.from(message.content).slice(0, 160).join('')}\n…[older tool output pruned to free context: ${Array.from(message.content).length} characters originally. Call the tool again if you need the full text.]`,
      };
    if (message.role === 'assistant' && stripped.has(message.id))
      return {
        ...message,
        thinking: undefined,
        reasoning_items: undefined,
        provider_content: message.provider_content?.filter(
          (block) =>
            !isRecord(block) ||
            !['thinking', 'redacted_thinking'].includes(String(block.type)),
        ),
      };
    return message;
  });
}
