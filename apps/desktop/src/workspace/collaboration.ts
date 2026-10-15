import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
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
} from './task-store.js';
import { resolveTaskBaseline, TaskWorktrees } from './task-worktrees.js';
export type {
  CollaborationEvent,
  Json,
  TaskArtifact,
  TaskRecord,
  TaskResource,
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
  bindRuntimeSession(sessionId: string): void;
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
/** One instance per app worker; every authorized workspace shares these limits. */
export class CollaborationResources {
  readonly pools: Record<TaskResource, ResourcePool>;
  private readonly ownership = new AsyncLocalStorage<Set<TaskResource>>();
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
  /** @internal The scheduler already owns these leases before starting an executor. */
  runWithHeldResources<T>(resources: TaskResource[], action: () => T): T {
    return this.ownership.run(
      new Set([...(this.ownership.getStore() ?? []), ...resources]),
      action,
    );
  }
  async withResource<T>(
    resource: TaskResource,
    action: () => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.ownership.getStore()?.has(resource)) return action();
    const release = await this.pools[resource].acquire(signal);
    try {
      return await this.runWithHeldResources([resource], async () => {
        signal.throwIfAborted();
        return action();
      });
    } finally {
      release();
    }
  }
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
  private limits: CollaborationLimits;
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
      for (const task of this.store.list())
        if (
          ['preparing', 'running', 'waiting', 'cancelling'].includes(task.state)
        ) {
          task.state = 'interrupted';
          task.reason =
            'previous process ended; review effects before retrying';
          task.updatedAt = Date.now();
          this.store.put(task);
          this.store.event('task.interrupted', { reason: task.reason }, task);
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
          writeFileSync(
            descriptor,
            JSON.stringify({ pid: process.pid, token: this.leaseToken }),
          );
        } finally {
          closeSync(descriptor);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let owner: { pid?: unknown };
        try {
          owner = JSON.parse(readFileSync(this.leasePath, 'utf8'));
        } catch {
          throw new Error(
            'collaboration lease is unreadable; review it before opening',
          );
        }
        if (
          typeof owner.pid !== 'number' ||
          !Number.isSafeInteger(owner.pid) ||
          owner.pid < 1
        )
          throw new Error('invalid collaboration lease');
        try {
          process.kill(owner.pid, 0);
          throw new Error('collaboration scheduler is already open');
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
        }
        unlinkSync(this.leasePath);
      }
    }
    throw new Error('could not acquire collaboration lease');
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
  async enqueue(
    specs: TaskSpec[],
    options: { operationId: string },
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
          dependencies: [...new Set(input.dependencies ?? [])],
        };
      }),
    );
    this.assertOpen();
    const now = Date.now();
    const events: CollaborationEvent[] = [];
    const tasks = this.store.transaction(() => {
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
    if (!this.started || this.closing || this.closed || this.pumping) return;
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
              this.execute(task.spec.id, controller, resource),
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
      const prepared = await this.trees.prepare(task);
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
        bindRuntimeSession: (sessionId) => {
          if (!sessionId.trim())
            throw new Error('runtime session id is required');
          const current = this.store.get(id)!;
          this.update(id, current.state, { runtimeSessionId: sessionId });
          this.event(
            'task.session',
            { runtimeSessionId: sessionId },
            this.store.get(id),
          );
        },
        access: task.spec.access,
        dependencies: task.spec.dependencies.map((dependency) => ({
          task: this.store.get(dependency)!,
          artifacts: this.store.artifacts(dependency),
        })),
        emit: (type, payload) => this.event(type, payload, this.store.get(id)),
        waiting: (reason) => {
          if (!controller.signal.aborted)
            this.update(id, 'waiting', { reason });
        },
        running: () => {
          if (!controller.signal.aborted)
            this.update(id, 'running', { reason: undefined });
        },
        withResource: (name, action) =>
          track(this.resources.withResource(name, action, controller.signal)),
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
  retry(id: string, options: { operationId: string }): TaskRecord {
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
    const next: TaskRecord = {
      spec: task.spec,
      state: 'queued',
      attempt: task.attempt + 1,
      createdAt: task.createdAt,
      updatedAt: Date.now(),
    };
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
