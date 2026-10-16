import { t } from '../i18n/index.ts';

export const KEY_ACTIONS = {
  interrupt: 'escape',
  clear: 'ctrl+c',
  exit: 'ctrl+d',
  suspend: 'ctrl+z',
  'model.select': 'ctrl+l',
  'model.cycle': 'ctrl+p',
  'mode.cycle': 'shift+tab',
  'thinking.cycle': 'alt+t',
  'plan.focus': 'alt+p',
  'thinking.toggle': 'ctrl+t',
  'tools.expand': 'ctrl+o',
  'editor.external': 'ctrl+g',
  'message.copy': 'ctrl+x',
  'message.dequeue': 'alt+up',
  'message.followup': 'ctrl+q',
  'image.paste': 'ctrl+v',
  find: 'ctrl+f',
  'history.search': 'ctrl+r',
  'secret.enter': 'ctrl+s',
  newline: 'ctrl+j',
  'job.background': 'ctrl+b',
} as const;
export type KeyAction = keyof typeof KEY_ACTIONS;
/** What an action does, in the words the keyboard page lists beside its key. */
export const KEY_ACTION_TEXT: Record<KeyAction, () => string> = {
  interrupt: () => t('stop the current turn'),
  clear: () => t('stop the turn, or clear the box'),
  exit: () => t('close Circle'),
  suspend: () => t('pause Circle and go back to the shell'),
  'model.select': () => t('choose a model'),
  'model.cycle': () => t('switch to the next model'),
  'mode.cycle': () => t('switch to the next approval mode'),
  'thinking.cycle': () => t('switch to the next thinking depth'),
  'plan.focus': () => t('focus the plan'),
  'thinking.toggle': () => t('show or fold the thinking'),
  'tools.expand': () => t('show or fold tool output'),
  'editor.external': () => t('write the message in a larger editor'),
  'message.copy': () => t('copy the last answer'),
  'message.dequeue': () => t('take back queued messages'),
  'message.followup': () => t('queue a follow-up for after the turn'),
  'image.paste': () => t('paste a picture'),
  find: () => t('find in conversation'),
  'history.search': () => t('search earlier messages'),
  'secret.enter': () => t('enter a secret'),
  newline: () => t('start a new line'),
  'job.background': () => t('move the running command to the background'),
};
const CHORD =
  /^(?:(?:ctrl|alt|shift|meta)\+)*(?:[a-z0-9]|escape|up|down|left|right|enter|tab|backspace|delete|home|end|pageup|pagedown|f(?:[1-9]|1[0-2]))$/;
/** A key this app can bind, written the way `keybindings.json` writes it. */
export const isChord = (key: string): boolean => CHORD.test(key);
/**
 * A letter or a digit alone would swallow ordinary typing, so a binding takes one
 * only with a modifier. `f2` and `escape` name a key of their own.
 */
export const isBindableChord = (key: string): boolean =>
  isChord(key) && (key.includes('+') || !/^[a-z0-9]$/.test(key));
const NAMED_KEYS: Record<string, string> = {
  Escape: 'escape',
  Enter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};
/** A key that names no action on its own: nothing to bind while it is held. */
const BARE_MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta']);
/**
 * The chord a key press names, as `keybindings.json` writes it, or null when the
 * press names none (a modifier on its own, or a key this app cannot bind).
 */
export function chordFromEvent(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  if (BARE_MODIFIERS.has(event.key)) return null;
  const key =
    NAMED_KEYS[event.key] ??
    (event.key.length === 1
      ? event.key.toLowerCase()
      : event.key.toLowerCase());
  const chord =
    (event.ctrlKey ? 'ctrl+' : '') +
    (event.altKey ? 'alt+' : '') +
    (event.shiftKey ? 'shift+' : '') +
    (event.metaKey ? 'meta+' : '') +
    key;
  return isChord(chord) ? chord : null;
}
const KEY_TEXT: Record<string, string> = {
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};
const MODIFIER_TEXT: Record<string, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
};
const MODIFIER_SYMBOL: Record<string, string> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  meta: '⌘',
};
/** A chord as a person reads it on the keyboard: `Ctrl+K`, `⌘K`, `↑`. */
export function formatChord(chord: string, mac = false): string {
  const parts = chord.split('+');
  const key = parts.at(-1)!;
  const named = KEY_TEXT[key] ?? key.toUpperCase();
  const modifiers = parts.slice(0, -1);
  if (!modifiers.length) return named;
  return mac
    ? modifiers.map((part) => MODIFIER_SYMBOL[part] ?? part).join('') + named
    : [...modifiers.map((part) => MODIFIER_TEXT[part] ?? part), named].join(
        '+',
      );
}
export function validateKeybindings(
  value: unknown,
): Record<string, string | string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('keybindings must be an object');
  for (const [action, keys] of Object.entries(value)) {
    if (!(action in KEY_ACTIONS)) throw Error('unknown key action: ' + action);
    if (!(
      typeof keys === 'string' ||
      (Array.isArray(keys) && keys.every((key) => typeof key === 'string'))
    ))
      throw Error('keys must be a string or list of strings');
    for (const key of typeof keys === 'string' ? [keys] : keys)
      if (!isChord(key)) throw Error('invalid key: ' + key);
  }
  return value as Record<string, string | string[]>;
}
export function matchingAction(
  event: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  },
  bindings: Record<string, string | string[]>,
): KeyAction | undefined {
  const key =
    (
      {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
        Escape: 'escape',
      } as Record<string, string>
    )[event.key] ?? event.key.toLowerCase();
  const chord =
    (event.ctrlKey ? 'ctrl+' : '') +
    (event.altKey ? 'alt+' : '') +
    (event.shiftKey ? 'shift+' : '') +
    (event.metaKey ? 'meta+' : '') +
    key;
  for (const [action, keys] of Object.entries(bindings)) {
    if ((typeof keys === 'string' ? [keys] : keys).includes(chord))
      return action as KeyAction;
  }
  return undefined;
}
