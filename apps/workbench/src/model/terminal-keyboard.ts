// Clicking a terminal must take the keyboard before the next key, including a key
// that arrives while a click's render is still moving focus back to the composer.
// The claim lasts long enough for that render and no longer: a later click outside
// the terminal releases it, and so does the keyboard going to any other field (find,
// a dialog, a secret's field). Only keys that land in the composer are taken.

const CLAIM_MS = 600;
let until = 0;
let focusTerm: (() => void) | null = null;
let typeTerm: ((text: string) => void) | null = null;
let installed = false;

/** True while a click in the terminal still owns the keyboard. */
export function terminalKeyboardClaimed(): boolean {
  return Date.now() < until;
}

function release(): void {
  until = 0;
  focusTerm = null;
  typeTerm = null;
}

function reclaim(): void {
  focusTerm?.();
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('beforeinput', onBefore, true);
  window.addEventListener('pointerdown', onPointer, true);
}

function onPointer(event: PointerEvent): void {
  if (!terminalKeyboardClaimed()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('.native-terminal-screen, .device-screen, .xterm')) return;
  release();
}

/** The message box, where a render may put the keyboard back after the click. */
function inComposer(target: EventTarget | null): target is Element {
  return (
    target instanceof Element &&
    !target.closest('.xterm, .device-screen, .native-terminal-screen') &&
    !!target.closest('.composer')
  );
}

function onFocusIn(event: FocusEvent): void {
  if (!terminalKeyboardClaimed()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('.xterm, .device-screen, .native-terminal-screen')) return;
  // Another field took the keyboard on purpose: its keys are its own.
  if (!inComposer(target)) {
    release();
    return;
  }
  reclaim();
}

/**
 * A plain key that lands in the composer during the claim is typed into the terminal:
 * the composer is where a render puts the keyboard back, including for the first key
 * after the click. A key for any other field stays there.
 */
function onKey(event: KeyboardEvent): void {
  if (!terminalKeyboardClaimed() || event.isComposing) return;
  if (!inComposer(event.target)) return;
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.key.length !== 1
  ) {
    reclaim();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  reclaim();
  typeTerm?.(event.key);
}

function onBefore(event: InputEvent): void {
  if (!terminalKeyboardClaimed()) return;
  if (!inComposer(event.target)) return;
  if (
    event.inputType !== 'insertText' &&
    event.inputType !== 'insertCompositionText'
  )
    return;
  event.preventDefault();
  event.stopPropagation();
}

/**
 * The pointer went down in a terminal. Focus it now, and keep the composer from
 * taking the keyboard back for a short while after the click.
 */
export function claimTerminalKeyboard(
  focus: () => void,
  type: (text: string) => void,
): void {
  until = Date.now() + CLAIM_MS;
  focusTerm = focus;
  typeTerm = type;
  install();
  focus();
  const tick = () => {
    if (!terminalKeyboardClaimed()) return;
    const active = document.activeElement;
    if (active instanceof Element && active.closest('.composer')) reclaim();
    requestAnimationFrame(tick);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
}
