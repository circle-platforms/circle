import { useEffect, useRef } from 'react';
import { useRuntime } from '../app/context';
import { currentSession } from './state';
import type { RuntimePort, Session } from './types';

type Presentation = NonNullable<Session['presentation']>;
export type SessionScroll = NonNullable<Presentation['scroll']>;

/** Optional local view data from older windows may be absent or malformed. */
export function sessionScrollAnchor(value: unknown): SessionScroll['anchor'] {
  if (!value || typeof value !== 'object') return undefined;
  const anchor = value as Record<string, unknown>;
  return typeof anchor.messageId === 'string' &&
    anchor.messageId.length > 0 &&
    typeof anchor.offset === 'number' &&
    Number.isFinite(anchor.offset)
    ? { messageId: anchor.messageId, offset: anchor.offset }
    : undefined;
}

/** Pixel positions alone cannot identify a row after virtual heights are remeasured. */
export function transcriptScroll(
  box: HTMLElement,
  follow: boolean,
): SessionScroll {
  const frame = box.getBoundingClientRect();
  const node = follow
    ? undefined
    : [...box.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (row) => {
          const rect = row.getBoundingClientRect();
          return (
            rect.height > 0 &&
            rect.bottom > frame.top &&
            rect.top < frame.bottom
          );
        },
      );
  return {
    top: box.scrollTop,
    follow,
    ...(node
      ? {
          anchor: {
            messageId: node.dataset.messageId!,
            offset: node.getBoundingClientRect().top - frame.top,
          },
        }
      : {}),
  };
}

export function restoreTranscriptAnchor(
  box: HTMLElement,
  anchor: SessionScroll['anchor'],
): boolean {
  anchor = sessionScrollAnchor(anchor);
  if (!anchor) return false;
  const node = [...box.querySelectorAll<HTMLElement>('[data-message-id]')].find(
    (row) => row.dataset.messageId === anchor.messageId,
  );
  if (!node) return false;
  // Geometry compensation must finish in this commit. Inheriting the transcript's
  // smooth scrolling would let a later measurement retarget an unfinished move.
  box.scrollTo({
    top:
      box.scrollTop +
      node.getBoundingClientRect().top -
      box.getBoundingClientRect().top -
      anchor.offset,
    behavior: 'instant',
  });
  return true;
}

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
  if (
    previous?.top === scroll.top &&
    previous.follow === scroll.follow &&
    previous.anchor?.messageId === scroll.anchor?.messageId &&
    previous.anchor?.offset === scroll.anchor?.offset
  )
    return;
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
