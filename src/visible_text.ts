// Strip control, invisible format (including U+E0000-U+E007F tags), private-use, unassigned, and lone surrogates.
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
