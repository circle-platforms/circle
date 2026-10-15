import {
  WorkspaceStreamStore,
  type WorkspaceStreamCursor,
  type WorkspaceStreamEvent,
} from './workspace-stream-store.ts';
export interface WorkspaceReplayPage {
  events: WorkspaceStreamEvent[];
  cursor: WorkspaceStreamCursor;
  hasMore: boolean;
}
export interface WorkspaceStreamTransport {
  listen: (receive: (event: WorkspaceStreamEvent) => void) => () => void;
  replay: (
    after: WorkspaceStreamCursor,
    limit: number,
  ) => Promise<WorkspaceReplayPage>;
}
/** One cursor for a single workspace journal. Resource/session filtering belongs after
 * ingestion: filtering first would turn unrelated events into permanent holes. */
export class WorkspaceStreamConnection {
  private stopped = true;
  private generation = 0;
  private unsubscribe: (() => void) | undefined;
  private replaying: Promise<void> | undefined;
  private buffered: WorkspaceStreamEvent[] = [];
  readonly store: WorkspaceStreamStore;
  private transport: WorkspaceStreamTransport;
  private applied: (event: WorkspaceStreamEvent) => void;
  private failed: (error: unknown) => void;
  constructor(
    store: WorkspaceStreamStore,
    transport: WorkspaceStreamTransport,
    applied: (event: WorkspaceStreamEvent) => void = () => {},
    failed: (error: unknown) => void = () => {},
  ) {
    this.store = store;
    this.transport = transport;
    this.applied = applied;
    this.failed = failed;
  }
  start(): Promise<void> {
    if (!this.stopped) return this.replaying ?? Promise.resolve();
    this.stopped = false;
    const generation = ++this.generation;
    // Install the live listener before the first asynchronous replay request.
    this.unsubscribe = this.transport.listen((event) => {
      if (this.stopped || generation !== this.generation) return;
      if (this.replaying) {
        this.buffer(event);
        return;
      }
      const result = this.apply(event);
      if (result === 'gap') {
        this.buffer(event);
        void this.synchronize().catch(this.failed);
      }
    });
    return this.synchronize();
  }
  stop() {
    this.stopped = true;
    this.generation++;
    this.replaying = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.buffered = [];
  }
  private buffer(event: WorkspaceStreamEvent) {
    // Durable replay recovers discarded buffered events; never advance the cursor.
    if (this.buffered.length >= 8192) this.buffered = [];
    this.buffered.push(event);
  }
  private apply(event: WorkspaceStreamEvent) {
    if (!event?.cursor || typeof event.cursor !== 'object') return 'gap';
    const result = this.store.apply(event);
    if (result === 'applied') this.applied(event);
    return result;
  }
  synchronize(): Promise<void> {
    if (this.replaying) return this.replaying;
    const generation = this.generation;
    const run = async () => {
      do {
        let hasMore = true;
        while (hasMore && !this.stopped && generation === this.generation) {
          const before = this.store.cursor;
          const page = await this.transport.replay(before, 256);
          if (this.stopped || generation !== this.generation) return;
          for (const event of page.events) {
            const result = this.apply(event);
            if (result === 'gap' || result === 'stale-epoch')
              throw Error('workspace replay contains a journal gap');
          }
          const cursor = this.store.cursor;
          if (
            cursor.seq !== page.cursor.seq ||
            cursor.offset !== page.cursor.offset ||
            (page.hasMore && cursor.seq === before.seq)
          )
            throw Error('workspace replay cursor did not advance consistently');
          hasMore = page.hasMore;
        }
        const pending = this.buffered.sort((a, b) => a.seq - b.seq);
        this.buffered = [];
        let gap = false;
        for (const event of pending) {
          if (this.stopped || generation !== this.generation) return;
          const result = this.apply(event);
          if (result === 'gap') {
            this.buffer(event);
            gap = true;
          }
        }
        if (gap) {
          const before = this.store.cursor;
          const page = await this.transport.replay(before, 256);
          if (this.stopped || generation !== this.generation) return;
          if (!page.events.length)
            throw Error(
              'workspace live event gap is not available in durable replay',
            );
          for (const event of page.events)
            if (this.apply(event) === 'gap')
              throw Error('workspace replay contains a journal gap');
        }
      } while (
        this.buffered.length &&
        !this.stopped &&
        generation === this.generation
      );
    };
    // Defer execution one microtask so synchronous live callbacks also buffer.
    const pending = Promise.resolve()
      .then(run)
      .finally(() => {
        if (this.replaying === pending) this.replaying = undefined;
      });
    this.replaying = pending;
    return pending;
  }
}

export interface WorkspaceJournalTransport {
  listen: (receive: (event: WorkspaceStreamEvent) => void) => () => void;
  replay: (
    workspaceId: string,
    sessionId: string,
    after: WorkspaceStreamCursor,
    limit: number,
  ) => Promise<WorkspaceReplayPage>;
}
/** Each granted workspace owns a separate durable journal. Sessions in the same
 * workspace share its cursor; unrelated workspaces may both legitimately be seq 1. */
export class WorkspaceStreamRegistry {
  private stores = new Map<string, WorkspaceStreamStore>();
  private connections = new Map<string, WorkspaceStreamConnection>();
  private sessions = new Map<string, string>();
  private receivers = new Map<string, (event: WorkspaceStreamEvent) => void>();
  private unsubscribe: () => void;
  private transport: WorkspaceJournalTransport;
  private createStore: (workspaceId: string) => WorkspaceStreamStore;
  private applied: (event: WorkspaceStreamEvent) => void;
  private failed: (error: unknown) => void;
  constructor(
    transport: WorkspaceJournalTransport,
    createStore: (workspaceId: string) => WorkspaceStreamStore = () =>
      new WorkspaceStreamStore(),
    applied: (event: WorkspaceStreamEvent) => void = () => {},
    failed: (error: unknown) => void = () => {},
  ) {
    this.transport = transport;
    this.createStore = createStore;
    this.applied = applied;
    this.failed = failed;
    this.unsubscribe = transport.listen((event) =>
      this.receivers.get(event.workspaceId)?.(event),
    );
  }
  store(workspaceId: string) {
    let store = this.stores.get(workspaceId);
    if (!store) {
      store = this.createStore(workspaceId);
      this.stores.set(workspaceId, store);
    }
    return store;
  }
  connect(workspaceId: string, sessionId: string): Promise<void> {
    this.sessions.set(workspaceId, sessionId);
    let connection = this.connections.get(workspaceId);
    if (!connection) {
      connection = new WorkspaceStreamConnection(
        this.store(workspaceId),
        {
          listen: (receive) => {
            this.receivers.set(workspaceId, receive);
            return () => {
              if (this.receivers.get(workspaceId) === receive)
                this.receivers.delete(workspaceId);
            };
          },
          replay: async (after, limit) => {
            const authorization = this.sessions.get(workspaceId)!;
            let page: WorkspaceReplayPage;
            try {
              page = await this.transport.replay(
                workspaceId,
                authorization,
                after,
                limit,
              );
            } catch (error) {
              const current = this.sessions.get(workspaceId)!;
              if (current === authorization) throw error;
              // A session switch can retire an in-flight authorization. Retry
              // once under the newly selected known session, never indefinitely.
              page = await this.transport.replay(
                workspaceId,
                current,
                after,
                limit,
              );
            }
            if (page.events.some((event) => event.workspaceId !== workspaceId))
              throw Error('workspace replay returned a different journal');
            return page;
          },
        },
        this.applied,
        this.failed,
      );
      this.connections.set(workspaceId, connection);
      return connection.start();
    }
    return connection.synchronize();
  }
  close() {
    this.unsubscribe();
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
    this.receivers.clear();
  }
}
