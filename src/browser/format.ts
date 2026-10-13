// How a conversation browser's dialogs read in a tool result, the same in the desktop
// application and in the terminal's browser.
export interface PageDialog {
  id: string;
  tab: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt: string;
  origin: string;
}
export const quote = (value: string) => JSON.stringify(value);
/** One line of "Dialogs waiting". */
export function dialogLine(dialog: PageDialog): string {
  const what =
    dialog.type === 'beforeunload'
      ? 'the page asks whether to leave it; accept leaves, dismiss stays'
      : `${quote(dialog.message)}${dialog.type === 'prompt' ? ` (default answer ${quote(dialog.defaultPrompt)})` : ''}`;
  return `- [${dialog.id}] ${dialog.type} · tab ${dialog.tab} · from ${dialog.origin || 'the page'}: ${what} → browser_dialog`;
}
/** The snapshot of a tab whose page waits on a dialog: the dialog is all there is to act on. */
export function dialogSnapshot(dialog: PageDialog): string {
  return (
    `The page waits for dialog ${dialog.id}; this is the dialog:\n` +
    `- dialog ${dialog.type} [${dialog.id}] from ${dialog.origin || 'the page'}\n` +
    (dialog.message ? `  - text ${quote(dialog.message)}\n` : '') +
    (dialog.type === 'prompt'
      ? `  - textbox ${quote(dialog.defaultPrompt)} → browser_dialog text\n`
      : '') +
    `  - button "OK" → browser_dialog accept: true\n` +
    (dialog.type === 'alert'
      ? ''
      : `  - button "Cancel" → browser_dialog accept: false\n`)
  );
}

/** What the model learns of the person's answer about the downloads its action made. */
export function downloadDecision(keep: boolean, events: string[]): string {
  return [
    '### Download',
    keep
      ? 'The download was kept.'
      : 'The user did not keep the download; it was discarded.',
    ...events.map((event) => '- ' + event),
  ].join('\n');
}
