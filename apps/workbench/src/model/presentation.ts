import { useEffect, useRef } from 'react';
import { useRuntime } from '../app/context';
import { currentSession } from './state';
import type { RuntimePort, Session } from './types';

type Presentation = NonNullable<Session['presentation']>;

/** A departing view cannot save into a reset snapshot or a removed conversation. */
export function saveSessionScroll(
  runtime: RuntimePort,
  sessionId: string,
  epoch: number | undefined,
  scroll: NonNullable<Presentation['scroll']>,
): void {
  if (runtime.presentationEpoch !== epoch) return;
  const session = runtime
    .getSnapshot()
    .sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const previous = session.presentation?.scroll;
  if (previous?.top === scroll.top && previous.follow === scroll.follow) return;
  runtime.updateSessionView(sessionId, {
    presentation: { ...session.presentation, scroll },
  });
}

/** Explicit session ownership keeps a late UI callback out of the newly selected view. */
export function useSessionPresentation() {
  const { snapshot, runtime } = useRuntime();
  const session = currentSession(snapshot);
  const update = (change: (view: Presentation) => void) => {
    const target = runtime
      .getSnapshot()
      .sessions.find((item) => item.id === session.id);
    if (!target) return;
    const presentation = structuredClone(target.presentation ?? {});
    change(presentation);
    runtime.updateSessionView(session.id, { presentation });
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
