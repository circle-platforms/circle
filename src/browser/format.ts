// How a conversation browser's dialogs read in a tool result, the same in the desktop
// application and in the terminal's browser.
export interface PageDialog {
  id: string;
  tab: string;
  /** `auth`: the site, or a proxy, asks for a user name and password (HTTP sign-in). */
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'auth';
  message: string;
  defaultPrompt: string;
  origin: string;
  /** A sign-in's realm, as the site names it. */
  realm?: string;
  /** A sign-in a proxy asks for, not the site. */
  proxy?: boolean;
}
export const quote = (value: string) => JSON.stringify(value);
/** One line of "Dialogs waiting". */
export function dialogLine(dialog: PageDialog): string {
  if (dialog.type === 'auth')
    return `- [${dialog.id}] sign-in · tab ${dialog.tab} · ${dialog.proxy ? 'the proxy' : 'the site'} ${dialog.origin}${dialog.realm ? ` (${quote(dialog.realm)})` : ''} asks for a user name and password → browser_dialog with text and password, or accept: false`;
  const what =
    dialog.type === 'beforeunload'
      ? 'the page asks whether to leave it; accept leaves, dismiss stays'
      : `${quote(dialog.message)}${dialog.type === 'prompt' ? ` (default answer ${quote(dialog.defaultPrompt)})` : ''}`;
  return `- [${dialog.id}] ${dialog.type} · tab ${dialog.tab} · from ${dialog.origin || 'the page'}: ${what} → browser_dialog`;
}
/** What the model's answer to a sign-in did; `again`: the site asked once more. */
export function signInAnswered(
  dialog: PageDialog,
  accept: boolean,
  user: string,
  again: boolean,
): string {
  return accept
    ? `Answered sign-in ${dialog.id} for ${dialog.origin} as ${quote(user)}${again ? '; it asks again, so the user name or password was not accepted' : ''}.`
    : `Cancelled sign-in ${dialog.id}.`;
}
/** What a navigation that ends at a dialog says. */
export function dialogOpened(dialog: PageDialog): string {
  return dialog.type === 'auth'
    ? `The ${dialog.proxy ? 'proxy' : 'site'} asks for a sign-in: dialog ${dialog.id}.`
    : `The page opened dialog ${dialog.id}.`;
}
/** The snapshot of a tab whose page waits on a dialog: the dialog is all there is to act on. */
export function dialogSnapshot(dialog: PageDialog): string {
  if (dialog.type === 'auth')
    return (
      `The page waits for sign-in ${dialog.id}; this is the browser's sign-in dialog:\n` +
      `- dialog sign-in [${dialog.id}] from ${dialog.proxy ? 'the proxy ' : ''}${dialog.origin}\n` +
      (dialog.realm ? `  - text ${quote(dialog.realm)}\n` : '') +
      `  - textbox "Username" → browser_dialog text\n` +
      `  - password "Password" → browser_dialog password, only a saved secret's %NAME%\n` +
      `  - button "Sign in" → browser_dialog accept: true\n` +
      `  - button "Cancel" → browser_dialog accept: false\n`
    );
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
