import { randomUUID } from 'node:crypto';
import { KnowledgeStore, KnowledgeVersionConflict } from './store.js';
import { mergeSnapshots } from './merge.js';
import { decodeSyncObject } from './canonical.js';
import {
  decodeBase64,
  SYNC_LIMITS,
  validateAnswer,
  validateSync,
} from './protocol.js';
import {
  operationDigest,
  requestJson,
  SyncHttpError,
  type PurgeConfirmation,
  type SyncTransport,
} from './sync-http.js';
import type {
  SyncCondition,
  SyncDescriptor,
  SyncInventory,
  SyncReceipt,
  SyncResult,
  SyncSession,
  SyncState,
  SyncTransfer,
  ModeImpact,
} from './sync-types.js';

interface Pending {
  route: 'upload' | 'commit' | 'abort' | 'mode';
  session: string | null;
  body: Record<string, unknown>;
  digest: string;
}
interface Journal {
  binding: string;
  epoch: string;
  base: string | null;
  observedMode?: 'hub' | 'local';
  observedStatus?: string;
  state: string | null;
  paused: boolean;
  session?: SyncSession;
  inventory?: {
    cursor: string | null;
    done: boolean;
    objects: SyncDescriptor[];
  };
  pending?: Pending;
  lastSyncedAt?: string;
  condition: SyncCondition;
  failures: number;
  nextAt: number;
  /** The last refusal the server explained; cleared by the next success. */
  refusal?: { code: string; detail?: string };
  /** A purge waiting for the account holder's confirmation on the server. */
  confirmation?: PurgeConfirmation;
}
export interface SyncStatus {
  condition: SyncCondition;
  lastSyncedAt: string | null;
  mode: 'hub' | 'local' | null;
  clearing: boolean;
  /** The server's own text for the last refusal, as it came. */
  detail: string | null;
  /** Where to confirm a requested purge, until it is confirmed or expires. */
  confirmation: PurgeConfirmation | null;
}
export interface SyncOptions {
  /** Stable host-authored server/account binding. Never a token, model argument or device name. */
  binding: string;
  name?: string;
  now?: () => number;
  onStatus?: (state: {
    condition: SyncCondition;
    lastSyncedAt: string | null;
  }) => void;
}
const STALE = 30000,
  HEARTBEAT = 5000;
const parse = <T>(name: string, value: unknown): T => {
  validateAnswer(name, value);
  return value as T;
};
export class KnowledgeSync {
  private readonly store: KnowledgeStore;
  private readonly now: () => number;
  private token: string | null = null;
  private controller: AbortController | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private background = false;
  constructor(
    home: string,
    private readonly transport: SyncTransport,
    private readonly options: SyncOptions,
  ) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.binding))
      throw Error('invalid sync binding');
    this.store = new KnowledgeStore(home);
    this.now = options.now ?? Date.now;
  }
  /** A cycle or a host operation is talking to the server now. */
  get busy(): boolean {
    return this.running !== null;
  }
  get status(): SyncStatus {
    const j = this.store.syncRead<Journal>('active');
    const mine = j?.binding === this.options.binding;
    const confirmation =
      mine &&
      j.confirmation &&
      Date.parse(j.confirmation.expiresAt) > this.now()
        ? j.confirmation
        : null;
    return {
      mode: mine ? (j.observedMode ?? null) : null,
      clearing: mine && j.observedStatus === 'purging',
      condition: mine
        ? j.condition === 'synced' && this.store.head !== j.base
          ? 'pending'
          : j.condition
        : 'paused',
      lastSyncedAt: mine ? (j.lastSyncedAt ?? null) : null,
      detail: mine ? (j.refusal?.detail ?? null) : null,
      confirmation,
    };
  }
  private active(): void {
    this.controller!.signal.throwIfAborted();
    this.store.assertSyncLease(this.token!, this.now());
  }
  private save(j: Journal): void {
    this.active();
    this.store.syncAtomic(this.token!, this.now, () =>
      this.store.syncWrite('active', j),
    );
    this.report();
  }
  private report(): void {
    try {
      this.options.onStatus?.(this.status);
    } catch {
      /* Observers do not govern durable sync. */
    }
  }
  private async request<T>(
    route: string,
    args: {
      id?: string;
      query?: Record<string, string>;
      body?: unknown;
      schema?: string;
    } = {},
  ): Promise<T> {
    this.active();
    const value = await this.transport.request<T>(route, {
      ...args,
      signal: this.controller!.signal,
    });
    this.active();
    if (args.schema) validateAnswer(args.schema, value);
    return value;
  }
  /** A host must explicitly confirm a changed account/server or epoch before initialization. No model tool exposes this. */
  async confirmBinding(allowLocal = false): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.request<SyncState>('state', {
        schema: 'personal-sync-state@1',
      });
      if (!allowLocal && (state.mode !== 'hub' || state.status === 'purging'))
        throw Error('sync is not enabled on the server');
      this.save({
        binding: this.options.binding,
        epoch: state.epoch,
        observedMode: state.mode,
        observedStatus: state.status,
        base: null,
        state: null,
        paused: state.mode !== 'hub' || state.status === 'purging',
        condition:
          state.mode === 'local'
            ? 'local'
            : state.status === 'purging'
              ? 'paused'
              : 'pending',
        failures: 0,
        nextAt: 0,
      });
    });
  }
  private exclusive(work: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.reject(Error('knowledge sync is closed'));
    if (this.running)
      return Promise.reject(Error('knowledge sync is already running'));
    const task = this.withLease(work);
    this.running = task;
    void task
      .finally(() => {
        if (this.running === task) this.running = null;
      })
      .catch(() => {});
    return task;
  }
  private async withLease(work: () => Promise<void>): Promise<void> {
    const token = randomUUID();
    if (!this.store.acquireSyncLease(token, this.now(), STALE))
      throw Error('knowledge sync is owned by another process');
    this.token = token;
    this.controller = new AbortController();
    this.heartbeat = setInterval(() => {
      try {
        if (!this.store.renewSyncLease(token, this.now(), STALE))
          this.controller?.abort(Error('knowledge sync lease lost'));
      } catch {
        this.controller?.abort(Error('knowledge sync lease lost'));
      }
    }, HEARTBEAT);
    this.heartbeat.unref();
    try {
      await work();
    } finally {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.controller = null;
      this.store.releaseSyncLease(token);
      this.token = null;
    }
  }
  /** Serial, throttled background driver. start() is called only after the host resolves the selected connection. */
  start(): void {
    if (this.stopped) throw Error('knowledge sync is closed');
    this.background = true;
    this.notify();
  }
  notify(): void {
    if (!this.background || this.stopped || this.timer || this.running) return;
    const j = this.store.syncRead<Journal>('active');
    if (j && j.binding !== this.options.binding) return;
    const delay = Math.max(250, (j?.nextAt ?? 0) - this.now());
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.runOnce()
          .catch(() => {})
          .finally(() => {
            if (this.background && !this.stopped) this.notifyPoll();
          });
      },
      Math.min(delay, 2147483647),
    );
    this.timer.unref();
  }
  private notifyPoll(): void {
    if (!this.background || this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.notify();
    }, 15000);
    this.timer.unref();
  }
  runOnce(force = false): Promise<void> {
    if (this.running) return this.running;
    return this.exclusive(() => this.cycle(force));
  }

  private async observe(j: Journal, state: SyncState): Promise<boolean> {
    j.observedMode = state.mode;
    j.observedStatus = state.status;
    if (
      state.mode === 'local' ||
      state.status === 'purging' ||
      j.epoch !== state.epoch
    ) {
      j.paused = true;
      j.condition = state.mode === 'local' ? 'local' : 'paused';
      delete j.session;
      delete j.inventory;
      delete j.pending;
      this.save(j);
      return false;
    }
    return !j.paused;
  }
  private async cycle(force = false): Promise<void> {
    let j = this.store.syncRead<Journal>('active');
    // A checked purge stops transfer work, but its completion still needs a bounded state observation.
    if (
      j?.binding === this.options.binding &&
      j.paused &&
      j.observedStatus === 'purging' &&
      !['login-required', 'invalid'].includes(j.condition) &&
      (j.nextAt <= this.now() || (force && j.condition === 'local'))
    ) {
      try {
        const state = await this.request<SyncState>('state', {
          schema: 'personal-sync-state@1',
        });
        await this.observe(j, state);
        j.nextAt = this.now() + 15000;
        j.failures = 0;
        this.save(j);
      } catch (error) {
        this.recordFailure(j, error);
        throw error;
      }
      return;
    }
    if (
      j &&
      (j.binding !== this.options.binding ||
        (j.paused &&
          (j.pending?.route !== 'mode' ||
            j.condition === 'login-required' ||
            j.condition === 'invalid')) ||
        (j.nextAt > this.now() &&
          !(
            force && ['synced', 'pending', 'conflicted'].includes(j.condition)
          )))
    )
      return;
    if (!j) {
      j = {
        binding: this.options.binding,
        epoch: '',
        base: null,
        state: null,
        paused: false,
        condition: 'pending',
        failures: 0,
        nextAt: 0,
      };
      this.save(j);
    }
    try {
      const state = await this.request<SyncState>('state', {
        schema: 'personal-sync-state@1',
      });
      if (!j.epoch) {
        j.epoch = state.epoch;
        this.save(j);
      }
      if (j.pending?.route === 'mode') {
        await this.recover(j);
        return;
      }
      if (!(await this.observe(j, state))) return;
      if (
        state.limits.object_bytes > SYNC_LIMITS.objectBytes ||
        state.limits.batch_objects > SYNC_LIMITS.batchObjects
      )
        throw new RangeError('unsupported sync limits');
      // The request is durable before dispatch. Recover its receipt before creating any new operation.
      if (j.pending) await this.recover(j);
      await this.request('client', {
        body: {
          client_id: this.store.clientId,
          name: this.options.name ?? 'Circle',
        },
        schema: 'personal-sync-client@1',
      });
      if (j.session && Date.parse(j.session.expires_at) <= this.now()) {
        delete j.session;
        delete j.inventory;
        this.save(j);
      }
      if (!j.session) {
        const session = await this.request<SyncSession>('session', {
          body: {
            client_id: this.store.clientId,
            epoch: j.epoch,
            known_state: j.state,
            base_snapshot: j.base,
          },
          schema: 'personal-sync-session-reply@1',
        });
        if (!(await this.observe(j, session.state))) return;
        j.session = session;
        j.inventory = {
          cursor: session.inventory_cursor,
          done: session.state.snapshot === null,
          objects: [],
        };
        this.save(j);
      }
      const session = j.session!;
      const descriptors = j.inventory!;
      let pages = 0;
      const cursors = new Set<string>();
      while (!descriptors.done) {
        if (++pages > 100000 || cursors.has(descriptors.cursor ?? ''))
          throw new TypeError('sync inventory did not advance');
        cursors.add(descriptors.cursor ?? '');
        const page = await this.request<SyncInventory>('inventory', {
          id: session.session_id,
          query: {
            epoch: j.epoch,
            ...(descriptors.cursor ? { cursor: descriptors.cursor } : {}),
          },
          schema: 'personal-sync-inventory@1',
        });
        if (page.objects.length > session.state.limits.page_items)
          throw new RangeError('sync inventory page limit');
        if (page.snapshot !== session.state.snapshot)
          throw new TypeError('sync inventory snapshot changed');
        const known = new Set(descriptors.objects.map((d) => d.id));
        for (const d of page.objects) {
          if (known.has(d.id)) throw new TypeError('sync inventory duplicate');
          known.add(d.id);
          descriptors.objects.push(d);
        }
        if (descriptors.objects.length > 100000)
          throw new TypeError('sync inventory limit');
        descriptors.cursor = page.next;
        descriptors.done = page.next === null;
        this.save(j);
      }
      await this.download(j, descriptors.objects);
      const remote = session.state.snapshot;
      if (remote) this.store.graph(remote);
      // Local writes remain available while the network is in flight. Re-read just before merging.
      const local = this.store.head;
      const candidate = this.store.syncAtomic(this.token!, this.now, () =>
        mergeSnapshots(this.store, local, remote, j!.base),
      );
      await this.upload(j, candidate);
      // Recheck authority immediately before commit, including sessions resumed after mode changes.
      const latest = await this.request<SyncState>('state', {
        schema: 'personal-sync-state@1',
      });
      if (!(await this.observe(j, latest))) return;
      if (latest.state_version !== session.state.state_version) {
        delete j.session;
        delete j.inventory;
        j.condition = 'pending';
        j.nextAt = this.now() + 250;
        this.save(j);
        return;
      }
      const body = {
        schema: 'personal-sync-commit@1',
        epoch: j.epoch,
        operation_id: randomUUID(),
        expected_state: session.state.state_version,
        base_snapshot: j.base,
        snapshot: candidate,
      };
      await this.mutate(j, 'commit', body);
    } catch (error) {
      this.recordFailure(j, error);
      throw error;
    }
  }
  private recordFailure(j: Journal | null, error: unknown): void {
    this.active();
    if (!j) throw error;
    if (error instanceof SyncHttpError && (error.detail || error.unknownCode))
      j.refusal = {
        code: error.code,
        ...(error.detail ? { detail: error.detail } : {}),
      };
    if (
      error instanceof SyncHttpError &&
      error.code === 'SYNC_PURGE_CONFIRMATION_REQUIRED' &&
      j.pending?.route === 'mode'
    ) {
      // The server recorded the exact request; the identical retry performs it once the
      // account holder confirms there. Until then, or until it expires, ask again slowly.
      const confirmation = error.confirmation ?? j.confirmation;
      if (confirmation && Date.parse(confirmation.expiresAt) > this.now()) {
        j.confirmation = confirmation;
        j.condition = 'paused';
        j.nextAt = this.now() + 15000;
      } else {
        delete j.pending;
        delete j.confirmation;
        j.condition = 'pending';
        j.nextAt = this.now() + 250;
      }
    } else if (
      error instanceof SyncHttpError &&
      ['SYNC_MODE_LOCAL', 'SYNC_EPOCH_CHANGED'].includes(error.code)
    ) {
      j.paused = true;
      j.condition = error.code === 'SYNC_MODE_LOCAL' ? 'local' : 'paused';
      delete j.pending;
      delete j.session;
      delete j.inventory;
      delete j.confirmation;
    } else if (
      error instanceof SyncHttpError &&
      (error.code === 'SYNC_SESSION_EXPIRED' ||
        error.code === 'SYNC_VERSION_CONFLICT')
    ) {
      delete j.pending;
      delete j.session;
      delete j.inventory;
      delete j.confirmation;
      j.condition = 'pending';
      j.nextAt = this.now() + 250;
    } else {
      j.failures++;
      j.condition =
        error instanceof SyncHttpError && error.status === 401
          ? 'login-required'
          : error instanceof SyncHttpError &&
              error.code === 'SPACE_CAPACITY_EXCEEDED'
            ? 'capacity'
            : // A code this client does not know is a failure of that request, retried later.
              error instanceof SyncHttpError && error.unknownCode
              ? 'offline'
              : error instanceof TypeError ||
                  error instanceof RangeError ||
                  (error instanceof SyncHttpError && error.status === 422)
                ? 'invalid'
                : 'offline';
      if (j.condition === 'login-required' || j.condition === 'invalid')
        j.paused = true;
      j.nextAt =
        this.now() +
        Math.max(
          Math.min(300000, 1000 * 2 ** Math.min(j.failures, 9)),
          error instanceof SyncHttpError ? error.retryAfterSeconds * 1000 : 0,
        );
    }
    this.save(j);
  }
  private async download(
    j: Journal,
    descriptors: SyncDescriptor[],
  ): Promise<void> {
    const limits = j.session!.state.limits;
    for (let i = 0; i < descriptors.length;) {
      const batch: SyncDescriptor[] = [];
      let size = 0;
      while (i < descriptors.length && batch.length < limits.batch_objects) {
        const d = descriptors[i]!;
        if (d.bytes > Math.min(limits.object_bytes, SYNC_LIMITS.objectBytes))
          throw new TypeError('sync object exceeds local or server limit');
        if (this.store.has(d.id)) {
          const bytes = this.store.readBytes(d.id);
          if (bytes.length !== d.bytes || this.store.read(d.id).kind !== d.kind)
            throw new TypeError('sync descriptor mismatch');
          i++;
          continue;
        }
        if (
          size + d.bytes >
          Math.min(limits.batch_bytes, SYNC_LIMITS.objectBytes)
        ) {
          if (!batch.length) throw new TypeError('sync download batch limit');
          break;
        }
        batch.push(d);
        size += d.bytes;
        i++;
      }
      if (!batch.length) continue;
      const transfer = await this.request<SyncTransfer>('download', {
        id: j.session!.session_id,
        body: { epoch: j.epoch, objects: batch.map((d) => d.id) },
        schema: 'personal-sync-transfer@1',
      });
      if (transfer.missing.length || transfer.objects.length !== batch.length)
        throw new TypeError('sync download incomplete');
      const admitted = new Map<string, ReturnType<typeof decodeSyncObject>>();
      for (const o of transfer.objects) {
        const d = batch.find((d) => d.id === o.id);
        if (!d || admitted.has(o.id))
          throw new TypeError('unexpected sync object');
        const bytes = decodeBase64(o.bytes_base64);
        const object = decodeSyncObject(bytes, o.id);
        if (bytes.length !== d.bytes || object.kind !== d.kind)
          throw new TypeError('sync descriptor mismatch');
        admitted.set(o.id, object);
      }
      this.store.syncAtomic(this.token!, this.now, () =>
        this.store.putBatch([...admitted.values()]),
      );
    }
  }
  private async upload(j: Journal, snapshot: string): Promise<void> {
    const limits = j.session!.state.limits,
      ids = [...this.store.graph(snapshot).objects.keys()].sort();
    for (let i = 0; i < ids.length; i += limits.batch_objects) {
      const offered = ids.slice(i, i + limits.batch_objects);
      const reply = await this.request<{ missing: string[] }>('missing', {
        id: j.session!.session_id,
        body: { epoch: j.epoch, objects: offered },
      });
      if (
        !reply ||
        !Array.isArray(reply.missing) ||
        new Set(reply.missing).size !== reply.missing.length ||
        reply.missing.some((id) => !offered.includes(id))
      )
        throw new TypeError('invalid sync missing reply');
      let batch: { id: string; bytes_base64: string }[] = [],
        size = 0;
      const send = async () => {
        if (batch.length)
          await this.mutate(j, 'upload', {
            schema: 'personal-sync-upload@1',
            epoch: j.epoch,
            operation_id: randomUUID(),
            objects: batch,
          });
        batch = [];
        size = 0;
      };
      for (const id of reply.missing) {
        const bytes = this.store.readBytes(id);
        if (
          bytes.length > Math.min(limits.object_bytes, SYNC_LIMITS.objectBytes)
        )
          throw new RangeError('sync object byte limit');
        if (
          size + bytes.length >
          Math.min(limits.batch_bytes, SYNC_LIMITS.objectBytes)
        )
          await send();
        batch.push({ id, bytes_base64: bytes.toString('base64') });
        size += bytes.length;
      }
      await send();
    }
  }
  private async mutate(
    j: Journal,
    route: Pending['route'],
    body: Record<string, unknown>,
  ): Promise<void> {
    const schema =
      route === 'upload'
        ? 'personal-sync-upload@1'
        : route === 'commit'
          ? 'personal-sync-commit@1'
          : route === 'mode'
            ? 'personal-sync-mode-change@1'
            : 'personal-sync-abort@1';
    validateSync(schema, body);
    const session = route === 'mode' ? null : j.session!.session_id;
    const pending: Pending = {
      route,
      session,
      body,
      digest: operationDigest(route, session, body),
    };
    j.pending = pending;
    this.save(j);
    const result = await this.request<unknown>(route, {
      id: pending.session ?? undefined,
      body,
    });
    await this.accept(j, pending, result);
  }
  private async recover(j: Journal): Promise<void> {
    const p = j.pending!;
    if (p.digest !== operationDigest(p.route, p.session, p.body))
      throw new TypeError('sync journal request integrity');
    try {
      const reply = await this.request('operation', {
        id: p.body.operation_id as string,
        query: { epoch: j.epoch },
      });
      await this.accept(j, p, reply);
    } catch (error) {
      if (!(error instanceof SyncHttpError) || error.status !== 404)
        throw error;
      const reply = await this.request(p.route, {
        id: p.session ?? undefined,
        body: p.body,
      });
      await this.accept(j, p, reply);
    }
  }
  private async accept(j: Journal, p: Pending, value: unknown): Promise<void> {
    const receipt = parse<SyncReceipt>(
      'personal-sync-receipt@1',
      (value as SyncResult)?.receipt ?? value,
    );
    if (
      receipt.operation_id !== p.body.operation_id ||
      receipt.epoch !== j.epoch ||
      receipt.request !== p.digest
    )
      throw new TypeError('sync receipt identity mismatch');
    if (p.route === 'upload') {
      const objects = p.body.objects as { bytes_base64: string }[];
      if (
        receipt.counts.accepted + receipt.counts.existing !== objects.length ||
        receipt.counts.bytes !==
          objects.reduce(
            (n, o) => n + decodeBase64(o.bytes_base64).length,
            0,
          ) ||
        receipt.counts.downloaded !== 0
      )
        throw new TypeError('sync upload receipt counts mismatch');
    }
    if (p.route === 'mode') {
      const result = parse<{ state: SyncState; receipt: SyncReceipt }>(
        'personal-sync-mode-result@1',
        value,
      );
      if (
        result.state.state_version !== receipt.state_version ||
        result.state.mode !== p.body.mode ||
        receipt.previous_state !== p.body.expected_state
      )
        throw new TypeError('sync mode receipt mismatch');
      j.observedMode = result.state.mode;
      j.observedStatus = result.state.status;
      j.epoch = result.state.epoch;
      j.base = null;
      j.state = null;
      j.paused =
        result.state.mode !== 'hub' || result.state.status === 'purging';
      j.condition =
        result.state.mode === 'local'
          ? 'local'
          : j.paused
            ? 'paused'
            : 'pending';
      j.nextAt = 0;
      j.failures = 0;
      delete j.pending;
      delete j.session;
      delete j.inventory;
      delete j.refusal;
      delete j.confirmation;
      this.save(j);
    } else if (p.route === 'commit') {
      const result = parse<SyncResult>('personal-sync-result@1', value);
      if (
        result.state.epoch !== j.epoch ||
        result.state.mode !== 'hub' ||
        result.state.snapshot !== p.body.snapshot ||
        result.state.state_version !== receipt.state_version ||
        receipt.previous_state !== p.body.expected_state
      )
        throw new TypeError('sync commit receipt mismatch');
      const seen = new Set<string>();
      let next = result.next;
      const resultPages: SyncResult[] = [result];
      let resultBytes = Buffer.byteLength(JSON.stringify(result));
      while (next !== null) {
        if (seen.has(next) || seen.size >= 100000)
          throw new TypeError('sync result cursor did not advance');
        seen.add(next);
        const page = await this.request<SyncResult>('operation', {
          id: receipt.operation_id,
          query: { epoch: j.epoch, cursor: next },
          schema: 'personal-sync-result@1',
        });
        if (
          requestJson(page.receipt) !== requestJson(receipt) ||
          requestJson(page.state) !== requestJson(result.state)
        )
          throw new TypeError('sync result changed');
        resultBytes += Buffer.byteLength(JSON.stringify(page));
        if (resultBytes > 64 * 1024 * 1024)
          throw new RangeError('sync result aggregate limit');
        resultPages.push(page);
        next = page.next;
      }
      this.store.syncAtomic(this.token!, this.now, () => {
        this.store.syncWrite('projection', {
          binding: j.binding,
          epoch: j.epoch,
          snapshot: result.state.snapshot,
          state: result.state.state_version,
          projections: resultPages.flatMap((p) => p.projections ?? []),
        });
        j.observedMode = result.state.mode;
        j.observedStatus = result.state.status;
        for (let i = 0; i < resultPages.length; i++)
          this.store.syncWrite(
            `result:${receipt.epoch}:${receipt.operation_id}:${i}`,
            resultPages[i],
          );
        const local = this.store.head;
        const snapshot = mergeSnapshots(
          this.store,
          local,
          result.state.snapshot,
          j.base,
        );
        if (snapshot !== local) this.store.publishSync(snapshot, local);
        j.base = result.state.snapshot;
        j.state = result.state.state_version;
        j.lastSyncedAt = receipt.at;
        j.failures = 0;
        delete j.refusal;
        j.condition =
          this.store.graph(snapshot).conflicts.length ||
          resultPages.some((p) => p.conflicts.length)
            ? 'conflicted'
            : snapshot === result.state.snapshot
              ? 'synced'
              : 'pending';
        j.nextAt = this.now() + 15000;
        delete j.pending;
        delete j.session;
        delete j.inventory;
        this.store.syncWrite('active', j);
      });
      this.report();
    } else {
      delete j.pending;
      this.save(j);
    }
  }
  /** A host-confirmed operation, separate from model tools and background sync. */
  async changeMode(
    mode: 'hub' | 'local',
    approve: (
      impact: Readonly<ModeImpact>,
      signal: AbortSignal,
    ) => Promise<boolean>,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    let impact: ModeImpact | undefined, state: SyncState | undefined;
    await this.exclusive(async () => {
      const j = this.store.syncRead<Journal>('active');
      if (j && j.binding !== this.options.binding)
        throw Error('confirm the selected account before changing sync mode');
      if (j?.pending)
        throw Error('recover the pending operation before changing sync mode');
      state = await this.request<SyncState>('state', {
        schema: 'personal-sync-state@1',
      });
      impact = await this.request<ModeImpact>('modeCheck', {
        body: { mode },
        schema: 'personal-sync-mode-impact@1',
      });
      if (impact.mode !== mode || impact.expected_state !== state.state_version)
        throw new TypeError('sync mode preview changed');
    });
    const preview = JSON.parse(JSON.stringify(impact)) as ModeImpact;
    if (!(await approve(Object.freeze(preview), signal))) return false;
    signal.throwIfAborted();
    await this.exclusive(async () => {
      signal.throwIfAborted();
      const latest = await this.request<SyncState>('state', {
        schema: 'personal-sync-state@1',
      });
      if (
        latest.state_version !== state!.state_version ||
        latest.epoch !== state!.epoch
      )
        throw new KnowledgeVersionConflict(this.store.head);
      const prior = this.store.syncRead<Journal>('active');
      if (prior && (prior.binding !== this.options.binding || prior.pending))
        throw Error('sync binding or pending operation changed');
      const j = prior ?? {
        binding: this.options.binding,
        epoch: latest.epoch,
        base: null,
        state: null,
        paused: false,
        condition: 'pending' as const,
        failures: 0,
        nextAt: 0,
      };
      signal.throwIfAborted();
      j.epoch = latest.epoch;
      // Canonical copies from the preview are retained; approval callback mutation cannot alter them.
      try {
        await this.mutate(j, 'mode', {
          epoch: latest.epoch,
          operation_id: randomUUID(),
          mode,
          expected_state: impact!.expected_state,
          check: impact!.check,
          confirm_purge: mode === 'local',
        });
      } catch (error) {
        this.recordFailure(j, error);
        throw error;
      }
    });
    return true;
  }
  /** Host-confirmed retry after authorization; retain the exact pending operation and common base. */
  async resumeAuthorization(): Promise<void> {
    await this.exclusive(async () => {
      const j = this.store.syncRead<Journal>('active');
      if (!j || j.binding !== this.options.binding)
        throw Error('confirm the selected connection first');
      const state = await this.request<SyncState>('state', {
        schema: 'personal-sync-state@1',
      });
      if (
        j.pending?.route !== 'mode' &&
        (state.mode !== 'hub' ||
          state.status === 'purging' ||
          state.epoch !== j.epoch)
      ) {
        await this.observe(j, state);
        return;
      }
      j.paused = false;
      j.condition = 'pending';
      j.nextAt = 0;
      this.save(j);
    });
  }
  /** Explicitly abandon a transfer; local objects and revisions are retained. */
  async abortTransfer(): Promise<void> {
    await this.exclusive(async () => {
      const j = this.store.syncRead<Journal>('active');
      if (!j || j.binding !== this.options.binding || !j.session) return;
      if (j.pending) await this.recover(j);
      if (!j.session) return;
      await this.mutate(j, 'abort', {
        epoch: j.epoch,
        operation_id: randomUUID(),
      });
      delete j.session;
      delete j.inventory;
      j.condition = 'pending';
      j.nextAt = 0;
      this.save(j);
    });
  }
  async cancel(): Promise<void> {
    this.background = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort(Error('knowledge sync canceled'));
    try {
      await this.running;
    } catch {
      /* Pending identity is retained for receipt recovery. */
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.cancel();
    this.store.close();
  }
}
