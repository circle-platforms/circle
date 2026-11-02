import type { Session } from './types';

export type ComposerState = 'default' | 'plan' | 'working' | 'attention';
/** Presentation only: requests win over work; a paused turn never paints as running. */
export function composerState(
  session: Pick<Session, 'state' | 'mode' | 'readOnly' | 'turn' | 'compaction'>,
  pending: number,
): ComposerState {
  if (pending > 0) return 'attention';
  if (
    session.compaction?.status === 'running' ||
    (session.state !== 'paused' &&
      (session.turn || session.state === 'waiting'))
  )
    return 'working';
  return (session.mode ?? (session.readOnly ? 'plan' : 'manual')) === 'plan'
    ? 'plan'
    : 'default';
}
