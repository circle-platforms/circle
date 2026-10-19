// Which window's browser panel has that window's keyboard. No Electron here, so the
// routing can be checked by itself.
import {
  browserShortcut,
  type BrowserKeyAction,
  type BrowserKeyInput,
} from './browser-controls';

/**
 * The system's menu takes some of the browser's keys (⌘W closes the window) before the
 * window sees them, so while a browser panel has its window's keyboard those keys are the
 * panel's. A window holds the keyboard for one conversation, and only while it shows that
 * conversation's pages: a key typed in any other window, or in this one once the pages have
 * moved on, is that window's own, as if there were no browser.
 */
export class PanelKeys<W> {
  private holders = new Map<W, string>();
  /** `hostOf` names the window that shows a conversation's pages; nothing while it has none. */
  constructor(private hostOf: (conversation: string) => W | undefined) {}

  /** The panel of `window` took its keyboard for `conversation` (true), or let it go. */
  report(window: W, conversation: string, focused: boolean): boolean {
    if (!focused) {
      if (this.holders.get(window) === conversation)
        this.holders.delete(window);
      return false;
    }
    // A panel whose window does not show the pages has no keys to take for them.
    if (this.hostOf(conversation) !== window) return false;
    this.holders.set(window, conversation);
    return true;
  }

  /** The conversation whose browser takes a shortcut typed in `window`, if any. */
  holder(window: W): string | undefined {
    const conversation = this.holders.get(window);
    if (conversation === undefined) return undefined;
    if (this.hostOf(conversation) === window) return conversation;
    this.holders.delete(window);
    return undefined;
  }

  /** The conversation's pages moved to another window, or the conversation is gone. */
  forgetConversation(conversation: string) {
    for (const [window, held] of [...this.holders])
      if (held === conversation) this.holders.delete(window);
  }

  /** The window's page went away, closed or reloaded: so did its panel. */
  forgetWindow(window: W) {
    this.holders.delete(window);
  }
}

/** The browser action a key pressed in a window is, if any. Escape stays the field's. */
export function windowShortcut(
  input: BrowserKeyInput & { type: string },
  platform: string,
): BrowserKeyAction | undefined {
  if (input.type !== 'keyDown') return undefined;
  const action = browserShortcut(input, platform);
  return action === 'stop' ? undefined : action;
}
