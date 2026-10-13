// How a conversation browser's dialogs and actions read in a tool result, the same in the
// desktop application and in the terminal's browser.
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

/** An element as the page script read it when an action used it: its role and name, as a snapshot shows them. */
export interface PageElement {
  role: string;
  name: string;
}
/** The element an action acted on, as the snapshot shows it: `e28 link "Host settings"`. */
export function actedOn(ref: string, element: PageElement): string {
  return `${ref} ${element.role}${element.name ? ` ${quote(element.name)}` : ''}`;
}
/**
 * What ends an action's sentence when the model described another element than the one its
 * ref named, so that it looks again: nothing when the description fits.
 */
export function describedOther(
  description: unknown,
  element: PageElement,
): string {
  return typeof description !== 'string' || describes(description, element)
    ? ''
    : ` — you described it as ${quote(description.trim())}; check the snapshot`;
}
/** The element named for the person, on the page's pointer and in an approval: the page's name first. */
export function shownName(element: PageElement, description: unknown): string {
  return (
    element.name ||
    (typeof description === 'string' ? description.trim() : '') ||
    element.role
  );
}
// Words that say what kind of control something is, not which one: "the Proceed link" is
// the link named "Proceed to …", "网络菜单" the one named "网络"
const KINDS = new Set([
  'a',
  'an',
  'the',
  'button',
  'link',
  'field',
  'box',
  'input',
  'textbox',
  'checkbox',
  'radio',
  'dropdown',
  'combobox',
  'select',
  'menu',
  'tab',
  'option',
  'icon',
]);
const KIND_WORDS =
  /单选按钮|下拉列表|下拉菜单|超链接|菜单项|输入框|文本框|下拉框|选项卡|标签页|复选框|单选框|按钮|链接|菜单|图标/g;
const fold = (value: string) =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
// One holds the other, spaces aside: "Login" is "Log in"
const holds = (one: string, other: string) => {
  const [a, b] = [one.replace(/ /g, ''), other.replace(/ /g, '')];
  return a.includes(b) || b.includes(a);
};
/**
 * Whether a description, a few words the model wrote for the user, can be of the element:
 * one holds the other, or every word of it but the kind of control is in the element's
 * name. An element without a name fits any description.
 */
export function describes(description: string, element: PageElement): boolean {
  const name = fold(element.name);
  const said = fold(description);
  if (!name || !said || holds(name, said)) return true;
  const role = fold(element.role);
  return said
    .replace(KIND_WORDS, ' ')
    .split(/[\s"'`“”‘’「」『』()（）[\]:：,，.。]+/u)
    .filter((word) => word && word !== role && !KINDS.has(word))
    .every((word) => name.includes(word));
}
// Words of a control that deletes, clears, resets or wipes something: the person confirms
// such a click first in manual mode, as a deleting command asks
const DESTRUCTIVE =
  /删除|移除|清除|清空|清理|重置|恢复出厂|出厂设置|格式化|卸载|销毁|丢弃|\b(?:delete|remove|erase|clear|purge|drop|destroy|reset|wipe|format|uninstall|discard|truncate)\b/i;
/** Whether a control's name, or a dialog's message, says it deletes something. */
export const destructive = (text: string): boolean => DESTRUCTIVE.test(text);
/** The role and name a browser result's snapshot gave a ref: `[e28] link "主机设置"`. */
export function snapshotElement(
  text: string,
  ref: string,
): PageElement | undefined {
  if (!/^e[1-9][0-9]*$/.test(ref)) return undefined;
  // Refs can stand mid-line, as in a table row
  const found = text.match(
    new RegExp(`\\[${ref}\\] (\\S+)(?: ("(?:[^"\\\\]|\\\\.)*"))?`),
  );
  if (!found) return undefined;
  let name = '';
  try {
    name = found[2] ? String(JSON.parse(found[2])) : '';
  } catch {
    /* a name cut by the snapshot's limit */
  }
  return { role: found[1]!, name };
}
/** What a browser result lists under "Dialogs waiting": the dialog with this id, or the first. */
export function waitingDialog(text: string, id?: unknown): string {
  const section =
    text.split('### Dialogs waiting')[1]?.split('\n### ')[0] ?? '';
  const lines = section.split('\n').filter((line) => line.startsWith('- ['));
  return (
    (typeof id === 'string' &&
      lines.find((line) => line.startsWith(`- [${id}]`))) ||
    lines[0] ||
    ''
  );
}
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
