import type { Message } from './types';
import { plainLine } from './thinking';

/**
 * The model's latest update in a folded tool line, on its commentary channel: what it
 * says it is doing, in its own words, which a ChatGPT plan's heading-only reasoning
 * summary cannot say.
 */
export function groupNote(rows: readonly Message[]): string | undefined {
  const note = [...rows]
    .reverse()
    .find((row) => row.phase === 'commentary' && row.text.trim());
  if (!note) return undefined;
  const line = note.text.trim().split('\n')[0]!;
  return plainLine(line).slice(0, 160) || undefined;
}
