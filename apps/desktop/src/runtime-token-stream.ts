import type { RuntimeTokenDelta, RuntimeUpdate } from './runtime-protocol';
import type { Message, Session } from '../../workbench/src/model/types';

interface StreamState {
  index: number;
  message: Message;
  turn?: Session['turn'];
}
export type TokenDeltaResult =
  'applied' | 'duplicate' | 'gap' | 'missing-session';

/** Shared by native supervisor and renderer. Chunks update only active stream
 * buffers; snapshot/history copies happen only when a consumer asks to render
 * or read state. The source snapshot and its historical messages stay immutable.
 */
export class RuntimeTokenBuffer {
  private full?: RuntimeUpdate;
  private sessions = new Map<string, Session>();
  private streams = new Map<string, StreamState>();
  private compactions = new Map<
    string,
    { state: NonNullable<Session['compaction']>; turn?: Session['turn'] }
  >();
  private cursor = { epoch: '', seq: 0 };
  private retiredEpochs = new Set<string>();
  get tokenCursor() {
    return { ...this.cursor };
  }

  acceptFull(update: RuntimeUpdate): boolean {
    const marker = update.tokenStream;
    const sameEpoch = !marker || marker.epoch === this.cursor.epoch;
    if (
      this.full &&
      sameEpoch &&
      (update.seq < this.full.seq ||
        (update.seq === this.full.seq &&
          (!marker || marker.seq <= this.cursor.seq)))
    )
      return false;
    if (marker && this.retiredEpochs.has(marker.epoch)) return false;
    if (marker && this.cursor.epoch && marker.epoch !== this.cursor.epoch) {
      this.retiredEpochs.add(this.cursor.epoch);
      if (this.retiredEpochs.size > 32)
        this.retiredEpochs.delete(this.retiredEpochs.values().next().value!);
    }
    this.full = update;
    this.cursor = marker ? { ...marker } : { epoch: '', seq: 0 };
    this.sessions = new Map(
      update.snapshot.sessions.map((session) => [session.id, session]),
    );
    this.streams.clear();
    this.compactions.clear();
    return true;
  }
  apply(delta: RuntimeTokenDelta): TokenDeltaResult {
    if (!this.full || !delta || typeof delta.epoch !== 'string') return 'gap';
    if (this.retiredEpochs.has(delta.epoch)) return 'duplicate';
    if (delta.epoch !== this.cursor.epoch) return 'gap';
    if (!Number.isSafeInteger(delta.seq) || delta.seq < 1) return 'gap';
    if (delta.seq <= this.cursor.seq) return 'duplicate';
    if (
      delta.seq !== this.cursor.seq + 1 ||
      delta.baseSeq !== this.full.seq ||
      typeof delta.sessionId !== 'string' ||
      typeof delta.streamId !== 'string' ||
      !delta.streamId ||
      typeof delta.at !== 'string' ||
      (delta.parentId !== null && typeof delta.parentId !== 'string') ||
      (delta.text !== undefined && typeof delta.text !== 'string') ||
      (delta.thinking !== undefined && typeof delta.thinking !== 'string')
    )
      return 'gap';
    const session = this.sessions.get(delta.sessionId);
    if (!session) return 'missing-session';
    if (delta.compaction) {
      const state = delta.compaction;
      const previous =
        this.compactions.get(delta.sessionId)?.state ?? session.compaction;
      if (
        state.sessionId !== delta.sessionId ||
        state.operationId !== previous?.operationId ||
        state.status !== 'running' ||
        previous.status !== 'running'
      )
        return 'gap';
      if (state.updatedAt < previous.updatedAt) return 'gap';
      this.compactions.set(delta.sessionId, { state, turn: delta.turn });
      this.cursor = { epoch: delta.epoch, seq: delta.seq };
      return 'applied';
    }
    let stream = this.streams.get(delta.sessionId);
    if (stream && stream.message.id !== delta.streamId) return 'gap';
    if (!stream || stream.message.id !== delta.streamId) {
      const index = session.messages.findIndex(
        (message) => message.id === delta.streamId,
      );
      const existing = index >= 0 ? session.messages[index] : undefined;
      if (existing && existing.at !== 'streaming') return 'gap';
      stream = {
        index: index >= 0 ? index : session.messages.length,
        message: existing
          ? { ...existing }
          : {
              id: delta.streamId,
              parentId: delta.parentId,
              role: 'assistant',
              at: 'streaming',
              text: '',
              thinking: '',
            },
      };
      this.streams.set(delta.sessionId, stream);
    }
    stream.message = {
      ...stream.message,
      text: stream.message.text + (delta.text ?? ''),
      thinking: (stream.message.thinking ?? '') + (delta.thinking ?? ''),
    };
    if (delta.turn !== undefined) stream.turn = delta.turn;
    this.cursor = { epoch: delta.epoch, seq: delta.seq };
    return 'applied';
  }
  materialize(): RuntimeUpdate {
    if (!this.full) throw Error('runtime token stream has no full baseline');
    if (!this.streams.size && !this.compactions.size) return this.full;
    return {
      ...this.full,
      tokenStream: { ...this.cursor },
      snapshot: {
        ...this.full.snapshot,
        sessions: this.full.snapshot.sessions.map((session) => {
          const progress = this.compactions.get(session.id);
          if (progress)
            session = {
              ...session,
              compaction: progress.state,
              ...(progress.turn ? { turn: progress.turn } : {}),
            };
          const stream = this.streams.get(session.id);
          if (!stream) return session;
          const messages = session.messages.slice();
          messages[stream.index] = stream.message;
          return {
            ...session,
            messages,
            branchIds: session.branchIds?.includes(stream.message.id)
              ? session.branchIds
              : [...(session.branchIds ?? []), stream.message.id],
            ...(stream.turn ? { turn: stream.turn } : {}),
          };
        }),
      },
    };
  }
}
