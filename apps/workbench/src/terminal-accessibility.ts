import { useSyncExternalStore } from 'react';
import type { NativeAccessibilityState } from '../../desktop/src/contracts';
export type TerminalAccessibilityChoice = 'auto' | 'always';
const key = 'circle-terminal-accessibility';
let choice: TerminalAccessibilityChoice = 'auto';
try {
  if (
    typeof localStorage !== 'undefined' &&
    localStorage.getItem(key) === 'always'
  )
    choice = 'always';
} catch {
  /* An unavailable preference store keeps the accessible default. */
}
let host: NativeAccessibilityState | undefined;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
let generation = 0;
const notify = () => {
  for (const listener of listeners) listener();
};
const enabled = () => choice === 'always' || !host?.supported || host.enabled;
const receive = (state: NativeAccessibilityState) => {
  if (
    !state ||
    typeof state.supported !== 'boolean' ||
    typeof state.enabled !== 'boolean' ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    (host && state.revision < host.revision)
  )
    return;
  host = state;
  notify();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const epoch = ++generation;
    host = undefined;
    const bridge =
      typeof window === 'undefined' ? undefined : window.circleDesktop;
    // Older hosts and web previews remain enabled. Subscribe before reading so
    // a consumer activating native accessibility cannot lose its event.
    if (bridge?.nativeAccessibility && bridge.onNativeAccessibility) {
      stop = bridge.onNativeAccessibility((state) => {
        if (generation === epoch) receive(state);
      });
      void bridge.nativeAccessibility().then(
        (state) => {
          if (generation === epoch) receive(state);
        },
        () => {},
      );
    }
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      generation++;
      stop?.();
      stop = undefined;
      host = undefined;
    }
  };
}
export function setTerminalAccessibility(value: TerminalAccessibilityChoice) {
  if (value !== 'auto' && value !== 'always') return;
  choice = value;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The current choice still applies to this window. */
  }
  notify();
}
export const useTerminalScreenReader = () =>
  useSyncExternalStore(subscribe, enabled, () => true);
export const useTerminalAccessibilityChoice = () =>
  useSyncExternalStore(
    subscribe,
    () => choice,
    () => 'auto' as const,
  );
