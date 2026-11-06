// The real hook under the name the transcript rows import it by. Each row calls it once for
// each render, with its own id, so this counts how often each row renders.
import { useSessionDisclosure as real } from '../src/model/presentation.ts';
export * from '../src/model/presentation.ts';

declare global {
  interface Window {
    rowRenders: Record<string, number>;
  }
}
window.rowRenders ??= {};
export function useSessionDisclosure(id: string, defaultOpen?: boolean) {
  window.rowRenders[id] = (window.rowRenders[id] ?? 0) + 1;
  return real(id, defaultOpen);
}
