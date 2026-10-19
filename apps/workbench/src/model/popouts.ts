import { useEffect, useState } from 'react';
import type { PopoutKind } from '../../../desktop/src/contracts';
import { desktopHost } from '../host';

/** The modes that are in windows of their own now, as `kind:conversation`. */
export function usePopouts(): ReadonlySet<string> {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const host = desktopHost();
    if (!host?.onPopoutEvent) return;
    let current = true;
    // Told before asked, so a window that opens meanwhile is not lost.
    const stop = host.onPopoutEvent((event) =>
      setOpen((known) => {
        const next = new Set(known);
        const key = popoutKey(event.kind, event.sessionId);
        if (event.open) next.add(key);
        else next.delete(key);
        return next;
      }),
    );
    void host.popouts().then(
      (list) => {
        if (!current) return;
        setOpen(
          (known) =>
            new Set([
              ...known,
              ...list.map((one) => popoutKey(one.kind, one.sessionId)),
            ]),
        );
      },
      () => {},
    );
    return () => {
      current = false;
      stop();
    };
  }, []);
  return open;
}

export const popoutKey = (kind: PopoutKind, sessionId: string) =>
  `${kind}:${sessionId}`;

/** The route of a window a mode was popped out into: `#/popout/<kind>/<conversation>`. */
export function popoutRoute(hash: string): {
  kind: PopoutKind;
  sessionId: string;
} | null {
  const match = /^#\/popout\/(browser|terminal)\/([a-zA-Z0-9_-]{1,100})$/.exec(
    hash,
  );
  return match ? { kind: match[1] as PopoutKind, sessionId: match[2]! } : null;
}
