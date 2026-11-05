/**
 * A reasoning summary as models send it: paragraphs, each usually led by a bold heading
 * (`**Inspecting the logs**`). A ChatGPT plan often sends the headings alone, with no
 * prose (openai/codex#34873), as Codex shows them: a line saying what the model is on.
 */
const HEADING = /^\s*(?:#{1,6}\s+)?\*\*(.+?)\*\*\s*:?\s*$/;

/** The summary without the empty HTML comments a subscription stream can carry. */
export function cleanThinking(text: string | undefined): string {
  return (text ?? '').replace(/<!--[\s\S]*?-->/g, '');
}

/** Markdown emphasis and heading marks taken off, for a one-line preview. */
export function plainLine(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/** The newest heading, which says what the model is on now; else the first line. */
export function thinkingHeadline(text: string | undefined): string {
  const lines = cleanThinking(text)
    .split('\n')
    .filter((line) => line.trim());
  const heading = [...lines].reverse().find((line) => HEADING.test(line));
  return plainLine(heading ?? lines[0] ?? '').slice(0, 120);
}

/** Whether there is prose besides the headings, worth opening. */
export function thinkingHasBody(text: string | undefined): boolean {
  return cleanThinking(text)
    .split('\n')
    .some((line) => line.trim() && !HEADING.test(line));
}
