/** Ctrl+N / new session. The keyboard moves to the composer in the same turn
 * the gesture starts, including off a sidebar row. Keys typed before the empty
 * session is committed are kept here so they are not written onto the previous
 * draft and then wiped. */
let pending = false;
let sealed = false;
let buffer = '';
let placed = false;
let generation = 0;
let raf = 0;
let captureOn = false;
let held: { el: HTMLElement; tabIndex: number } | null = null;
const listeners = new Set<() => void>();

export function composerFocusPending(): boolean {
  return pending;
}

export function composerFocusSealed(): boolean {
  return sealed;
}

/** True once buffered keys were handed to the empty session's draft. */
export function composerTextPlaced(): boolean {
  return placed;
}

export function composerHasBuffer(): boolean {
  return buffer.length > 0;
}

export function subscribeComposerFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  mark();
  for (const listener of listeners) listener();
}

/** While keys are held for the composer that is opening, the page says so. */
function mark(): void {
  if (typeof document === 'undefined') return;
  if (pending) document.documentElement.dataset.composerFocus = 'pending';
  else delete document.documentElement.dataset.composerFocus;
}

function composerNode(): HTMLTextAreaElement | null {
  const node = document.querySelector('.composer textarea');
  return node instanceof HTMLTextAreaElement ? node : null;
}

function restoreTab(): void {
  if (!held) return;
  held.el.tabIndex = held.tabIndex;
  held = null;
}

/** A session row is a link. While it is focused, typing and Enter stay on the list. */
function stealSidebar(): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  const link = active.closest('a.session-link');
  if (link instanceof HTMLElement) {
    if (!held || held.el !== link) {
      restoreTab();
      held = { el: link, tabIndex: link.tabIndex };
      link.tabIndex = -1;
    }
  }
  if (active.closest('aside.sidebar')) active.blur();
}

function focusComposer(): void {
  const node = composerNode();
  if (!node) return;
  if (document.activeElement !== node) node.focus({ preventScroll: true });
  if (buffer) {
    if (node.value !== buffer) node.value = buffer;
    node.setSelectionRange(buffer.length, buffer.length);
    return;
  }
  // Leftover draft: the next key replaces it if the clear has not committed yet.
  if (!sealed && node.value.length > 0)
    node.setSelectionRange(0, node.value.length);
}

function onKey(event: KeyboardEvent): void {
  if (!pending || sealed) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing)
    return;
  if (event.key === 'Backspace') {
    event.preventDefault();
    event.stopPropagation();
    buffer = buffer.slice(0, -1);
    focusComposer();
    return;
  }
  // Enter must not activate the session row, and must not send mid-switch.
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.key.length !== 1) return;
  event.preventDefault();
  event.stopPropagation();
  buffer += event.key;
  focusComposer();
}

/** If a key still inserts into the old composer, keep it in the buffer once. */
function onBeforeInput(event: InputEvent): void {
  if (!pending || sealed) return;
  if (event.inputType === 'insertText' && event.data) {
    event.preventDefault();
    event.stopPropagation();
    if (!buffer.endsWith(event.data)) buffer += event.data;
    focusComposer();
    return;
  }
  if (
    event.inputType === 'deleteContentBackward' ||
    event.inputType === 'insertLineBreak'
  ) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function installCapture(): void {
  if (captureOn || typeof window === 'undefined') return;
  captureOn = true;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('beforeinput', onBeforeInput, true);
}

function removeCapture(): void {
  if (!captureOn || typeof window === 'undefined') return;
  captureOn = false;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('beforeinput', onBeforeInput, true);
}

/** The keyboard is in a terminal. A later render must not pull it back to the composer. */
export function keyboardIsInTerminal(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  return (
    active instanceof Element && !!active.closest('.xterm, .device-screen')
  );
}

/** Focus the message box unless a terminal already has the keyboard. */
export function focusMessageComposer(
  node: HTMLTextAreaElement | null | undefined,
): void {
  if (!node || keyboardIsInTerminal()) return;
  if (document.activeElement !== node) node.focus({ preventScroll: true });
}

function scheduleRefocus(): void {
  if (typeof requestAnimationFrame !== 'function') return;
  const gen = generation;
  if (raf) cancelAnimationFrame(raf);
  // One frame later, only if the menu or the window took the keyboard back.
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (gen !== generation || keyboardIsInTerminal()) return;
    const node = composerNode();
    if (node && document.activeElement !== node)
      node.focus({ preventScroll: true });
  });
}

/** Call synchronously when the gesture starts, before any await. */
export function armComposerFocus(): void {
  if (typeof document === 'undefined') return;
  // A second arm in the same gesture (the key handler, then the command)
  // must keep keys already typed.
  if (pending && !sealed) {
    stealSidebar();
    focusComposer();
    return;
  }
  generation += 1;
  pending = true;
  sealed = false;
  placed = false;
  buffer = '';
  restoreTab();
  installCapture();
  stealSidebar();
  focusComposer();
  notify();
}

/** The empty session is current. Hand buffered keys to it and focus once. */
export function sealComposerFocus(): void {
  if (typeof document === 'undefined') return;
  if (!pending) {
    generation += 1;
    pending = true;
    placed = false;
    buffer = '';
  }
  if (!sealed) {
    sealed = true;
    removeCapture();
  }
  restoreTab();
  focusComposer();
  notify();
  scheduleRefocus();
}

/** Buffered keys for the empty session. Empty after the first read. */
export function takeComposerText(): string {
  if (!sealed) return '';
  const text = buffer;
  buffer = '';
  if (text) placed = true;
  return text;
}

/** The composer has the keyboard. Later session changes must not steal it back. */
export function claimComposerFocus(): void {
  pending = false;
  sealed = false;
  buffer = '';
  removeCapture();
  restoreTab();
  mark();
}

/** The gesture failed before the empty session was shown. Release the keyboard. */
export function cancelComposerFocus(): void {
  if (!pending || sealed) return;
  generation += 1;
  pending = false;
  placed = false;
  buffer = '';
  removeCapture();
  restoreTab();
  mark();
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}
