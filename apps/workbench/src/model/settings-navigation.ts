/** Every word must match inside this local section's display labels. */
export function matchesSettingsSection(
  query: string,
  label: string,
  keywords = '',
): boolean {
  const haystack = `${label} ${keywords}`.normalize('NFKC').toLocaleLowerCase();
  return query
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/u)
    .every((word) => haystack.includes(word));
}
