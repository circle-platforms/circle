import type { Message } from './types.js';
import { isRecord } from './settings.js';

/** Mode transitions are stored when they happen, including inside a tool batch.
 * APIs need the whole batch of actual results before conversational text. Move only
 * these internal transitions in the request view; never invent a missing result.
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
      (messages[end]!.role === 'tool' || isModeBoundary(messages[end]!))
    )
      end++;
    const following = messages.slice(i + 1, end);
    const results = following.filter((item) => item.role === 'tool');
    const boundaries = following.filter(isModeBoundary);
    const returned = new Set(results.map((item) => item.tool_call_id));
    if (
      boundaries.length &&
      results.length === ids.size &&
      returned.size === ids.size &&
      [...ids].every((id) => returned.has(id))
    ) {
      ordered.push(message, ...results, ...boundaries);
    } else ordered.push(message, ...following);
    i = end;
  }
  return ordered;
}
function isModeBoundary(message: Message): boolean {
  return message.role === 'user' && message.internal === 'mode-boundary';
}
