import { useEffect, useRef } from 'react';
import { useRuntime } from '../app/context';
import { currentSession } from './state';
import type { Session } from './types';

type Presentation = NonNullable<Session['presentation']>;

/** Explicit session ownership keeps a late UI callback out of the newly selected view. */
export function useSessionPresentation() {
  const { snapshot, runtime } = useRuntime();
  const session = currentSession(snapshot);
  const update = (change: (view: Presentation) => void) => {
    runtime.change((state) => {
      const target = state.sessions.find((item) => item.id === session.id);
      if (target) change((target.presentation ??= {}));
    });
  };
  return { view: session.presentation ?? {}, update };
}

export function useSessionDisclosure(id: string, defaultOpen = false) {
  const { view, update } = useSessionPresentation();
  const previousDefault = useRef(defaultOpen);
  useEffect(() => {
    if (previousDefault.current === defaultOpen) return;
    previousDefault.current = defaultOpen;
    update((target) => {
      (target.disclosures ??= {})[id] = { open: defaultOpen, defaultOpen };
    });
  }, [id, defaultOpen]);
  const saved = view.disclosures?.[id];
  const open = saved?.defaultOpen === defaultOpen ? saved.open : defaultOpen;
  return [
    open,
    (value: boolean) => {
      if (value === open) return;
      update((target) => {
        (target.disclosures ??= {})[id] = { open: value, defaultOpen };
      });
    },
  ] as const;
}
