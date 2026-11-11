import type { Session, Interaction } from './types';

export type ComposerActivity = 'idle' | 'working' | 'waiting';
/**
 * What the composer's frame shows of the session's turn: nothing, a turn at work, or a turn
 * that waits on the person (an approval or a question of this session, the browser or a
 * terminal in their hands). A turn the person stopped has ended: `paused` is idle.
 */
export function composerActivity(
  session: Pick<
    Session,
    | 'id'
    | 'state'
    | 'turn'
    | 'occupied'
    | 'lifecycle'
    | 'archivedAt'
    | 'compaction'
  >,
  interactions: Pick<Interaction, 'sessionId' | 'status'>[],
  browserWaiting = false,
  controlWaiting = false,
): ComposerActivity {
  if (
    session.occupied ||
    session.archivedAt ||
    session.lifecycle === 'deleting' ||
    session.state === 'paused'
  )
    return 'idle';
  const working =
    Boolean(session.turn) ||
    session.state === 'waiting' ||
    session.compaction?.status === 'running';
  if (!working) return 'idle';
  return browserWaiting ||
    controlWaiting ||
    interactions.some(
      (item) => item.sessionId === session.id && item.status === 'pending',
    )
    ? 'waiting'
    : 'working';
}
