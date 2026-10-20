import type { RuntimeUpdate } from './runtime-protocol';

export interface Attention {
  /** Requests waiting for a person, for the dock badge. */
  badge: number;
  /** Whether any session is working, for the taskbar's progress bar. */
  busy: boolean;
  /** System notifications to show while the window is in the background. */
  notices: { title: string; body: string; sessionId: string }[];
}

/**
 * What the app shows outside its window for one runtime update: a badge for the requests
 * that wait, a busy bar, and a notification for a new request or a turn that ended.
 * `seen` keeps the request ids already announced, so each is announced once; `text`
 * gives the words in the window's language (native-text.ts).
 */
export function attention(
  update: RuntimeUpdate,
  seen: Set<string>,
  text: (english: string) => string,
): Attention {
  const snapshot = update.snapshot;
  const pending = snapshot.interactions.filter(
    (item) => item.status === 'pending',
  );
  const notices: Attention['notices'] = [];
  for (const item of pending) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const detail = item.command ?? item.target ?? '';
    // A hooks file waiting for approval names the file, as an approval names its tool.
    const approval = item.kind === 'approval' || item.kind === 'hooks';
    notices.push({
      title: approval
        ? text('Circle needs your approval')
        : item.kind === 'secret'
          ? text('Circle needs a secret')
          : text('Circle has a question'),
      body: approval
        ? [item.tool, detail].filter(Boolean).join(' · ')
        : item.title,
      sessionId: item.sessionId,
    });
  }
  for (const id of seen)
    if (!pending.some((item) => item.id === id)) seen.delete(id);
  const event = update.event;
  // A subagent's run ends inside its parent's turn; only the session you talk to counts.
  const session = snapshot.sessions.find((row) => row.id === event?.sessionId);
  if (
    session &&
    (event?.kind === 'run_end' || event?.kind === 'run_error') &&
    !event.payload.interrupted
  )
    notices.push({
      title:
        event.kind === 'run_end'
          ? text('Circle finished')
          : text('Circle stopped with an error'),
      body: session.title,
      sessionId: session.id,
    });
  return {
    badge: pending.length,
    busy: snapshot.sessions.some((row) => row.state === 'waiting'),
    notices,
  };
}
