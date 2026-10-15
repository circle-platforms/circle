import type { WorkspaceServiceEvent } from '../../../desktop/src/workspace-protocol';

export interface WorkspaceStreamCursor {
  offset: number;
  seq: number;
}
export type WorkspaceStreamEvent = WorkspaceServiceEvent & {
  cursor: WorkspaceStreamCursor;
  sourceSeq?: number;
  sourceEpoch?: string;
};
export type StreamApplyResult = 'applied' | 'duplicate' | 'stale-epoch' | 'gap';
export interface WorkspaceStreamCheckpoint {
  version: 1;
  cursor: WorkspaceStreamCursor;
  epoch: string;
  retiredEpochs: string[];
  resources: { key: string; events: WorkspaceStreamEvent[] }[];
}

/** Small resource-scoped external store. Full evidence stays in the main journal;
 * React consumers only subscribe to the resource they display. A gap is never
 * concealed: the caller must fetch replay(after cursor), then resume live events.
 */
export class WorkspaceStreamStore {
  private cursorValue: WorkspaceStreamCursor = { offset: 0, seq: 0 };
  private epoch = '';
  private retiredEpochs = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();
  private allListeners = new Set<() => void>();
  private values = new Map<string, readonly WorkspaceStreamEvent[]>();
  private pendingKeys = new Set<string>();
  private scheduled = false;
  private retainedBytes = 0;
  private bytesByKey = new Map<string, number>();
  private options: {
    maxEventsPerResource?: number;
    maxBytes?: number;
    schedule?: (flush: () => void) => void;
  };
  constructor(
    options: {
      maxEventsPerResource?: number;
      maxBytes?: number;
      schedule?: (flush: () => void) => void;
    } = {},
  ) {
    if (
      (options.maxBytes !== undefined &&
        (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) ||
      (options.maxEventsPerResource !== undefined &&
        (!Number.isSafeInteger(options.maxEventsPerResource) ||
          options.maxEventsPerResource < 1))
    )
      throw Error('invalid workspace stream cache bounds');
    this.options = options;
  }

  get cursor() {
    return { ...this.cursorValue };
  }
  get cachedBytes() {
    return this.retainedBytes;
  }
  static resourceKey(
    event: Pick<
      WorkspaceServiceEvent,
      'workspaceId' | 'sessionId' | 'service' | 'resourceId'
    >,
  ) {
    return JSON.stringify([
      event.workspaceId,
      event.sessionId,
      event.service,
      event.resourceId,
    ]);
  }
  snapshot(key: string): readonly WorkspaceStreamEvent[] {
    return this.values.get(key) ?? EMPTY;
  }
  subscribe(key: string, listener: () => void) {
    let group = this.listeners.get(key);
    if (!group) this.listeners.set(key, (group = new Set()));
    group.add(listener);
    return () => {
      group.delete(listener);
      if (!group.size) this.listeners.delete(key);
    };
  }
  subscribeCursor(listener: () => void) {
    this.allListeners.add(listener);
    return () => {
      this.allListeners.delete(listener);
    };
  }

  /** Persist this single envelope atomically, never a cursor without its cache. */
  checkpoint(): WorkspaceStreamCheckpoint {
    return JSON.parse(
      JSON.stringify({
        version: 1,
        cursor: this.cursorValue,
        epoch: this.epoch,
        retiredEpochs: [...this.retiredEpochs],
        resources: [...this.values].map(([key, events]) => ({ key, events })),
      }),
    ) as WorkspaceStreamCheckpoint;
  }

  /** Bounded cache restore is not full-history recovery; raw originals remain
   * on disk. Invalid checkpoints leave the current store completely unchanged.
   */
  restore(value: unknown): boolean {
    try {
      const json = JSON.stringify(value);
      if (
        new TextEncoder().encode(json).byteLength >
        (this.options.maxBytes ?? 4 * 1024 * 1024) + 65536
      )
        return false;
      const saved = JSON.parse(json) as WorkspaceStreamCheckpoint;
      const validCursor = (cursor: WorkspaceStreamCursor) =>
        !!cursor &&
        Number.isSafeInteger(cursor.seq) &&
        cursor.seq >= 0 &&
        Number.isSafeInteger(cursor.offset) &&
        cursor.offset >= 0 &&
        (cursor.seq === 0) === (cursor.offset === 0);
      if (
        !saved ||
        saved.version !== 1 ||
        !validCursor(saved.cursor) ||
        typeof saved.epoch !== 'string' ||
        saved.epoch.length > 200 ||
        !Array.isArray(saved.retiredEpochs) ||
        saved.retiredEpochs.length > 64 ||
        saved.retiredEpochs.some(
          (epoch) =>
            typeof epoch !== 'string' ||
            !epoch ||
            epoch.length > 200 ||
            epoch === saved.epoch,
        ) ||
        !Array.isArray(saved.resources)
      )
        return false;
      if ((saved.cursor.seq === 0) !== (saved.epoch === '')) return false;
      const values = new Map<string, readonly WorkspaceStreamEvent[]>();
      const sizes = new Map<string, number>();
      const seen = new Set<number>();
      let bytes = 0,
        foundEndpoint = saved.cursor.seq === 0;
      for (const resource of saved.resources) {
        if (
          !resource ||
          typeof resource.key !== 'string' ||
          values.has(resource.key) ||
          !Array.isArray(resource.events) ||
          !resource.events.length ||
          resource.events.length > (this.options.maxEventsPerResource ?? 128)
        )
          return false;
        let previousSeq = 0,
          previousOffset = 0;
        for (const event of resource.events) {
          if (
            !event ||
            !validCursor(event.cursor) ||
            event.seq !== event.cursor.seq ||
            event.seq < 1 ||
            event.seq > saved.cursor.seq ||
            event.seq <= previousSeq ||
            seen.has(event.seq) ||
            event.cursor.offset <= previousOffset ||
            event.cursor.offset > saved.cursor.offset ||
            typeof event.epoch !== 'string' ||
            !event.epoch ||
            event.epoch.length > 200 ||
            typeof event.at !== 'string' ||
            !event.data ||
            typeof event.data !== 'object' ||
            Array.isArray(event.data) ||
            ![
              'documents',
              'terminal',
              'git',
              'language',
              'debug',
              'tasks',
              'delivery',
            ].includes(event.service) ||
            [event.workspaceId, event.sessionId, event.resourceId].some(
              (id) => typeof id !== 'string' || !id || id.length > 200,
            ) ||
            WorkspaceStreamStore.resourceKey(event) !== resource.key
          )
            return false;
          if (event.seq === saved.cursor.seq) {
            if (
              event.cursor.offset !== saved.cursor.offset ||
              event.epoch !== saved.epoch
            )
              return false;
            foundEndpoint = true;
          }
          seen.add(event.seq);
          previousSeq = event.seq;
          previousOffset = event.cursor.offset;
        }
        const size = new TextEncoder().encode(
          JSON.stringify(resource.events),
        ).byteLength;
        bytes += size;
        if (bytes > (this.options.maxBytes ?? 4 * 1024 * 1024)) return false;
        values.set(resource.key, resource.events);
        sizes.set(resource.key, size);
      }
      if (!foundEndpoint || (saved.cursor.seq === 0 && values.size))
        return false;
      for (const key of this.values.keys()) this.pendingKeys.add(key);
      for (const key of values.keys()) this.pendingKeys.add(key);
      this.values = values;
      this.bytesByKey = sizes;
      this.retainedBytes = bytes;
      this.cursorValue = saved.cursor;
      this.epoch = saved.epoch;
      this.retiredEpochs = new Set(saved.retiredEpochs);
      this.schedule();
      return true;
    } catch {
      return false;
    }
  }

  apply(event: WorkspaceStreamEvent): StreamApplyResult {
    if (
      !Number.isSafeInteger(event.seq) ||
      event.seq < 1 ||
      typeof event.epoch !== 'string' ||
      !event.epoch
    )
      return 'gap';
    if (this.retiredEpochs.has(event.epoch)) return 'stale-epoch';
    if (event.seq <= this.cursorValue.seq) return 'duplicate';
    if (
      event.seq !== this.cursorValue.seq + 1 ||
      !Number.isSafeInteger(event.cursor.offset) ||
      event.cursor.offset <= this.cursorValue.offset ||
      event.cursor.seq !== event.seq
    )
      return 'gap';
    if (this.epoch && this.epoch !== event.epoch) {
      this.retiredEpochs.add(this.epoch);
      if (this.retiredEpochs.size > 64)
        this.retiredEpochs.delete(this.retiredEpochs.values().next().value!);
    }
    this.epoch = event.epoch;
    this.cursorValue = { ...event.cursor };
    const key = WorkspaceStreamStore.resourceKey(event);
    const events = [...this.snapshot(key), event].slice(
      -(this.options.maxEventsPerResource ?? 128),
    );
    const bytes = new TextEncoder().encode(JSON.stringify(events)).byteLength;
    this.retainedBytes += bytes - (this.bytesByKey.get(key) ?? 0);
    // Reinserting gives least recently changed resource eviction order.
    this.values.delete(key);
    this.values.set(key, events);
    this.bytesByKey.set(key, bytes);
    this.pendingKeys.add(key);
    while (
      this.retainedBytes > (this.options.maxBytes ?? 4 * 1024 * 1024) &&
      this.values.size
    ) {
      const oldest = this.values.keys().next().value!;
      this.retainedBytes -= this.bytesByKey.get(oldest)!;
      this.values.delete(oldest);
      this.bytesByKey.delete(oldest);
      this.pendingKeys.add(oldest);
    }
    this.schedule();
    return 'applied';
  }

  /** Use only after an authoritative full resync, never to skip a replay gap. */
  reset(cursor: WorkspaceStreamCursor = { offset: 0, seq: 0 }) {
    for (const key of this.values.keys()) this.pendingKeys.add(key);
    this.values.clear();
    this.bytesByKey.clear();
    this.retainedBytes = 0;
    this.cursorValue = { ...cursor };
    this.epoch = '';
    this.retiredEpochs.clear();
    this.schedule();
  }
  flush() {
    this.scheduled = false;
    const keys = [...this.pendingKeys];
    this.pendingKeys.clear();
    for (const key of keys)
      for (const listener of this.listeners.get(key) ?? []) listener();
    for (const listener of this.allListeners) listener();
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    (this.options.schedule ?? queueMicrotask)(() => this.flush());
  }
}
const EMPTY: readonly WorkspaceStreamEvent[] = Object.freeze([]);
