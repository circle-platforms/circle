import type { Message } from './types';

/**
 * The busy line (a verb and the elapsed time) belongs to the turn after the latest
 * user message. It stays while that turn has no answer yet. Answer text, streaming
 * or stored, hides it. A tool still running after that answer brings it back.
 */
export function showTurnClock(
  messages: Pick<Message, 'role' | 'at' | 'text' | 'tool'>[],
  pending: number,
  turn: unknown,
): boolean {
  if (!turn || pending > 0) return false;
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--)
    if (messages[index]!.role === 'user') {
      start = index + 1;
      break;
    }
  const current = messages.slice(start);
  let answer = -1;
  for (let index = current.length - 1; index >= 0; index--) {
    const message = current[index]!;
    if (message.role !== 'assistant') continue;
    if (!message.text.trim() && message.at !== 'streaming') continue;
    answer = index;
    break;
  }
  if (answer < 0) return true;
  const message = current[answer]!;
  if (message.at === 'streaming') return !message.text.trim();
  return current
    .slice(answer + 1)
    .some(
      (row) =>
        !!row.tool &&
        (row.tool.status === 'running' || row.tool.status === 'waiting'),
    );
}
