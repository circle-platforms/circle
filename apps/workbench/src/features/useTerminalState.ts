import { useEffect, useState } from 'react';
import type {
  TerminalEvent,
  TerminalState,
} from '../../../desktop/src/contracts';
import { desktopHost } from '../host';

// The conversation's device consoles as the main process holds them, kept current.
export const isSessionTerminal = (state: TerminalState, sessionId: string) =>
  state.sessionId === 'terminal:' + sessionId;

export function useTerminalState(sessionId: string): TerminalState | null {
  const [state, setState] = useState<TerminalState | null>(null);
  useEffect(() => {
    const host = desktopHost();
    if (!host) return;
    let mounted = true;
    setState(null);
    const receive = (event: TerminalEvent) => {
      if (
        mounted &&
        event.kind === 'state' &&
        isSessionTerminal(event.state, sessionId)
      )
        setState(event.state);
    };
    const unsubscribe = host.onTerminalEvent(receive);
    void host
      .terminalState(sessionId)
      .then((value) => {
        if (mounted && isSessionTerminal(value, sessionId)) setState(value);
      })
      .catch(() => {});
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [sessionId]);
  return state && isSessionTerminal(state, sessionId) ? state : null;
}
