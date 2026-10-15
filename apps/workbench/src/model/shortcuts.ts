export const KEY_ACTIONS = {
  interrupt: 'escape',
  clear: 'ctrl+c',
  exit: 'ctrl+d',
  suspend: 'ctrl+z',
  'model.select': 'ctrl+shift+m',
  'session.select': 'alt+s',
  'model.cycle': 'alt+m',
  'mode.cycle': 'shift+tab',
  'thinking.cycle': 'alt+t',
  'plan.focus': 'alt+p',
  'thinking.toggle': 'ctrl+t',
  'tools.expand': 'ctrl+o',
  'editor.external': 'ctrl+g',
  'message.copy': 'alt+c',
  'message.dequeue': 'alt+up',
  'message.followup': 'ctrl+q',
  'image.paste': 'ctrl+v',
  find: 'ctrl+f',
  'history.search': 'ctrl+r',
  'secret.enter': 'ctrl+alt+s',
  newline: 'ctrl+j',
  'job.background': 'alt+b',
  'sidebar.toggle': 'ctrl+b',
} as const;
/** Defaults, then the user's overrides. An override replaces that action's key. */
export function effectiveBindings(
  overrides: Record<string, string | string[]> = {},
): Record<string, string | string[]> {
  return { ...KEY_ACTIONS, ...overrides };
}
export function chordFromEvent(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string {
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
  // Command on macOS is the same chord as Ctrl in the saved names.
  const command = event.ctrlKey || event.metaKey;
  return (
    (command ? 'ctrl+' : '') +
    (event.altKey ? 'alt+' : '') +
    (event.shiftKey ? 'shift+' : '') +
    key
  );
}
/** Desktop session search. The header menu and the shortcut list both show this chord. */
export const DESKTOP_SEARCH_CHORD = 'ctrl+k';
export function isDesktopSearch(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): boolean {
  return chordFromEvent(event) === DESKTOP_SEARCH_CHORD;
}
/** Desktop new session. The File menu owns this chord in the app window. */
export const DESKTOP_NEW_SESSION_CHORD = 'ctrl+n';
export function isDesktopNewSession(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): boolean {
  return chordFromEvent(event) === DESKTOP_NEW_SESSION_CHORD;
}
/** Desktop settings. Not a terminal binding, so it stays out of KEY_ACTIONS. */
export const DESKTOP_SETTINGS_CHORD = 'ctrl+,';
export function isDesktopSettings(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): boolean {
  return chordFromEvent(event) === DESKTOP_SETTINGS_CHORD;
}
export function formatChord(chord: string): string {
  const mac =
    typeof document !== 'undefined' &&
    document.documentElement.dataset.desktop === 'darwin';
  return chord
    .split('+')
    .map((part) => {
      if (part === 'ctrl') return mac ? '⌘' : 'Ctrl';
      if (part === 'alt') return mac ? '⌥' : 'Alt';
      if (part === 'shift') return mac ? '⇧' : 'Shift';
      if (part === 'meta') return mac ? '⌘' : 'Meta';
      if (part === 'escape') return 'Esc';
      if (part.length === 1) return part.toUpperCase();
      const word = (
        {
          up: 'Up',
          down: 'Down',
          left: 'Left',
          right: 'Right',
          tab: 'Tab',
          enter: 'Enter',
          space: 'Space',
        } as Record<string, string>
      )[part];
      return word ?? part;
    })
    .join('+');
}
export type KeyAction = keyof typeof KEY_ACTIONS;
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
      if (
        !/^(?:(?:ctrl|alt|shift|meta)\+)*(?:[a-z0-9]|escape|up|down|left|right|enter|tab|backspace|delete|home|end|pageup|pagedown|f(?:[1-9]|1[0-2]))$/.test(
          key,
        )
      )
        throw Error('invalid key: ' + key);
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
  const chord = chordFromEvent(event);
  for (const [action, keys] of Object.entries(bindings)) {
    if ((typeof keys === 'string' ? [keys] : keys).includes(chord))
      return action as KeyAction;
  }
  return undefined;
}
