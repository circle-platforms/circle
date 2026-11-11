import type { Message } from './types.js';
import { isRecord } from './settings.js';

/** Circle notices can be stored inside a tool batch. APIs need all matching results
 * before conversational text. Move only these notices in the request view; never
 * invent a missing result or rewrite stored history.
 */
export function orderModeToolResults(messages: Message[]): Message[] {
  const ordered: Message[] = [];
  for (let i = 0; i < messages.length;) {
    const message = messages[i]!;
    const ids = new Set((message.tool_calls ?? []).map((call) => call.id));
    if (message.role === 'assistant')
      for (const block of message.provider_content ?? [])
        if (
          isRecord(block) &&
          block.type === 'tool_use' &&
          typeof block.id === 'string'
        )
          ids.add(block.id);
    if (message.role !== 'assistant' || !ids.size) {
      ordered.push(message);
      i++;
      continue;
    }
    let end = i + 1;
    while (
      end < messages.length &&
      (messages[end]!.role === 'tool' || isBatchNotice(messages[end]!))
    )
      end++;
    const following = messages.slice(i + 1, end);
    const results = following.filter((item) => item.role === 'tool');
    const notices = following.filter(isBatchNotice);
    const returned = new Set(results.map((item) => item.tool_call_id));
    if (
      notices.length &&
      results.length === ids.size &&
      returned.size === ids.size &&
      [...ids].every((id) => returned.has(id))
    ) {
      ordered.push(message, ...results, ...notices);
    } else ordered.push(message, ...following);
    i = end;
  }
  return ordered;
}
const BATCH_NOTES = new Set(['mode-boundary', 'hook_notice', 'job_notice']);
function isBatchNotice(message: Message): boolean {
  return (
    message.role === 'user' &&
    message.internal !== undefined &&
    BATCH_NOTES.has(message.internal)
  );
}
