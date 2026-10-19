import type { PopoutEvent, PopoutKind, PopoutState } from './contracts';

// The browser and the terminal can leave the drawer for a window of their own, one window
// for each such mode of a conversation. This keeps which windows there are, so opening one
// that is open brings it forward, and closing a window by hand puts its mode back in the
// drawer. What a window is (an Electron window, its page, its views) is the factory's.

export interface PopoutWindow {
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  close(): void;
  setTitle(title: string): void;
}

export const popoutKinds: readonly PopoutKind[] = ['browser', 'terminal'];

/** The longest window title: the renderer shortens a conversation's title to fit. */
export const MAX_POPOUT_TITLE = 200;

export function validPopoutKind(value: unknown): PopoutKind {
  if (value !== 'browser' && value !== 'terminal')
    throw Error('invalid window kind');
  return value;
}
export function validPopoutSession(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw Error('invalid conversation');
  return value;
}
export function validPopoutTitle(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_POPOUT_TITLE
  )
    throw Error('invalid window title');
  return value.replace(/[\u0000-\u001f]/g, ' ').trim();
}
/**
 * An address the main window has the browser's window open, as the drawer's browser
 * would (an extension's api.openUrl): http or https, with no user name or password.
 */
export function validPopoutAddress(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096)
    throw Error('invalid address');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error('invalid address');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error('invalid address');
  return url.href;
}

const keyOf = (kind: PopoutKind, sessionId: string) => `${kind}:${sessionId}`;
const stateOf = (key: string): PopoutState => {
  const [kind, ...rest] = key.split(':');
  return { kind: kind as PopoutKind, sessionId: rest.join(':') };
};

/** What the factory tells the registry while it makes a window. */
export interface PopoutHooks<W> {
  /**
   * The window exists, before its page is loaded: from here it is one of the application's
   * windows, and may be asked for what the page needs to start.
   */
  created: (window: W) => void;
  /**
   * The window has begun to close. From here it is gone: its mode is in the drawer again,
   * and opening the mode makes a new window. Its page is still answered until it closes.
   */
  closing: () => void;
  /** The window has been closed, however it was. */
  closed: () => void;
}

export class Popouts<W extends PopoutWindow> {
  /** The window of each mode, including one whose page is still loading. */
  private windows = new Map<string, W>();
  /** The windows whose page is up and which the application has been told about. */
  private ready = new Set<string>();
  /** Windows on their way out, with the mode each showed. */
  private closing = new Map<W, string>();
  private opening = new Map<string, { made?: Promise<void> }>();
  constructor(
    private options: {
      /** Makes the window and loads its page. */
      create: (
        kind: PopoutKind,
        sessionId: string,
        title: string,
        hooks: PopoutHooks<W>,
      ) => Promise<W>;
      onChange: (event: PopoutEvent) => void;
    },
  ) {}

  list(): PopoutState[] {
    return [...this.ready].map(stateOf);
  }
  has(kind: PopoutKind, sessionId: string): boolean {
    return this.ready.has(keyOf(kind, sessionId));
  }
  window(kind: PopoutKind, sessionId: string): W | undefined {
    return this.windows.get(keyOf(kind, sessionId));
  }
  /**
   * Every window, including one whose page is still loading and one that is closing: they
   * have to be answered.
   */
  all(): W[] {
    return [...this.windows.values(), ...this.closing.keys()];
  }
  /** The mode and conversation a window shows, while it is one of these windows. */
  owner(window: W): PopoutState | undefined {
    for (const [key, one] of this.windows)
      if (one === window) return stateOf(key);
    const key = this.closing.get(window);
    return key === undefined ? undefined : stateOf(key);
  }

  /** Opens the window, or brings it forward when it is open already. */
  open(kind: PopoutKind, sessionId: string, title: string): Promise<void> {
    const key = keyOf(kind, sessionId);
    // Two presses before the first window is up make one window.
    const pending = this.opening.get(key)?.made;
    if (pending) return pending;
    const open = this.windows.get(key);
    if (open && !open.isDestroyed()) {
      open.setTitle(title);
      open.show();
      open.focus();
      return Promise.resolve();
    }
    const attempt: { made?: Promise<void> } = {};
    this.opening.set(key, attempt);
    let window: W | undefined;
    let ended = false;
    // This window is gone: the mode is in the drawer again, unless another window has
    // taken its place meanwhile.
    const gone = () => {
      ended = true;
      if (this.opening.get(key) === attempt) this.opening.delete(key);
      if (!window || this.windows.get(key) !== window) return;
      this.windows.delete(key);
      if (this.ready.delete(key))
        this.options.onChange({ kind, sessionId, open: false });
    };
    attempt.made = (async () => {
      const loaded = await this.options.create(kind, sessionId, title, {
        created: (created) => {
          window = created;
          this.windows.set(key, created);
        },
        closing: () => {
          if (window && !window.isDestroyed()) this.closing.set(window, key);
          gone();
        },
        closed: () => {
          if (window) this.closing.delete(window);
          gone();
        },
      });
      if (ended || loaded.isDestroyed()) return;
      window = loaded;
      this.windows.set(key, loaded);
      this.ready.add(key);
      this.options.onChange({ kind, sessionId, open: true });
    })().finally(() => {
      if (this.opening.get(key) === attempt) this.opening.delete(key);
    });
    return attempt.made;
  }

  /** Closes a window: its mode is in the drawer again. */
  dock(kind: PopoutKind, sessionId: string): void {
    const window = this.windows.get(keyOf(kind, sessionId));
    if (window && !window.isDestroyed()) window.close();
  }

  /** Closes every window, as when another conversation is shown, or the application quits. */
  dockAll(): void {
    for (const window of [...this.windows.values()])
      if (!window.isDestroyed()) window.close();
  }

  /** Closes the windows of every conversation but one. */
  dockOthers(sessionId: string): void {
    for (const [key, window] of [...this.windows.entries()])
      if (!key.endsWith(`:${sessionId}`) && !window.isDestroyed())
        window.close();
  }
}
