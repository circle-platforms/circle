import type { WorkspaceServiceEvent } from '../../../desktop/src/workspace-protocol';

export interface WorkspaceStreamCursor {
  offset: number;
  seq: number;
}
export type WorkspaceStreamEvent = WorkspaceServiceEvent & {
  cursor: WorkspaceStreamCursor;
};
export type StreamApplyResult = 'applied' | 'duplicate' | 'stale-epoch' | 'gap';

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
