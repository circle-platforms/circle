/** How long a new session keeps the composer against the menu and the button
 * that opened it. After this, a click somewhere else keeps the keyboard. */
const HOLD_MS = 240;
let until = 0;
const listeners = new Set<() => void>();

export function requestComposerFocus(): void {
  until = performance.now() + HOLD_MS;
  for (const listener of listeners) listener();
}

export function composerFocusActive(): boolean {
  return performance.now() < until;
}

export function subscribeComposerFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Body, or the button that opened the session. A link or another field stays. */
function idleFocus(active: Element | null): boolean {
  if (
    !active ||
    active === document.body ||
    active === document.documentElement
  )
    return true;
  return active instanceof HTMLElement && !!active.closest('button');
}

/** Move the keyboard to the composer unless the person has chosen another field. */
function takeComposer(node: HTMLTextAreaElement | null): void {
  if (!node || document.activeElement === node) return;
  if (!idleFocus(document.activeElement)) return;
  node.focus({ preventScroll: true });
}

/** Focus now, on the next frames, and until the menu or button lets go. */
export function holdComposerFocus(
  node: () => HTMLTextAreaElement | null,
): () => void {
  let stopped = false;
  const timers: number[] = [];
  const frames: number[] = [];
  const take = () => {
    if (!stopped && composerFocusActive()) takeComposer(node());
  };
  take();
  queueMicrotask(take);
  frames.push(
    requestAnimationFrame(() => {
      take();
      frames.push(requestAnimationFrame(take));
    }),
  );
  const kick = () => {
    if (stopped || !composerFocusActive()) return;
    take();
    timers.push(window.setTimeout(kick, 40));
  };
  timers.push(window.setTimeout(kick, 0));
  const onWindowFocus = () => take();
  window.addEventListener('focus', onWindowFocus);
  return () => {
    stopped = true;
    window.removeEventListener('focus', onWindowFocus);
    for (const id of frames) cancelAnimationFrame(id);
    for (const id of timers) window.clearTimeout(id);
  };
}
