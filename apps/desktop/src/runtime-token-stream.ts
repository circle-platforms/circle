import type { RuntimeTokenDelta, RuntimeUpdate } from './runtime-protocol';
import type {
  AgentRecord,
  Message,
  Session,
} from '../../workbench/src/model/types';
import { restoreHistory } from './runtime-history-wire';

interface StreamState {
  index: number;
  message: Message;
  turn?: Session['turn'];
}
interface AgentStreamState {
  index: number;
  message: Message;
  activity?: string;
}
export type TokenDeltaResult =
  'applied' | 'duplicate' | 'gap' | 'missing-session';
export type FullUpdateResult = 'accepted' | 'stale' | 'history-gap';

function nextMessageStream(
  messages: readonly Message[],
  current: StreamState | undefined,
  delta: RuntimeTokenDelta,
): StreamState | undefined {
  if (current && current.message.id !== delta.streamId) return undefined;
  let stream = current;
  if (!stream) {
    const index = messages.findIndex(
      (message) => message.id === delta.streamId,
    );
    const existing = index >= 0 ? messages[index] : undefined;
    if (existing && existing.at !== 'streaming') return undefined;
    stream = {
      index: index >= 0 ? index : messages.length,
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
  }
  return {
    index: stream.index,
    message: {
      ...stream.message,
      text: stream.message.text + (delta.text ?? ''),
      thinking: (stream.message.thinking ?? '') + (delta.thinking ?? ''),
    },
    ...(delta.turn !== undefined
      ? { turn: delta.turn }
      : stream.turn !== undefined
        ? { turn: stream.turn }
        : {}),
  };
}

/** Shared by native supervisor and renderer. Chunks update only active stream
 * buffers; snapshot/history copies happen only when a consumer asks to render
 * or read state. The source snapshot and its historical messages stay immutable.
 */
export class RuntimeTokenBuffer {
  private full?: RuntimeUpdate;
  private historyRevisions: ReadonlyMap<string, number> = new Map();
  private sessions = new Map<string, Session>();
  private agents = new Map<string, AgentRecord>();
  private streams = new Map<string, StreamState>();
  private agentStreams = new Map<string, AgentStreamState>();
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
    return this.accept(update) === 'accepted';
  }
  /** Take a publication as the new baseline; materialize() then has its stored history. */
  accept(update: RuntimeUpdate): FullUpdateResult {
    const marker = update.tokenStream;
    const sameEpoch = !marker || marker.epoch === this.cursor.epoch;
    if (
      this.full &&
      sameEpoch &&
      (update.seq < this.full.seq ||
        (update.seq === this.full.seq &&
          (!marker || marker.seq <= this.cursor.seq)))
    )
      return 'stale';
    if (marker && this.retiredEpochs.has(marker.epoch)) return 'stale';
    const restored = restoreHistory(update, this.full, this.historyRevisions);
    if (!restored) return 'history-gap';
    if (marker && this.cursor.epoch && marker.epoch !== this.cursor.epoch) {
      this.retiredEpochs.add(this.cursor.epoch);
      if (this.retiredEpochs.size > 32)
        this.retiredEpochs.delete(this.retiredEpochs.values().next().value!);
    }
    this.full = restored.update;
    this.historyRevisions = restored.revisions;
    this.cursor = marker ? { ...marker } : { epoch: '', seq: 0 };
    this.sessions = new Map(
      (restored.update.snapshot.sessions ?? []).map((session) => [
        session.id,
        session,
      ]),
    );
    this.agents = new Map(
      (restored.update.snapshot.agents ?? []).map((agent) => [agent.id, agent]),
    );
    this.streams.clear();
    this.agentStreams.clear();
    this.compactions.clear();
    return 'accepted';
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
      (delta.thinking !== undefined && typeof delta.thinking !== 'string') ||
      (delta.activity !== undefined && typeof delta.activity !== 'string')
    )
      return 'gap';
    const session = this.sessions.get(delta.sessionId);
    const agent = this.agents.get(delta.sessionId);
    if (!session && !agent) return 'missing-session';
    if (delta.compaction) {
      if (!session) return 'missing-session';
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
    const nextSession = session
      ? nextMessageStream(
          session.messages,
          this.streams.get(delta.sessionId),
          delta,
        )
      : undefined;
    if (session && !nextSession) return 'gap';
    const prevAgent = agent
      ? this.agentStreams.get(delta.sessionId)
      : undefined;
    const nextAgent = agent
      ? nextMessageStream(
          agent.messages,
          prevAgent
            ? { index: prevAgent.index, message: prevAgent.message }
            : undefined,
          delta,
        )
      : undefined;
    if (agent && !nextAgent) return 'gap';
    if (nextSession) this.streams.set(delta.sessionId, nextSession);
    if (nextAgent && agent)
      this.agentStreams.set(delta.sessionId, {
        index: nextAgent.index,
        message: nextAgent.message,
        activity: delta.activity ?? prevAgent?.activity ?? agent.activity,
      });
    this.cursor = { epoch: delta.epoch, seq: delta.seq };
    return 'applied';
  }
  materialize(): RuntimeUpdate {
    if (!this.full) throw Error('runtime token stream has no full baseline');
    if (!this.streams.size && !this.compactions.size && !this.agentStreams.size)
      return this.full;
    const updateSessions = this.streams.size > 0 || this.compactions.size > 0;
    const updateAgents = this.agentStreams.size > 0;
    return {
      ...this.full,
      tokenStream: { ...this.cursor },
      snapshot: {
        ...this.full.snapshot,
        sessions: updateSessions
          ? this.full.snapshot.sessions.map((session) => {
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
            })
          : this.full.snapshot.sessions,
        agents: updateAgents
          ? (this.full.snapshot.agents ?? []).map((agent) => {
              const stream = this.agentStreams.get(agent.id);
              if (!stream) return agent;
              const messages = agent.messages.slice();
              messages[stream.index] = stream.message;
              return {
                ...agent,
                messages,
                ...(stream.activity !== undefined
                  ? { activity: stream.activity }
                  : {}),
              };
            })
          : this.full.snapshot.agents,
      },
    };
  }
}
