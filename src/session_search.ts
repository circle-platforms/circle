import type { Message } from './types.js';

/**
 * Text /resume matches, and the same user and assistant history the desktop session
 * search indexes. Tool output and internal notes stay out: they are not the conversation.
 */
export function sessionSearchText(
  session: { id: string; title: string; workspace: string },
  messages: readonly Message[],
): string {
  const body = messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        !message.internal,
    )
    .map((message) => (message.display || message.content || '').slice(0, 8000))
    .join('\n');
  return `${session.title}\n${session.id}\n${session.workspace}\n${body}`;
}
