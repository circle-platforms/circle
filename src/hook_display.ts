export const HOOK_ALLOWED_LINE = 'Hook allowed this call.';

export function withoutHookAllowedLine(text: string): string {
  if (text === HOOK_ALLOWED_LINE) return '';
  const prefix = `${HOOK_ALLOWED_LINE}\n\n`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
