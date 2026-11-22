/**
 * What a person can see of a text that someone else wrote, for words that reach the screen or the model: on one line,
 * with nothing in it that shows nothing. A control character, a line break among them, is a space, and runs of
 * spaces are one. A format character (a zero-width one, a bidirectional control, a tag character of U+E0000 to
 * U+E007F, which can spell a text nobody sees), a private-use or unassigned character and a lone surrogate are
 * taken out. A text longer than `max` characters is cut there and ends in `…`, never in half of a surrogate pair.
 */
export function visibleLine(
  text: string,
  max = Number.POSITIVE_INFINITY,
): string {
  const line = text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length <= max) return line;
  const head = line.slice(0, Math.max(0, max - 1));
  return (/[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head) + '…';
}
