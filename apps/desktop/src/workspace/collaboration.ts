import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { Tool, ToolContext } from '../../../../src/types.js';
import {
  TaskStore,
  taskArtifactDirectory,
  type CollaborationEvent,
  type Json,
  type OperationRecord,
  type TaskArtifact,
  type TaskRecord,
  type TaskResource,
  type TaskSpec,
  type TaskState,
  type TaskReviewerUpdate,
  type TaskSendBack,
  proposedTasks,
  type TaskProposal,
  type TaskProposalReceipt,
  TASK_RESOURCES,
  taskResourceGrants,
} from './task-store.js';
import { resolveTaskBaseline, TaskWorktrees } from './task-worktrees.js';
export type {
  CollaborationEvent,
  Json,
  TaskArtifact,
  TaskRecord,
  TaskResource,
  TaskSendBack,
  TaskSpec,
  TaskState,
} from './task-store.js';

export interface CollaborationLimits {
  agents: number;
  builds: number;
  ui: number;
  browsers: number;
}
export const DEFAULT_COLLABORATION_LIMITS: Readonly<CollaborationLimits> =
  Object.freeze({ agents: 8, builds: 2, ui: 1, browsers: 1 });

// The lease says who holds the task ledger, and its owner renews it on a heartbeat,
// as a session lease does (src/session_lock.ts). A process that stopped renewing it
// is gone: its id is not proof, because the system hands the same id out again.
export const COLLABORATION_LEASE_HEARTBEAT_MS = 5_000;
export const COLLABORATION_LEASE_STALE_MS = 30_000;
export interface TaskExecutionResult {
  passed: boolean;
  verdict?: 'passed' | 'failed' | 'needs_review';
  result?: Json;
  reason?: string;
  artifacts?: { path: string; kind: string }[];
}
export interface TaskExecutionContext {
  signal: AbortSignal;
  worktree: string;
  artifactDirectory: string;
  bindRuntimeSession(
    sessionId: string,
    operationScopedResources?: boolean,
  ): void;
  /** The closed worker has no live operations using the declared resource. */
  releaseResourceAdmission?(): void;
  allowedResources?: readonly TaskResource[];
  runtimeState?(state: TaskState): void;
  reviewer?(record: TaskReviewerUpdate): void;
  /** Enforce this in the injected runtime's permissions; Git worktrees are not security sandboxes. */
  access: TaskSpec['access'];
  dependencies: { task: TaskRecord; artifacts: TaskArtifact[] }[];
  emit(type: string, payload: Json): void;
  waiting(reason: string): void;
  running(): void;
  withResource<T>(
    resource: Exclude<TaskResource, 'agent'>,
    action: () => Promise<T>,
  ): Promise<T>;
  /** Explicit operation IDs are idempotent within the current attempt. Unknown outcomes need review. */
  runOperation<T extends Json>(
    id: string,
    input: Json,
    action: () => Promise<T>,
  ): Promise<T>;
  artifact(path: string, kind: string): Promise<TaskArtifact>;
  /** Records a suggestion only; a separately authorized coordinator must adopt it. */
  proposeTasks?(
    runtimeSessionId: string,
    operationId: string,
    tasks: unknown,
  ): Promise<TaskProposalReceipt>;
  onCleanup(action: () => void | Promise<void>): void;
}
export type TaskExecutor = (
  task: TaskRecord,
  context: TaskExecutionContext,
) => Promise<TaskExecutionResult>;
export interface CollaborationOptions {
  dataDir: string;
  executor: TaskExecutor;
  limits?: Partial<CollaborationLimits>;
  resources?: CollaborationResources;
  allowedResources?: readonly TaskResource[];
}
export class OperationNeedsReviewError extends Error {
  constructor(readonly operationId: string) {
    super(
      `operation ${operationId} has an unknown outcome; review it before retrying`,
    );
    this.name = 'OperationNeedsReviewError';
  }
}
const terminal = new Set<TaskState>([
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
  'interrupted',
  'needs_review',
]);
const failedDependency = new Set<TaskState>([
  'failed',
  'blocked',
  'cancelling',
  'cancelled',
  'interrupted',
  'needs_review',
]);
function aborted(): Error {
  return new DOMException('task cancelled', 'AbortError');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function contained(parent: string, target: string): boolean {
  const path = relative(parent, target);
  return (
    path === '' ||
    (!isAbsolute(path) &&
      path !== '..' &&
      !path.startsWith('../') &&
      !path.startsWith('..\\'))
  );
}
function validateLimits(limits: CollaborationLimits): void {
  for (const [key, value] of Object.entries(limits))
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > (key === 'agents' ? 32 : key === 'ui' ? 1 : 32)
    )
      throw new Error(`invalid ${key} concurrency`);
}
class ResourcePool {
  active = 0;
  private waiters: {
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  constructor(
    public capacity: number,
    private readonly changed: () => void,
  ) {}
  tryAcquire(): ((notify?: boolean) => void) | undefined {
    if (this.active >= this.capacity || this.waiters.length) return;
    this.active++;
    return this.release();
  }
  private release(): (notify?: boolean) => void {
    let released = false;
    return (notify = true) => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
      if (notify) this.changed();
    };
  }
  private drain(): void {
    while (this.active < this.capacity && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(aborted());
        continue;
      }
      this.active++;
      waiter.resolve(this.release());
    }
  }
  resize(value: number): void {
    this.capacity = value;
    this.drain();
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(aborted());
    const release = this.tryAcquire();
    if (release) return Promise.resolve(release);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          reject(aborted());
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
    });
  }
}
interface ResourceLease {
  external: boolean;
  users: number;
  held: boolean;
  finished: Promise<void>;
  settle(): void;
  release(): void;
}
interface ResourceOwnership {
  lease: ResourceLease;
  active: boolean;
}
export class TaskResourceError extends Error {}
const toolResources = new WeakMap<
  Tool,
  Exclude<TaskResource, 'agent'> | 'control'
>();
/** Only host-constructed tool objects are tagged; names and model arguments cannot claim a resource. */
export function bindToolResource<T extends Tool>(
  tool: T,
  resource: Exclude<TaskResource, 'agent'> | 'control',
): T {
  if (!['build', 'ui', 'browser', 'control'].includes(resource))
    throw Error('invalid tool resource');
  toolResources.set(tool, resource);
  return tool;
}
/** One instance per app worker; every authorized workspace shares these limits. */
export class CollaborationResources {
  readonly pools: Record<TaskResource, ResourcePool>;
  private readonly ownership = new AsyncLocalStorage<
    Map<TaskResource, ResourceOwnership>
  >();
  private limits: CollaborationLimits;
  private readonly listeners = new Set<() => void>();
  constructor(limits: Partial<CollaborationLimits> = {}) {
    this.limits = { ...DEFAULT_COLLABORATION_LIMITS, ...limits };
    validateLimits(this.limits);
    const changed = () => {
      for (const listener of this.listeners) listener();
    };
    this.pools = {
      agent: new ResourcePool(this.limits.agents, changed),
      build: new ResourcePool(this.limits.builds, changed),
      ui: new ResourcePool(this.limits.ui, changed),
      browser: new ResourcePool(this.limits.browsers, changed),
    };
  }
  getLimits(): CollaborationLimits {
    return { ...this.limits };
  }
  private lease(release: () => void, external = false): ResourceLease {
    let settle!: () => void;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { users: 0, held: true, finished, settle, release, external };
  }
  private async useLease<T>(
    resource: TaskResource,
    lease: ResourceLease,
    action: () => Promise<T>,
  ): Promise<T> {
    const owner: ResourceOwnership = { lease, active: true };
    const scope = new Map(this.ownership.getStore());
    scope.set(resource, owner);
    lease.users++;
    try {
      return await this.ownership.run(scope, action);
    } finally {
      this.releaseOwner(owner);
    }
  }
  private releaseOwner(owner: ResourceOwnership): void {
    if (!owner.active) return;
    owner.active = false;
    if (--owner.lease.users === 0) {
      owner.lease.held = false;
      try {
        owner.lease.release();
      } finally {
        owner.lease.settle();
      }
    }
  }
  /** Only the scheduler's fresh-runtime/closed-worker admission can be released early. */
  releaseAdmission(resource: TaskResource): void {
    const owner = this.ownership.getStore()?.get(resource);
    if (!owner?.active) return;
    if (owner.lease.users !== 1)
      throw new TaskResourceError(
        'resource operations have not settled; admission cannot be released',
      );
    this.releaseOwner(owner);
  }
  /** A trusted nested approval may yield only its own unshared operation lease. */
  async suspendResource<T>(
    resource: TaskResource,
    wait: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const owner = this.ownership.getStore()?.get(resource);
    if (!owner?.active) return wait();
    if (owner.lease.external || owner.lease.users !== 1)
      throw new TaskResourceError(
        'cannot suspend a shared or scheduler admission lease',
      );
    this.releaseOwner(owner);
    const result = await wait();
    signal.throwIfAborted();
    const release = await this.pools[resource].acquire(signal);
    owner.lease = this.lease(release);
    owner.lease.users = 1;
    owner.active = true;
    return result;
  }
  /** @internal External scheduler leases remain held until all nested operations settle. */
  async runWithHeldResources<T>(
    resources: TaskResource[],
    action: () => Promise<T>,
  ): Promise<T> {
    const held = [...new Set(resources)].map((resource) => ({
      resource,
      lease: this.lease(() => {}, true),
    }));
    const run = (index: number): Promise<T> =>
      index === held.length
        ? action()
        : this.useLease(held[index]!.resource, held[index]!.lease, () =>
            run(index + 1),
          );
    try {
      return await run(0);
    } finally {
      await Promise.all(held.map(({ lease }) => lease.finished));
    }
  }
  async withResource<T>(
    resource: TaskResource,
    action: () => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    signal.throwIfAborted();
    const owner = this.ownership.getStore()?.get(resource);
    if (owner?.active && owner.lease.held)
      return this.useLease(resource, owner.lease, action);
    if (
      resource !== 'agent' &&
      [...(this.ownership.getStore() ?? [])].some(
        ([held, owner]) =>
          held !== 'agent' &&
          held !== resource &&
          owner.active &&
          owner.lease.held,
      )
    )
      throw new TaskResourceError(
        'release the current resource before requesting a different resource',
      );
    const release = await this.pools[resource].acquire(signal);
    return this.useLease(resource, this.lease(release), async () => {
      signal.throwIfAborted();
      return action();
    });
  }
  /** Suitable for RuntimeOptions.executeTool; permission checks still belong to the harness. */
  executeTool = (
    tool: Tool,
    _args: Record<string, unknown>,
    context: ToolContext,
    run: () => Promise<string>,
    allowedResources: readonly TaskResource[] = TASK_RESOURCES,
  ): Promise<string> => {
    const grants = taskResourceGrants(allowedResources);
    const resource = toolResources.get(tool);
    if (resource === 'control') {
      context.signal.throwIfAborted();
      return run();
    }
    if (resource && !grants.includes(resource))
      return Promise.reject(
        new TaskResourceError(`tool resource ${resource} is not granted`),
      );
    const invoke = () => this.withResource('agent', run, context.signal);
    return resource
      ? this.withResource(resource, invoke, context.signal)
      : invoke();
  };
  setLimits(limits: Partial<CollaborationLimits>): void {
    const next = { ...this.limits, ...limits };
    validateLimits(next);
    this.limits = next;
    this.pools.agent.resize(next.agents);
    this.pools.build.resize(next.builds);
    this.pools.ui.resize(next.ui);
    this.pools.browser.resize(next.browsers);
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
/** Main-process only. The caller supplies an authorized repository root and an approval-aware executor. */
export class CollaborationScheduler {
  private readonly store: TaskStore;
  private readonly trees: TaskWorktrees;
  private readonly pools: Record<TaskResource, ResourcePool>;
  private readonly resources: CollaborationResources;
  private readonly unsubscribeResources: () => void;
  private readonly listeners = new Set<(event: CollaborationEvent) => void>();
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly failedCleanups = new Map<
    string,
    (() => void | Promise<void>)[]
  >();
  private readonly pendingOperations = new Map<string, Promise<Json>>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly leasePath: string;
  private readonly leaseToken = randomUUID();
  private leaseBeat?: ReturnType<typeof setInterval>;
  private leaseLost = false;
  private limits: CollaborationLimits;
  private readonly allowedResources: TaskResource[];
  private started = false;
  private pumping = false;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  constructor(private readonly options: CollaborationOptions) {
    if (!isAbsolute(options.dataDir))
      throw new Error('collaboration data directory must be absolute');
    this.limits = { ...DEFAULT_COLLABORATION_LIMITS, ...options.limits };
    validateLimits(this.limits);
    this.allowedResources = taskResourceGrants(
      options.allowedResources ?? TASK_RESOURCES,
    );
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.leasePath = join(options.dataDir, 'collaboration.lock');
    this.acquireLease();
    try {
      this.store = new TaskStore(join(options.dataDir, 'collaboration.sqlite'));
    } catch (error) {
      this.releaseLease();
      throw error;
    }
    this.trees = new TaskWorktrees(join(options.dataDir, 'worktrees'));
    this.resources =
      options.resources ?? new CollaborationResources(this.limits);
    this.limits = this.resources.getLimits();
    this.pools = this.resources.pools;
    this.unsubscribeResources = this.resources.subscribe(() => this.schedule());
    this.store.transaction(() => {
      for (const task of this.store.list()) {
        let changed = false;
        if (
          ['preparing', 'running', 'waiting', 'cancelling'].includes(task.state)
        ) {
          task.state = 'interrupted';
          task.reason =
            'previous process ended; review effects before retrying';
          task.updatedAt = Date.now();
          changed = true;
        }
        if (
          task.runtimeState &&
          ['running', 'waiting', 'cancelling'].includes(task.runtimeState)
        ) {
          task.runtimeState = 'interrupted';
          changed = true;
        }
        for (const reviewer of task.reviewers ?? [])
          if (['running', 'waiting', 'cancelling'].includes(reviewer.state)) {
            reviewer.state = 'interrupted';
            reviewer.reason =
              'previous process ended; review effects before retrying';
            reviewer.updatedAt = Date.now();
            changed = true;
          }
        if (changed) {
          this.store.put(task);
          this.store.event(
            'task.interrupted',
            {
              reason:
                task.reason ?? 'previous runtime ended; review before retrying',
            },
            task,
          );
        }
      }
      for (const operation of this.store.operations())
        if (operation.state === 'running')
          this.store.putOperation({ ...operation, state: 'needs_review' });
    });
    this.reconcile();
  }
  private acquireLease(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const descriptor = openSync(this.leasePath, 'wx', 0o600);
        try {
          writeFileSync(descriptor, this.leaseBody());
        } finally {
          closeSync(descriptor);
        }
        this.keepLease();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (this.leaseHeld())
          throw new Error('collaboration scheduler is already open');
        unlinkSync(this.leasePath);
      }
    }
    throw new Error('could not acquire collaboration lease');
  }
  /** What the owner writes: itself, and the instant it last said so. */
  private leaseBody(): string {
    return JSON.stringify({
      pid: process.pid,
      token: this.leaseToken,
      at: Date.now(),
    });
  }
  /**
   * Whether another Circle holds the lease now. A process id alone is not proof
   * of anything: a killed runtime leaves its number behind, and the system hands
   * that number to another process, which would lock the ledger for good. So a
   * holder that cannot be proved gone still expires, and a lease that cannot be
   * read is judged by the time on the file itself.
   */
  private leaseHeld(): boolean {
    let written = 0;
    try {
      written = statSync(this.leasePath).mtimeMs;
    } catch {
      return false;
    }
    let owner: { pid?: unknown; token?: unknown; at?: unknown } = {};
    try {
      owner = JSON.parse(readFileSync(this.leasePath, 'utf8'));
    } catch {
      /* Only its own time can say anything about it. */
    }
    if (owner.token === this.leaseToken) return false;
    // Two proofs that the owner is gone, and neither one alone is enough: an
    // id the system has taken back, or a renewal that stopped. A lease nobody
    // can prove is dead still expires, which is what frees a ledger whose
    // runtime was killed and whose number the system has handed out again.
    if (!CollaborationScheduler.ownerRunning(owner.pid)) return false;
    const at = typeof owner.at === 'number' ? owner.at : written;
    return Date.now() - at < COLLABORATION_LEASE_STALE_MS;
  }
  /**
   * Whether the id a lease left behind still names a running process.
   * An answer the system cannot give is no proof of death: the renewal does.
   */
  private static ownerRunning(pid: unknown): boolean {
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1)
      return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // ESRCH is the one answer that proves the owner is gone. EPERM means it is
      // there and merely not ours to signal, and anything else the system will
      // not say leaves the renewal to decide.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }
  /** Renew the lease, and notice when another Circle has taken the ledger. */
  private keepLease(): void {
    clearInterval(this.leaseBeat);
    this.leaseBeat = setInterval(() => {
      if (this.closing || this.closed) return;
      let token: unknown;
      try {
        token = JSON.parse(readFileSync(this.leasePath, 'utf8')).token;
      } catch {
        token = undefined;
      }
      if (token !== this.leaseToken) {
        // Someone else holds it now: start nothing more from this one.
        this.leaseLost = true;
        return;
      }
      try {
        writeFileSync(this.leasePath, this.leaseBody());
      } catch {
        this.leaseLost = true;
      }
    }, COLLABORATION_LEASE_HEARTBEAT_MS);
    this.leaseBeat.unref();
  }
  private releaseLease(): void {
    try {
      if (
        JSON.parse(readFileSync(this.leasePath, 'utf8')).token ===
        this.leaseToken
      )
        unlinkSync(this.leasePath);
    } catch {
      /* Never delete a replacement owner's lease. */
    }
  }
  private assertOpen(): void {
    if (this.closed || this.closing)
      throw new Error('collaboration scheduler is closed');
  }
  list(): TaskRecord[] {
    return this.store.list();
  }
  get(id: string): TaskRecord | undefined {
    return this.store.get(id);
  }
  attempts(id: string): TaskRecord[] {
    return this.store.attempts(id);
  }
  artifacts(id?: string): TaskArtifact[] {
    return this.store.artifacts(id);
  }
  eventsAfter(cursor = 0, limit = 1000): CollaborationEvent[] {
    return this.store.eventsAfter(cursor, limit);
  }
  subscribe(listener: (event: CollaborationEvent) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(event: CollaborationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* A renderer consumer cannot corrupt execution state. */
      }
    }
  }
  private event(type: string, payload: Json, task?: TaskRecord): void {
    this.publish(this.store.event(type, payload, task));
  }
  private update(
    id: string,
    state: TaskState,
    fields: Partial<TaskRecord> = {},
  ): TaskRecord {
    const task = this.store.get(id)!;
    Object.assign(task, fields, { state, updatedAt: Date.now() });
    const event = this.store.transaction(() => {
      this.store.put(task);
      return this.store.event(
        `task.${state}`,
        { state, ...(task.reason ? { reason: task.reason } : {}) },
        task,
      );
    });
    this.publish(event);
    return task;
  }
  private updateAttempt(
    id: string,
    attempt: number,
    mutate: (record: TaskRecord) => void,
    type: string,
    payload: Json,
  ): void {
    const task = this.store
      .attempts(id)
      .find((record) => record.attempt === attempt);
    if (!task) throw Error('task attempt is missing');
    mutate(task);
    task.updatedAt = Date.now();
    const event = this.store.transaction(() => {
      if (this.store.get(id)?.attempt === attempt) this.store.put(task);
      else this.store.putHistoricalAttempt(task);
      return this.store.event(type, payload, task);
    });
    this.publish(event);
  }
  async enqueue(
    specs: TaskSpec[],
    options: { operationId: string; beforeCommit?: () => void },
  ): Promise<TaskRecord[]> {
    this.assertOpen();
    if (!options.operationId || !specs.length)
      throw new Error('tasks and operationId are required');
    const operationId = `enqueue:${options.operationId}`,
      hash = fingerprint(specs);
    const existing = this.store.operation(operationId);
    if (existing) return this.enqueued(existing, hash);
    const resolved = await Promise.all(
      specs.map(async (input) => {
        if (
          !input.id ||
          !input.prompt.trim() ||
          !Array.isArray(input.acceptanceCriteria) ||
          !input.acceptanceCriteria.length ||
          !['write', 'readonly'].includes(input.access) ||
          (input.resource &&
            !['agent', 'build', 'ui', 'browser'].includes(input.resource))
        )
          throw new Error('invalid task specification');
        const pin = await resolveTaskBaseline(input.workspace, input.baseline);
        const dataDir = await realpath(this.options.dataDir);
        if (contained(pin.workspace, dataDir))
          throw new Error(
            'collaboration data must be outside the authorized workspace',
          );
        return {
          ...input,
          ...pin,
          allowedResources: taskResourceGrants(
            input.allowedResources ?? this.allowedResources,
            this.allowedResources,
          ),
          dependencies: [...new Set(input.dependencies ?? [])],
        };
      }),
    );
    this.assertOpen();
    const now = Date.now();
    const events: CollaborationEvent[] = [];
    const tasks = this.store.transaction(() => {
      options.beforeCommit?.();
      const previous = this.store.operation(operationId);
      if (previous) return this.enqueued(previous, hash);
      const all = new Map(
        this.store.list().map((task) => [task.spec.id, task.spec]),
      );
      for (const spec of resolved) {
        if (all.has(spec.id)) throw new Error(`duplicate task ${spec.id}`);
        all.set(spec.id, spec);
      }
      const visiting = new Set<string>(),
        visited = new Set<string>();
      const visit = (id: string) => {
        if (visiting.has(id)) throw new Error('task dependency cycle');
        if (visited.has(id)) return;
        const spec = all.get(id);
        if (!spec) throw new Error(`unknown dependency ${id}`);
        visiting.add(id);
        for (const dependency of spec.dependencies) visit(dependency);
        visiting.delete(id);
        visited.add(id);
      };
      for (const spec of resolved) {
        if (spec.parentId && !all.has(spec.parentId))
          throw new Error(`unknown parent ${spec.parentId}`);
        visit(spec.id);
        const parents = new Set<string>([spec.id]);
        let parent = spec.parentId;
        while (parent) {
          if (parents.has(parent)) throw new Error('task parent cycle');
          parents.add(parent);
          parent = all.get(parent)?.parentId;
        }
      }
      const records: TaskRecord[] = resolved.map((spec) => ({
        spec,
        state: 'queued',
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      }));
      for (const task of records) {
        this.store.put(task);
        events.push(this.store.event('task.queued', { state: 'queued' }, task));
      }
      this.store.putOperation({
        id: operationId,
        kind: 'enqueue',
        fingerprint: hash,
        state: 'succeeded',
        result: records.map((task) => task.spec.id),
      });
      return records;
    });
    for (const event of events) this.publish(event);
    this.schedule();
    return tasks;
  }
  private enqueued(operation: OperationRecord, hash: string): TaskRecord[] {
    if (operation.fingerprint !== hash)
      throw new Error('operationId was reused with different tasks');
    return (operation.result as string[]).map((id) => this.store.get(id)!);
  }
  start(): void {
    this.assertOpen();
    if (this.leaseLost)
      throw new Error(
        'collaboration lease was taken by another Circle; reopen the tasks',
      );
    this.started = true;
    this.schedule();
  }
  getLimits(): CollaborationLimits {
    return this.resources.getLimits();
  }
  setLimits(limits: Partial<CollaborationLimits>): void {
    this.assertOpen();
    this.resources.setLimits(limits);
    const next = this.resources.getLimits();
    this.event('limits.changed', { ...next });
    this.schedule();
  }
  private reconcile(): void {
    let changed: boolean;
    do {
      changed = false;
      const all = new Map(
        this.store.list().map((task) => [task.spec.id, task]),
      );
      for (const task of all.values())
        if (task.state === 'queued' || task.state === 'blocked') {
          const blocked = task.spec.dependencies.find((id) =>
            failedDependency.has(all.get(id)!.state),
          );
          if (blocked && task.state !== 'blocked') {
            this.update(task.spec.id, 'blocked', {
              reason: `dependency ${blocked} did not succeed`,
            });
            changed = true;
          } else if (!blocked && task.state === 'blocked') {
            this.update(task.spec.id, 'queued', { reason: undefined });
            changed = true;
          }
        }
    } while (changed);
  }
  private schedule(): void {
    if (
      !this.started ||
      this.closing ||
      this.closed ||
      this.pumping ||
      // Another Circle took the ledger while this one was not looking.
      this.leaseLost
    )
      return;
    this.pumping = true;
    queueMicrotask(() => {
      if (this.closing || this.closed) {
        this.pumping = false;
        return;
      }
      this.reconcile();
      for (const task of this.store.list()) {
        if (
          task.state !== 'queued' ||
          this.active.has(task.spec.id) ||
          !task.spec.dependencies.every(
            (id) => this.store.get(id)?.state === 'succeeded',
          )
        )
          continue;
        try {
          const grants = taskResourceGrants(
            task.spec.allowedResources ?? this.allowedResources,
            this.allowedResources,
          );
          if (!grants.includes(task.spec.resource ?? 'agent'))
            throw new TaskResourceError(
              'the task resource is not granted by its host',
            );
        } catch (error) {
          this.update(task.spec.id, 'needs_review', { reason: message(error) });
          continue;
        }
        const releaseAgent = this.pools.agent.tryAcquire();
        if (!releaseAgent) break;
        const resource = task.spec.resource ?? 'agent';
        const releaseResource =
          resource === 'agent' ? () => {} : this.pools[resource].tryAcquire();
        if (!releaseResource) {
          releaseAgent(false);
          continue;
        }
        const controller = new AbortController();
        // Defer executor creation until ownership is in the active map (including synchronous cancellation).
        const done = Promise.resolve()
          .then(() =>
            this.resources.runWithHeldResources(['agent', resource], () =>
              this.execute(
                task.spec.id,
                controller,
                resource,
                releaseAgent,
                releaseResource,
              ),
            ),
          )
          .finally(() => {
            if (this.active.get(task.spec.id)?.controller === controller)
              this.active.delete(task.spec.id);
            releaseResource();
            releaseAgent();
            this.schedule();
            this.checkIdle();
          });
        void done.catch(() => {});
        this.active.set(task.spec.id, { controller, done });
        this.update(task.spec.id, 'preparing', { reason: undefined });
      }
      this.pumping = false;
      this.checkIdle();
    });
  }
  private async execute(
    id: string,
    controller: AbortController,
    resource: TaskResource,
    releaseAgent: () => void,
    releaseResource: () => void,
  ): Promise<void> {
    const cleanups: (() => void | Promise<void>)[] = [];
    const ownedActions: Promise<unknown>[] = [];
    const track = <T>(promise: Promise<T>): Promise<T> => {
      ownedActions.push(promise);
      // The scheduler owns settlement even if an injected executor forgets to await.
      void promise.catch(() => {});
      return promise;
    };
    let result: TaskExecutionResult | undefined, error: unknown;
    try {
      if (controller.signal.aborted) throw aborted();
      const task = this.store.get(id)!;
      const prepared = await this.trees.prepare(task, controller.signal);
      this.update(id, controller.signal.aborted ? 'cancelling' : 'running', {
        worktree: prepared.path,
        branch: prepared.branch,
      });
      if (controller.signal.aborted) throw aborted();
      const artifactDirectory = this.artifactDirectory(task);
      await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
      const context: TaskExecutionContext = {
        signal: controller.signal,
        worktree: prepared.path,
        artifactDirectory,
        allowedResources: Object.freeze(
          taskResourceGrants(
            task.spec.allowedResources ?? this.allowedResources,
            this.allowedResources,
          ),
        ),
        releaseResourceAdmission: () => {
          if (resource !== 'agent') {
            this.resources.releaseAdmission(resource);
            releaseResource();
          }
        },
        bindRuntimeSession: (sessionId, operationScopedResources) => {
          if (!sessionId.trim())
            throw new Error('runtime session id is required');
          this.updateAttempt(
            id,
            task.attempt,
            (record) => {
              if (
                record.runtimeSessionId &&
                record.runtimeSessionId !== sessionId
              )
                throw Error('worker runtime session identity changed');
              record.runtimeSessionId = sessionId;
              record.runtimeState = 'running';
            },
            'task.session',
            { runtimeSessionId: sessionId },
          );
          if (operationScopedResources) {
            this.resources.releaseAdmission('agent');
            releaseAgent();
          }
        },
        runtimeState: (state) =>
          this.updateAttempt(
            id,
            task.attempt,
            (record) => {
              record.runtimeState = state;
            },
            'task.runtime-state',
            { state },
          ),
        reviewer: (input) =>
          this.updateAttempt(
            id,
            task.attempt,
            (record) => {
              const normalized = {
                ...input,
                workspace: realpathSync.native(input.workspace),
              };
              if (
                !input.sessionId.trim() ||
                input.sessionId === record.runtimeSessionId ||
                input.sessionId === record.spec.sessionId ||
                !record.worktree ||
                realpathSync.native(input.workspace) !==
                  realpathSync.native(record.worktree) ||
                input.baseline !== record.spec.baseline ||
                !/^[0-9a-f]{40,64}$/.test(input.head) ||
                !/^[0-9a-f]{64}$/.test(input.patchSha256)
              )
                throw Error('invalid reviewer provenance');
              if (
                input.artifact &&
                !this.store
                  .artifacts(id)
                  .some(
                    (artifact) =>
                      artifact.id === input.artifact!.id &&
                      artifact.attempt === task.attempt &&
                      artifact.baseline === record.spec.baseline &&
                      artifact.path === input.artifact!.path &&
                      artifact.sha256 === input.artifact!.sha256,
                  )
              )
                throw Error(
                  'reviewer artifact is not registered to this attempt',
                );
              const reviewers = (record.reviewers ??= []);
              const previous = reviewers.find(
                (reviewer) => reviewer.sessionId === input.sessionId,
              );
              if (
                previous &&
                ['workspace', 'baseline', 'head', 'patchSha256'].some(
                  (key) =>
                    previous[key as keyof typeof previous] !==
                    normalized[key as keyof typeof normalized],
                )
              )
                throw Error('reviewer provenance changed');
              if (
                previous?.artifact &&
                input.artifact &&
                ['id', 'path', 'sha256'].some(
                  (key) =>
                    previous.artifact![
                      key as keyof typeof previous.artifact
                    ] !== input.artifact![key as keyof typeof input.artifact],
                )
              )
                throw Error('reviewer artifact identity changed');
              const now = Date.now();
              const next = {
                ...normalized,
                ...(previous?.artifact && !input.artifact
                  ? { artifact: previous.artifact }
                  : {}),
                createdAt: previous?.createdAt ?? now,
                updatedAt: now,
              };
              if (previous) reviewers[reviewers.indexOf(previous)] = next;
              else reviewers.push(next);
            },
            'task.reviewer',
            { sessionId: input.sessionId, state: input.state },
          ),
        access: task.spec.access,
        dependencies: task.spec.dependencies.map((dependency) => ({
          task: this.store.get(dependency)!,
          artifacts: this.store.artifacts(dependency),
        })),
        emit: (type, payload) => this.event(type, payload, this.store.get(id)),
        waiting: (reason) => {
          if (!controller.signal.aborted)
            this.update(id, 'waiting', { reason, runtimeState: 'waiting' });
        },
        running: () => {
          if (!controller.signal.aborted)
            this.update(id, 'running', {
              reason: undefined,
              runtimeState: 'running',
            });
        },
        withResource: (name, action) => {
          if (
            !taskResourceGrants(
              task.spec.allowedResources ?? this.allowedResources,
              this.allowedResources,
            ).includes(name)
          )
            throw new TaskResourceError(`task resource ${name} is not granted`);
          return track(
            this.resources.withResource(name, action, controller.signal),
          );
        },
        runOperation: (operationId, input, action) =>
          track(
            this.runOperation(
              this.store.get(id)!,
              operationId,
              input,
              action,
              controller.signal,
            ),
          ),
        artifact: (path, kind) =>
          track(this.recordArtifact(this.store.get(id)!, path, kind)),
        proposeTasks: (runtimeSessionId, operationId, input) => {
          if (!operationId.trim() || operationId.length > 256)
            throw Error('invalid proposal operation id');
          const tasks = proposedTasks(input);
          return track(
            this.runOperation(
              task,
              `proposal:${operationId}`,
              { runtimeSessionId, tasks } as unknown as Json,
              async () => {
                const current = this.store.get(id);
                if (
                  current?.attempt !== task.attempt ||
                  current.runtimeSessionId !== runtimeSessionId ||
                  !current.spec.sessionId ||
                  !['running', 'waiting'].includes(current.state)
                )
                  throw Error(
                    'proposal does not belong to the active task attempt',
                  );
                const proposal: TaskProposal = {
                  version: 1,
                  source: {
                    taskId: id,
                    attempt: task.attempt,
                    sessionId: current.spec.sessionId,
                    runtimeSessionId,
                    workspace: current.spec.workspace,
                    baseline: current.spec.baseline,
                  },
                  tasks,
                };
                const path = join(
                  artifactDirectory,
                  `proposal-${fingerprint(operationId)}.json`,
                );
                await writeFile(
                  path,
                  JSON.stringify(proposal, null, 2) + '\n',
                  {
                    mode: 0o600,
                    flag: 'wx',
                  },
                );
                const artifact = await this.recordArtifact(
                  current,
                  path,
                  'task-proposal',
                );
                return {
                  artifact,
                  source: proposal.source,
                  taskKeys: tasks.map((task) => task.key),
                } as unknown as Json;
              },
              controller.signal,
            ),
          ) as Promise<unknown> as Promise<TaskProposalReceipt>;
        },
        onCleanup: (cleanup) => {
          cleanups.push(cleanup);
        },
      };
      result = await this.options.executor(this.store.get(id)!, context);
      if (!result || typeof result.passed !== 'boolean')
        throw new Error('executor must return an acceptance result');
      if (!controller.signal.aborted)
        for (const artifact of result.artifacts ?? [])
          await context.artifact(artifact.path, artifact.kind);
    } catch (cause) {
      error = cause;
    }
    for (let offset = 0; offset < ownedActions.length;) {
      const batch = ownedActions.slice(offset);
      offset += batch.length;
      const outcomes = await Promise.allSettled(batch);
      // An executor may intentionally handle a rejected operation as part of acceptance.
      void outcomes;
    }
    const cleanupErrors: unknown[] = [];
    const failedCleanups: (() => void | Promise<void>)[] = [];
    for (const cleanup of cleanups.reverse())
      try {
        await cleanup();
      } catch (cause) {
        cleanupErrors.push(cause);
        failedCleanups.push(cleanup);
      }
    const attempt = this.store.get(id)!.attempt;
    const unresolvedOperations = this.store
      .operations()
      .filter(
        (operation) =>
          operation.kind === 'task' &&
          operation.taskId === id &&
          operation.attempt === attempt &&
          operation.state !== 'succeeded',
      );
    if (cleanupErrors.length) {
      this.failedCleanups.set(id, failedCleanups);
      this.update(id, 'interrupted', {
        reason: `cleanup failed: ${cleanupErrors.map(message).join('; ')}`,
      });
    } else if (controller.signal.aborted)
      this.update(id, 'cancelled', {
        reason: 'cancelled; executor and cleanup settled',
      });
    else if (unresolvedOperations.length)
      this.update(id, 'needs_review', {
        result: result?.result,
        reason: `${unresolvedOperations.length} operation outcome${unresolvedOperations.length === 1 ? '' : 's'} require${unresolvedOperations.length === 1 ? 's' : ''} review; a completion claim cannot verify an unknown side effect`,
      });
    else if (error instanceof TaskResourceError)
      this.update(id, 'needs_review', { reason: message(error) });
    else if (error !== undefined)
      this.update(id, 'failed', { reason: message(error) });
    else
      this.update(
        id,
        result!.verdict === 'needs_review'
          ? 'needs_review'
          : result!.passed
            ? 'succeeded'
            : 'failed',
        {
          result: result!.result,
          reason: result!.reason,
        },
      );
    this.reconcile();
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, 'task cleanup failed');
  }
  private async runOperation<T extends Json>(
    task: TaskRecord,
    id: string,
    input: Json,
    action: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (!id) throw new Error('operationId is required');
    const key = `task:${fingerprint([task.spec.id, task.attempt, id])}`,
      hash = fingerprint(input);
    const previous = this.store.operation(key);
    if (previous?.fingerprint !== undefined && previous.fingerprint !== hash)
      throw new Error('operationId was reused with different input');
    if (previous?.state === 'succeeded') return previous.result as T;
    const pending = this.pendingOperations.get(key);
    if (pending) return pending as Promise<T>;
    if (previous) throw new OperationNeedsReviewError(key);
    if (signal.aborted) throw aborted();
    const record: OperationRecord = {
      id: key,
      kind: 'task',
      fingerprint: hash,
      taskId: task.spec.id,
      attempt: task.attempt,
      state: 'running',
    };
    this.store.putOperation(record);
    const promise = Promise.resolve()
      .then(() => {
        if (signal.aborted) throw aborted();
        return action();
      })
      .then(
        (result) => {
          this.store.putOperation({ ...record, state: 'succeeded', result });
          this.event('operation.succeeded', { operationId: id }, task);
          return result;
        },
        (error) => {
          this.store.putOperation({ ...record, state: 'needs_review' });
          this.event(
            'operation.needs_review',
            { operationId: id, reason: message(error) },
            task,
          );
          throw error;
        },
      )
      .finally(() => this.pendingOperations.delete(key));
    this.pendingOperations.set(key, promise);
    return promise;
  }
  private artifactDirectory(task: TaskRecord): string {
    return taskArtifactDirectory(
      this.options.dataDir,
      task.spec.id,
      task.attempt,
    );
  }
  private async recordArtifact(
    task: TaskRecord,
    path: string,
    kind: string,
  ): Promise<TaskArtifact> {
    const target = await realpath(path);
    if (
      !task.worktree ||
      (!contained(await realpath(task.worktree), target) &&
        !contained(await realpath(this.artifactDirectory(task)), target))
    )
      throw new Error(
        'artifact must belong to the task worktree or its private artifact directory',
      );
    const artifact: TaskArtifact = {
      id: randomUUID(),
      taskId: task.spec.id,
      attempt: task.attempt,
      baseline: task.spec.baseline,
      path: target,
      sha256: createHash('sha256')
        .update(await readFile(target))
        .digest('hex'),
      kind,
      createdAt: Date.now(),
    };
    const event = this.store.transaction(() => {
      this.store.addArtifact(artifact);
      return this.store.event(
        'artifact.created',
        { id: artifact.id, path: artifact.path, sha256: artifact.sha256, kind },
        task,
      );
    });
    this.publish(event);
    return artifact;
  }
  acceptHumanReview(
    id: string,
    options: {
      expectedAttempt: number;
      expectedPatchSha256: string;
      checks: { criterion: string; evidence: string }[];
      result: Json;
      artifact: TaskArtifact;
    },
  ): TaskRecord {
    this.assertOpen();
    const operationId = `human-review:${fingerprint([id, options.expectedAttempt, options.expectedPatchSha256])}`;
    const hash = fingerprint(options.checks);
    const previous = this.store.operation(operationId);
    if (previous) {
      if (previous.fingerprint !== hash)
        throw new Error('human review was repeated with different evidence');
      return this.store.get(id)!;
    }
    const task = this.store.get(id);
    const changes = (
      task?.result as { changes?: { sha256?: string } } | undefined
    )?.changes;
    if (
      !task ||
      task.state !== 'needs_review' ||
      this.active.has(id) ||
      task.attempt !== options.expectedAttempt ||
      changes?.sha256 !== options.expectedPatchSha256
    )
      throw new Error('task review is stale; reload the task and its patch');
    const events: CollaborationEvent[] = [];
    this.store.transaction(() => {
      task.state = 'succeeded';
      task.result = options.result;
      task.reason =
        'all acceptance criteria were explicitly reviewed by a person';
      task.updatedAt = Date.now();
      this.store.put(task);
      this.store.addArtifact(options.artifact);
      this.store.putOperation({
        id: operationId,
        kind: 'human-review',
        fingerprint: hash,
        state: 'succeeded',
        taskId: id,
        attempt: task.attempt,
        result: { reviewer: 'human', patchSha256: options.expectedPatchSha256 },
      });
      events.push(
        this.store.event(
          'artifact.created',
          {
            id: options.artifact.id,
            path: options.artifact.path,
            sha256: options.artifact.sha256,
            kind: options.artifact.kind,
          },
          task,
        ),
      );
      events.push(
        this.store.event(
          'task.reviewed',
          {
            reviewer: 'human',
            patchSha256: options.expectedPatchSha256,
            checks: options.checks,
          },
          task,
        ),
      );
      events.push(
        this.store.event(
          'task.succeeded',
          { state: 'succeeded', reviewer: 'human' },
          task,
        ),
      );
    });
    for (const event of events) this.publish(event);
    this.reconcile();
    this.schedule();
    return task;
  }
  /**
   * A person sent back the attempt they were shown. That attempt fails with
   * their decision as its review, and the task runs again as a new attempt,
   * as a retry runs it, whose worker is told the reason. Tasks that depend on
   * it go back to waiting for the new attempt; none is cancelled or started.
   */
  rejectHumanReview(
    id: string,
    options: {
      decision: TaskSendBack;
      result: Json;
      artifact: TaskArtifact;
      allowedResources?: readonly TaskResource[];
    },
  ): TaskRecord {
    this.assertOpen();
    const { decision } = options;
    const operationId = `human-rejection:${fingerprint([id, decision.expectedAttempt, decision.expectedPatchSha256])}`;
    const hash = fingerprint(decision.reason);
    const previous = this.store.operation(operationId);
    if (previous) {
      if (previous.fingerprint !== hash)
        throw new Error('task was already sent back with a different reason');
      return this.store.get(id)!;
    }
    if (this.failedCleanups.has(id))
      throw new Error('finish task cleanup before retrying');
    const task = this.store.get(id);
    const changes = (
      task?.result as { changes?: { sha256?: string } } | undefined
    )?.changes;
    if (
      !task ||
      task.state !== 'needs_review' ||
      this.active.has(id) ||
      task.attempt !== decision.expectedAttempt ||
      changes?.sha256 !== decision.expectedPatchSha256
    )
      throw new Error('task review is stale; reload the task and its patch');
    const next: TaskRecord = {
      ...this.nextAttempt(task, options.allowedResources),
      sentBack: [...(task.sentBack ?? []), decision],
    };
    const events: CollaborationEvent[] = [];
    this.store.transaction(() => {
      task.state = 'failed';
      task.result = options.result;
      task.reason = 'a person sent this attempt back';
      task.updatedAt = Date.now();
      // Written while it is still the current attempt, then kept as history.
      this.store.put(task);
      this.store.addArtifact(options.artifact);
      this.store.put(next);
      this.store.putOperation({
        id: operationId,
        kind: 'human-rejection',
        fingerprint: hash,
        state: 'succeeded',
        taskId: id,
        attempt: task.attempt,
        result: {
          reviewer: 'human',
          decision: 'rejected',
          patchSha256: decision.expectedPatchSha256,
          nextAttempt: next.attempt,
        },
      });
      events.push(
        this.store.event(
          'artifact.created',
          {
            id: options.artifact.id,
            path: options.artifact.path,
            sha256: options.artifact.sha256,
            kind: options.artifact.kind,
          },
          task,
        ),
        this.store.event(
          'task.reviewed',
          {
            reviewer: 'human',
            decision: 'rejected',
            patchSha256: decision.expectedPatchSha256,
            reason: decision.reason,
          },
          task,
        ),
        this.store.event(
          'task.failed',
          { state: 'failed', reviewer: 'human', reason: task.reason },
          task,
        ),
        this.store.event(
          'task.queued',
          { state: 'queued', retryOf: task.attempt, sentBack: true },
          next,
        ),
      );
    });
    for (const event of events) this.publish(event);
    this.reconcile();
    this.schedule();
    return next;
  }
  hasActiveTask(id: string): boolean {
    const task = this.store.get(id);
    return (
      this.active.has(id) ||
      this.failedCleanups.has(id) ||
      Boolean(task && (!terminal.has(task.state) || task.state === 'blocked'))
    );
  }
  private async settleFailedCleanup(id: string): Promise<void> {
    const callbacks = this.failedCleanups.get(id);
    if (!callbacks) return;
    const remaining: (() => void | Promise<void>)[] = [],
      errors: unknown[] = [];
    for (const callback of callbacks)
      try {
        await callback();
      } catch (error) {
        remaining.push(callback);
        errors.push(error);
      }
    if (remaining.length) this.failedCleanups.set(id, remaining);
    else this.failedCleanups.delete(id);
    if (errors.length)
      throw new AggregateError(errors, 'task cleanup has not completed');
  }
  async cancel(id: string): Promise<TaskRecord> {
    this.assertOpen();
    const task = this.store.get(id);
    if (!task) throw new Error('unknown task');
    const active = this.active.get(id);
    if (active) {
      this.update(id, 'cancelling', { reason: 'waiting for executor cleanup' });
      active.controller.abort();
      this.reconcile();
      await active.done;
    } else if (!terminal.has(task.state) || task.state === 'blocked') {
      this.update(id, 'cancelled', { reason: 'cancelled before execution' });
      this.reconcile();
      this.schedule();
    }
    await this.settleFailedCleanup(id);
    this.checkIdle();
    return this.store.get(id)!;
  }
  retry(
    id: string,
    options: {
      operationId: string;
      allowedResources?: readonly TaskResource[];
    },
  ): TaskRecord {
    this.assertOpen();
    if (!options.operationId) throw new Error('operationId is required');
    const operationId = `retry:${options.operationId}`,
      hash = fingerprint({ id });
    const previous = this.store.operation(operationId);
    if (previous) {
      if (previous.fingerprint !== hash)
        throw new Error('operationId was reused');
      return this.store.get(id)!;
    }
    if (this.failedCleanups.has(id))
      throw new Error('finish task cleanup before retrying');
    const task = this.store.get(id);
    if (
      !task ||
      !['failed', 'cancelled', 'interrupted', 'needs_review'].includes(
        task.state,
      )
    )
      throw new Error('only a settled unsuccessful task can be retried');
    const next = this.nextAttempt(task, options.allowedResources);
    const event = this.store.transaction(() => {
      this.store.put(next);
      this.store.putOperation({
        id: operationId,
        kind: 'retry',
        fingerprint: hash,
        state: 'succeeded',
        result: { id, attempt: next.attempt },
      });
      return this.store.event(
        'task.queued',
        { state: 'queued', retryOf: task.attempt },
        next,
      );
    });
    this.publish(event);
    this.reconcile();
    this.schedule();
    return next;
  }
  /**
   * The next attempt of a settled task, for a retry and for a person's send-back.
   * When it starts, it gets a worktree and branch of its own from the pinned
   * baseline (TaskWorktrees names them by attempt), so it never builds on the
   * previous attempt's changes. The previous attempt keeps its worktree, branch
   * and artifacts, and its record keeps their paths: its patch stays readable
   * and nothing a person was shown is deleted.
   */
  private nextAttempt(
    task: TaskRecord,
    allowedResources?: readonly TaskResource[],
  ): TaskRecord {
    return {
      spec: allowedResources
        ? {
            ...task.spec,
            allowedResources: taskResourceGrants(
              allowedResources,
              this.allowedResources,
            ),
          }
        : task.spec,
      state: 'queued',
      attempt: task.attempt + 1,
      // A fresh start still has to answer what people sent back before.
      ...(task.sentBack?.length ? { sentBack: task.sentBack } : {}),
      createdAt: task.createdAt,
      updatedAt: Date.now(),
    };
  }
  async removeCleanWorktree(id: string): Promise<boolean> {
    this.assertOpen();
    const task = this.store.get(id);
    if (!task || !terminal.has(task.state) || this.active.has(id))
      throw new Error('task must be settled before removing its worktree');
    const removed = await this.trees.removeClean(task);
    if (removed) this.update(id, task.state, { worktree: undefined });
    return removed;
  }
  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }
  private isIdle(): boolean {
    return (
      !this.active.size &&
      !this.store
        .list()
        .some((task) =>
          ['queued', 'preparing', 'running', 'waiting', 'cancelling'].includes(
            task.state,
          ),
        )
    );
  }
  private checkIdle(): void {
    if (this.isIdle()) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.started = false;
    clearInterval(this.leaseBeat);
    this.closePromise = (async () => {
      for (const entry of this.active.values()) entry.controller.abort();
      await Promise.allSettled(
        [...this.active.values()].map((entry) => entry.done),
      );
      const errors: unknown[] = [];
      for (const [id, callbacks] of this.failedCleanups) {
        const remaining: (() => void | Promise<void>)[] = [];
        for (const callback of callbacks)
          try {
            await callback();
          } catch (error) {
            errors.push(error);
            remaining.push(callback);
          }
        if (remaining.length) this.failedCleanups.set(id, remaining);
        else this.failedCleanups.delete(id);
      }
      if (errors.length) {
        this.closePromise = undefined;
        throw new AggregateError(errors, 'task cleanup has not completed');
      }
      this.unsubscribeResources();
      this.listeners.clear();
      this.store.close();
      this.closed = true;
      this.releaseLease();
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    })();
    return this.closePromise;
  }
}
