// What an attached person's key becomes on the wire. The terminal interface has already
// read the keystroke; here it turns into the bytes a console expects. Ctrl-] never comes
// here: the session app lifts it out first, as the one key that leaves the console.
import { TERMINAL_KEYS } from './protocol.js';

// The names the key reader gives, as the console's own keys.
const KEY_BYTES: Record<string, string> = {
  enter: TERMINAL_KEYS.Enter!,
  'shift+enter': TERMINAL_KEYS.Enter!,
  tab: TERMINAL_KEYS.Tab!,
  'shift+tab': '\x1b[Z',
  escape: TERMINAL_KEYS.Escape!,
  backspace: TERMINAL_KEYS.Backspace!,
  delete: TERMINAL_KEYS.Delete!,
  up: TERMINAL_KEYS.ArrowUp!,
  down: TERMINAL_KEYS.ArrowDown!,
  left: TERMINAL_KEYS.ArrowLeft!,
  right: TERMINAL_KEYS.ArrowRight!,
  home: TERMINAL_KEYS.Home!,
  end: TERMINAL_KEYS.End!,
  pageup: TERMINAL_KEYS.PageUp!,
  pagedown: TERMINAL_KEYS.PageDown!,
};

/** The bytes for one key event while attached, or '' when the key belongs to Circle. */
export function terminalKeyBytes(key: string, char: string): string {
  const named = KEY_BYTES[key];
  if (named !== undefined) return named;
  // A control chord the reader names rather than delivers: ctrl+a through ctrl+z
  if (key.length > 5 && key.startsWith('ctrl+')) {
    const rest = key.slice(5);
    if (rest.length === 1 && rest >= 'a' && rest <= 'z')
      return String.fromCharCode(rest.charCodeAt(0) - 96);
    if (rest === '\\') return '\x1c';
    if (rest === ']') return ''; // the detach key; handled before this is asked
    return '';
  }
  if (key === 'char' || key === '') return char;
  // A printable character arrives with its name set to itself, or empty
  if (char) return char;
  return '';
}
