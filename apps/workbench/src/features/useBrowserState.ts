import { useEffect, useState } from 'react';
import type { BrowserState } from '../../../desktop/src/contracts';
import { desktopHost } from '../host';
import { isSessionBrowser } from '../model/browser';

/** The conversation's browser as the main process reports it, kept current. */
export function useBrowserState(sessionId: string): BrowserState | null {
  const [state, setState] = useState<BrowserState | null>(null);
  useEffect(() => {
    const host = desktopHost();
    if (!host) return;
    let mounted = true;
    setState(null);
    const receive = (value: BrowserState) => {
      if (mounted && isSessionBrowser(value, sessionId)) setState(value);
    };
    const unsubscribe = host.onBrowserEvent(receive);
    void host
      .browserState(sessionId)
      .then(receive)
      .catch(() => {});
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [sessionId]);
  return state;
}
