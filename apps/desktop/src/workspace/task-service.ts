import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import {
  CollaborationScheduler,
  type CollaborationResources,
  DEFAULT_COLLABORATION_LIMITS,
  type CollaborationEvent,
  type CollaborationLimits,
  type TaskRecord,
  type TaskResource,
  type TaskSpec,
} from './collaboration.js';
import {
  createAgentTaskExecutor,
  type AgentTaskExecutorOptions,
} from './task-executor.js';
import { TaskIntegrator } from './task-merge.js';
const exec = promisify(execFile);
const settingsQueues = new Map<string, Promise<unknown>>();
export interface TaskServiceOptions extends AgentTaskExecutorOptions {
  dataDir: string;
  resources?: CollaborationResources;
  settingsPath?: string;
  /** Already granted and trusted by the root controller, never copied from renderer params. */
  workspace: string;
  emit(event: CollaborationEvent): void;
  allowedResources?: string[];
  identity?: { name: string; email: string };
  /** Queued work starts automatically; interrupted attempts are never replayed. */
  autoStart?: boolean;
}
function object(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`invalid ${description}`);
  return value as Record<string, unknown>;
}
function string(value: unknown, description: string, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new Error(`invalid ${description}`);
  return value;
}
function strings(
  value: unknown,
  description: string,
  optional = false,
): string[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error(`invalid ${description}`);
  return value.map((item) => string(item, description, 8192));
}
function limits(
  value: unknown,
  current: CollaborationLimits,
): CollaborationLimits {
  const input = object(value, 'task limits');
  if (
    Object.keys(input).some(
      (key) => !['agents', 'builds', 'ui', 'browsers'].includes(key),
    )
  )
    throw new Error('unknown task concurrency limit');
  const next = { ...current, ...input } as CollaborationLimits;
  for (const [key, count] of Object.entries(next))
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > (key === 'ui' ? 1 : 32)
    )
      throw new Error(`invalid ${key} concurrency`);
  return next;
}
/** Narrow trusted-main adapter. Renderer selects task IDs and intent, never paths or executor code. */
export class TaskService {
  private readonly scheduler: CollaborationScheduler;
  private readonly workspace: string;
  private readonly settingsPath: string;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private integrator?: Promise<TaskIntegrator>;
  private unsubscribe: () => void;
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(private readonly options: TaskServiceOptions) {
    if (!isAbsolute(options.dataDir))
      throw new Error('task service data directory must be absolute');
    this.workspace = realpathSync(options.workspace);
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    if (options.resources && !options.settingsPath)
      throw new Error('shared task resources require a shared settings path');
    if (options.settingsPath && !isAbsolute(options.settingsPath))
      throw new Error('task settings path must be absolute');
    this.settingsPath =
      options.settingsPath ?? join(options.dataDir, 'task-settings.json');
    mkdirSync(dirname(this.settingsPath), { recursive: true, mode: 0o700 });
    let saved: CollaborationLimits = options.resources?.getLimits() ?? {
      ...DEFAULT_COLLABORATION_LIMITS,
    };
    try {
      saved = limits(
        JSON.parse(readFileSync(this.settingsPath, 'utf8')),
        saved,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          `could not load task settings: ${(error as Error).message}`,
        );
    }
    if (options.resources) options.resources.setLimits(saved);
    this.scheduler = new CollaborationScheduler({
      resources: options.resources,
      dataDir: options.dataDir,
      limits: saved,
      executor: createAgentTaskExecutor(options),
    });
    this.unsubscribe = this.scheduler.subscribe((event) => options.emit(event));
    if (options.autoStart !== false) this.scheduler.start();
  }
  hasActiveSession(sessionId: string): boolean {
    return this.scheduler
      .list()
      .some(
        (task) =>
          (task.spec.sessionId === sessionId ||
            task.runtimeSessionId === sessionId) &&
          this.scheduler.hasActiveTask(task.spec.id),
      );
  }
  async cancelSession(sessionId: string): Promise<void> {
    if (this.closing) throw new Error('task service is closing');
    const owned = this.scheduler
      .list()
      .filter(
        (task) =>
          (task.spec.sessionId === sessionId ||
            task.runtimeSessionId === sessionId) &&
          this.scheduler.hasActiveTask(task.spec.id),
      );
    const results = await Promise.allSettled(
      owned.map((task) => this.scheduler.cancel(task.spec.id)),
    );
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(
        errors,
        'session tasks have not completed cleanup',
      );
  }
  getTask(id: string): TaskRecord | undefined {
    return this.scheduler.get(id);
  }
  call(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.closing)
      return Promise.reject(new Error('task service is closing'));
    const pending = Promise.resolve().then(() =>
      this.dispatch(
        string(sessionId, 'session id'),
        method,
        object(params, 'task parameters'),
      ),
    );
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  private task(input: unknown, sessionId: string): TaskSpec {
    const value = object(input, 'task specification');
    const allowed = new Set([
      'id',
      'parentId',
      'baseline',
      'dependencies',
      'access',
      'prompt',
      'acceptanceCriteria',
      'resource',
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
      throw new Error('task specification contains ungranted fields');
    if (value.access !== 'write' && value.access !== 'readonly')
      throw new Error('invalid task access');
    if (
      value.resource !== undefined &&
      !['agent', 'build', 'ui', 'browser'].includes(String(value.resource))
    )
      throw new Error('invalid task resource');
    const acceptanceCriteria = strings(
      value.acceptanceCriteria,
      'acceptance criteria',
    );
    if (!acceptanceCriteria.length)
      throw new Error('acceptance criteria are required');
    return {
      id: string(value.id, 'task id'),
      sessionId,
      workspace: this.workspace,
      access: value.access,
      prompt: string(value.prompt, 'task prompt', 1024 * 1024),
      acceptanceCriteria,
      dependencies: strings(value.dependencies, 'dependencies', true),
      ...(value.parentId !== undefined
        ? { parentId: string(value.parentId, 'parent task id') }
        : {}),
      ...(value.baseline !== undefined
        ? { baseline: string(value.baseline, 'baseline') }
        : {}),
      ...(value.resource !== undefined
        ? { resource: value.resource as TaskResource }
        : {}),
      ...(this.options.allowedResources
        ? { allowedResources: [...this.options.allowedResources] }
        : {}),
    };
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = settingsQueues.get(this.settingsPath) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    settingsQueues.set(this.settingsPath, pending);
    void pending
      .finally(() => {
        if (settingsQueues.get(this.settingsPath) === pending)
          settingsQueues.delete(this.settingsPath);
      })
      .catch(() => {});
    return pending;
  }
  private async dispatch(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.closing) throw new Error('task service is closing');
    if (
      [
        'workspace',
        'dataDir',
        'sessionId',
        'allowedResources',
        'executor',
        'verify',
      ].some((key) => Object.hasOwn(params, key))
    )
      throw new Error('renderer cannot select task authority or storage');
    switch (method) {
      case 'list':
        return this.scheduler.list();
      case 'artifacts':
        return this.scheduler.artifacts(
          params.id === undefined ? undefined : string(params.id, 'task id'),
        );
      case 'enqueue': {
        if (
          !Array.isArray(params.tasks) ||
          !params.tasks.length ||
          params.tasks.length > 1000
        )
          throw new Error('tasks are required');
        const tasks = await this.scheduler.enqueue(
          params.tasks.map((task) => this.task(task, sessionId)),
          { operationId: string(params.operationId, 'operation id') },
        );
        if (this.options.autoStart !== false) this.scheduler.start();
        return tasks;
      }
      case 'start':
        this.scheduler.start();
        return this.scheduler.list();
      case 'cancel':
        return this.scheduler.cancel(string(params.id, 'task id'));
      case 'retry':
        return this.scheduler.retry(string(params.id, 'task id'), {
          operationId: string(params.operationId, 'operation id'),
        });
      case 'events':
        return this.scheduler.eventsAfter(
          params.cursor === undefined ? 0 : (params.cursor as number),
          params.limit === undefined ? 1000 : (params.limit as number),
        );
      case 'settings':
        return this.serial(async () => {
          const current = this.scheduler.getLimits();
          if (params.limits === undefined) return current;
          const next = limits(params.limits, current);
          const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', {
              mode: 0o600,
            });
            await rename(temporary, this.settingsPath);
          } finally {
            await rm(temporary, { force: true });
          }
          this.scheduler.setLimits(next);
          return this.scheduler.getLimits();
        });
      case 'createIntegration':
        return (await this.integration()).create(
          params.baseline === undefined
            ? 'HEAD'
            : string(params.baseline, 'baseline'),
        );
      case 'mergeCandidates': {
        const ids = strings(params.taskIds, 'candidate task ids');
        if (!ids.length || new Set(ids).size !== ids.length)
          throw new Error('unique candidate task ids are required');
        if (
          Object.hasOwn(params, 'tasks') ||
          Object.hasOwn(params, 'patchPath') ||
          Object.hasOwn(params, 'path')
        )
          throw new Error('candidate artifacts must come from the task ledger');
        const tasks = ids.map((id) => {
          const task = this.scheduler.get(id);
          if (!task) throw new Error(`unknown task ${id}`);
          return task;
        });
        return (await this.integration()).mergeCandidates(
          string(params.integrationId, 'integration id'),
          tasks,
          {
            expectedHead: string(
              params.expectedHead,
              'expected integration commit',
            ),
            signal: this.lifetime.signal,
          },
        );
      }
      default:
        throw new Error('unknown task operation');
    }
  }
  private integration(): Promise<TaskIntegrator> {
    this.integrator ??= (async () => {
      let identity = this.options.identity;
      if (!identity) {
        try {
          const name = (
            await exec(
              'git',
              ['-C', this.workspace, 'config', '--get', 'user.name'],
              { encoding: 'utf8' },
            )
          ).stdout.trim();
          const email = (
            await exec(
              'git',
              ['-C', this.workspace, 'config', '--get', 'user.email'],
              { encoding: 'utf8' },
            )
          ).stdout.trim();
          identity = { name, email };
        } catch {
          throw new Error(
            'set Git author name and email before integrating tasks',
          );
        }
      }
      return new TaskIntegrator({
        workspace: this.workspace,
        dataDir: this.options.dataDir,
        identity,
      });
    })().catch((error) => {
      this.integrator = undefined;
      throw error;
    });
    return this.integrator;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.lifetime.abort();
    this.closePromise = (async () => {
      const stopping = this.scheduler.close();
      void stopping.catch(() => {});
      await Promise.allSettled([...this.pending]);
      try {
        await stopping;
      } catch (error) {
        this.closePromise = undefined;
        throw error;
      }
      this.unsubscribe();
    })();
    return this.closePromise;
  }
}
