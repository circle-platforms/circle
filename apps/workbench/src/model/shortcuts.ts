/**
 * The desktop's default keys. `ctrl` is the Control key, as in the terminal, on every
 * system. `mod` is the platform's command key: ⌘ on macOS, Ctrl on Windows and Linux.
 * On macOS ⌘ belongs to the system's editing keys (⌘C, ⌘V, ⌘Z, ⌘A, ⌘←…) and to
 * the window's own commands; only the actions written with `mod` take a ⌘ chord.
 */
export const KEY_ACTIONS = {
  interrupt: 'escape',
  clear: 'ctrl+c',
  exit: 'ctrl+d',
  suspend: 'ctrl+z',
  'model.select': 'mod+shift+m',
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
  find: 'mod+f',
  'history.search': 'ctrl+r',
  'secret.enter': 'ctrl+alt+s',
  newline: 'ctrl+j',
  'job.background': 'alt+b',
  'sidebar.toggle': 'mod+b',
} as const;
/** Defaults, then the user's overrides. An override replaces that action's key. */
export function effectiveBindings(
  overrides: Record<string, string | string[]> = {},
): Record<string, string | string[]> {
  return { ...KEY_ACTIONS, ...overrides };
}
type KeyEvent = {
  key: string;
  /** The key pressed, whatever it types: `KeyP` for ⌥P, which types π on macOS. */
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};
/**
 * Whether ⌘ and Control are told apart: the macOS desktop, or the browser preview on a
 * Mac. Outside a page (unit tests) it is false unless the caller says otherwise.
 */
export function macKeyboard(): boolean {
  if (typeof document === 'undefined') return false;
  const desktop = document.documentElement.dataset.desktop;
  if (desktop) return desktop === 'darwin';
  return typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
}
const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const;
/**
 * One spelling for a chord: modifiers in a fixed order, and `mod` resolved for the
 * platform. Windows and Linux keep the old reading of Meta as Ctrl, so a saved
 * `meta+x` and `ctrl+x` are the same chord there.
 */
export function normalizeChord(chord: string, mac = macKeyboard()): string {
  const parts = chord.split('+');
  // A chord such as ctrl++ names the plus key itself.
  const key = chord.endsWith('++') ? '+' : parts.pop()!;
  const held = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    const name = part.toLowerCase();
    if (name === 'mod') held.add(mac ? 'meta' : 'ctrl');
    else if (name === 'meta' && !mac) held.add('ctrl');
    else held.add(name);
  }
  return [...MODIFIERS.filter((name) => held.has(name)), key].join('+');
}
export function chordFromEvent(event: KeyEvent, mac = macKeyboard()): string {
  // On macOS ⌥ turns a letter or a digit into another character (⌥P types π): an alt
  // chord is the key pressed. Elsewhere Alt with Ctrl is AltGr, which types characters.
  const pressed =
    mac && event.altKey
      ? /^(?:Key([A-Z])|Digit(\d))$/.exec(event.code ?? '')
      : null;
  const key = pressed
    ? (pressed[1] ?? pressed[2]!).toLowerCase()
    : ((
        {
          ArrowUp: 'up',
          ArrowDown: 'down',
          ArrowLeft: 'left',
          ArrowRight: 'right',
          Escape: 'escape',
        } as Record<string, string>
      )[event.key] ?? event.key.toLowerCase());
  // On macOS ⌘ is its own modifier: the terminal's ctrl chords are the Control key
  // there too, and ⌘ chords stay the system's. Elsewhere the Windows or Super key
  // reads as Ctrl, as it always did.
  const ctrl = mac ? event.ctrlKey : event.ctrlKey || event.metaKey;
  const meta = mac && event.metaKey;
  return (
    (ctrl ? 'ctrl+' : '') +
    (event.altKey ? 'alt+' : '') +
    (event.shiftKey ? 'shift+' : '') +
    (meta ? 'meta+' : '') +
    key
  );
}
/** Whether the event is this chord, written with `mod`, `ctrl`, `meta` or neither. */
export function isChord(
  event: KeyEvent,
  chord: string,
  mac = macKeyboard(),
): boolean {
  return chordFromEvent(event, mac) === normalizeChord(chord, mac);
}
/** Desktop session search. The header menu and the shortcut list both show this chord. */
export const DESKTOP_SEARCH_CHORD = 'mod+k';
export function isDesktopSearch(event: KeyEvent, mac = macKeyboard()): boolean {
  return isChord(event, DESKTOP_SEARCH_CHORD, mac);
}
/** Quick open: search with an empty field. */
export const DESKTOP_QUICK_OPEN_CHORD = 'mod+p';
/** Desktop new session. The File menu owns this chord in the app window. */
export const DESKTOP_NEW_SESSION_CHORD = 'mod+n';
export function isDesktopNewSession(
  event: KeyEvent,
  mac = macKeyboard(),
): boolean {
  return isChord(event, DESKTOP_NEW_SESSION_CHORD, mac);
}
/** Desktop settings. Not a terminal binding, so it stays out of KEY_ACTIONS. */
export const DESKTOP_SETTINGS_CHORD = 'mod+,';
export function isDesktopSettings(
  event: KeyEvent,
  mac = macKeyboard(),
): boolean {
  return isChord(event, DESKTOP_SETTINGS_CHORD, mac);
}
/**
 * Whether a key pressed in a terminal belongs to the terminal and not to the window.
 * A terminal (the terminal panel, a device console: xterm) sends every key it gets
 * to its shell, so Ctrl+K there is the byte ^K and Ctrl+B moves the cursor back. On
 * macOS ⌘ is no terminal key: ⌘K, ⌘P, ⌘, and ⌘B stay the window's commands.
 */
export function terminalOwnsKey(
  event: KeyEvent & { target: EventTarget | null },
  mac = macKeyboard(),
): boolean {
  const target = event.target as {
    closest?: (selector: string) => unknown;
  } | null;
  if (typeof target?.closest !== 'function' || !target.closest('.xterm'))
    return false;
  return !(mac && event.metaKey);
}
export function formatChord(chord: string, mac = macKeyboard()): string {
  return normalizeChord(chord, mac)
    .split(/\+(?!$)/)
    .map((part) => {
      // Control is ⌃ on macOS; ⌘ is written meta (or mod) and shows as ⌘.
      if (part === 'ctrl') return mac ? '⌃' : 'Ctrl';
      if (part === 'alt') return mac ? '⌥' : 'Alt';
      if (part === 'shift') return mac ? '⇧' : 'Shift';
      if (part === 'meta') return '⌘';
      if (part === 'escape') return 'Esc';
      if (part.length === 1) return part.toUpperCase();
      // A function key stays in the spelling that was saved (f3). Uppercasing
      // it hid the new chord from the settings row.
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
        !/^(?:(?:ctrl|alt|shift|meta|mod)\+)*(?:[a-z0-9]|escape|up|down|left|right|enter|tab|backspace|delete|home|end|pageup|pagedown|f(?:[1-9]|1[0-2]))$/.test(
          key,
        )
      )
        throw Error('invalid key: ' + key);
  }
  return value as Record<string, string | string[]>;
}
export function matchingAction(
  event: KeyEvent,
  bindings: Record<string, string | string[]>,
  mac = macKeyboard(),
): KeyAction | undefined {
  const chord = chordFromEvent(event, mac);
  for (const [action, keys] of Object.entries(bindings)) {
    if (
      (typeof keys === 'string' ? [keys] : keys).some(
        (key) => normalizeChord(key, mac) === chord,
      )
    )
      return action as KeyAction;
  }
  return undefined;
}
