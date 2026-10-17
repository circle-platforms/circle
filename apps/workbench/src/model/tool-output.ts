import stripAnsi from 'strip-ansi';
/** A display-only view of a JSON text field. This grants no provenance or actions. */
export function structuredTextOutput(
  output: string,
): { text: string; preview: string } | undefined {
  try {
    const value: unknown = JSON.parse(output);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, 'text') ||
      typeof (value as { text?: unknown }).text !== 'string'
    )
      return;
    const text = (value as { text: string }).text;
    if (!text.length) return;
    // Render inert text only. Preserve the complete original field separately
    // for explicit copying and the untouched JSON for the original raw view.
    return {
      text,
      preview: stripAnsi(text).replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
        '',
      ),
    };
  } catch {
    return;
  }
}
