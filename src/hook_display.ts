export const HOOK_ALLOWED_LINE = 'Hook allowed this call.';
/** Starts the tool result of a call a before_tool hook rewrote: `… (name):` and a `key = value` line per change. */
export const HOOK_CHANGED_LINE = "Hook changed this call's input";

export function withoutHookAllowedLine(text: string): string {
  if (text === HOOK_ALLOWED_LINE) return '';
  const prefix = `${HOOK_ALLOWED_LINE}\n\n`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

// The lines up to the first blank one: each value is JSON, on a line of its own
const CHANGED_BLOCK = /^Hook changed this call's input \([^)\n]*\):\n[^]*?\n\n/;

/**
 * A tool result as the person sees it. What a rewrite changed is for the model only, as is a routine allow's line
 * an older result may start with. A rewrite that could not run keeps its line: it says why nothing ran.
 */
export function withoutHookLines(text: string): string {
  return withoutHookAllowedLine(text.replace(CHANGED_BLOCK, ''));
}
