import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import {
  mkdtemp,
  readFile,
  realpath,
  stat,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import {
  CollaborationScheduler,
  type CollaborationResources,
  DEFAULT_COLLABORATION_LIMITS,
  type CollaborationEvent,
  type CollaborationLimits,
  type TaskRecord,
  type Json,
  type TaskArtifact,
  type TaskResource,
  type TaskSendBack,
  type TaskSpec,
} from './collaboration.js';
import {
  createAgentTaskExecutor,
  captureTaskChanges,
  type TaskChanges,
  type AgentTaskExecutorOptions,
} from './task-executor.js';
import { TaskIntegrator } from './task-merge.js';
import {
  taskArtifactDirectory,
  proposedTasks,
  TASK_RESOURCES,
  taskResourceGrants,
} from './task-store.js';
const exec = promisify(execFile);
const settingsQueues = new Map<string, Promise<unknown>>();
export interface TaskServiceOptions extends AgentTaskExecutorOptions {
  dataDir: string;
  resources?: CollaborationResources;
  settingsPath?: string;
  /** Already granted and trusted by the root controller, never copied from renderer params. */
  workspace: string;
  emit(event: CollaborationEvent): void;
  allowedResources?: readonly TaskResource[];
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
/** Read app limits without opening a scheduler or replaying any task ledger. */
export function readTaskLimits(
  settingsPath: string,
  current: CollaborationLimits = { ...DEFAULT_COLLABORATION_LIMITS },
): CollaborationLimits {
  try {
    return limits(JSON.parse(readFileSync(settingsPath, 'utf8')), current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(
        `could not load task settings: ${(error as Error).message}`,
      );
    return { ...current };
  }
}
/** A start confirmation is tied to the granted directory identity, never just its name. */
export interface TaskSettingsWorkspace {
  canonical: string;
  dev: number;
  ino: number;
}
/** An absent checkpoint is the normal automatic-start policy. A present one requires explicit starts. */
export function readTaskSettingsRecovery(
  path: string,
): TaskSettingsWorkspace[] | undefined {
  try {
    const saved = object(
      JSON.parse(readFileSync(path, 'utf8')),
      'task settings recovery',
    );
    if (
      saved.version !== 1 ||
      !Array.isArray(saved.startedWorkspaces) ||
      Object.keys(saved).some(
        (key) => !['version', 'startedWorkspaces'].includes(key),
      )
    )
      throw Error('invalid task settings recovery');
    const seen = new Set<string>();
    return saved.startedWorkspaces.map((value) => {
      const row = object(value, 'task settings workspace');
      if (
        Object.keys(row).some(
          (key) => !['canonical', 'dev', 'ino'].includes(key),
        ) ||
        typeof row.canonical !== 'string' ||
        !isAbsolute(row.canonical) ||
        seen.has(row.canonical) ||
        typeof row.dev !== 'number' ||
        !Number.isInteger(row.dev) ||
        row.dev < 0 ||
        typeof row.ino !== 'number' ||
        !Number.isInteger(row.ino) ||
        row.ino < 0
      )
        throw Error('invalid task settings workspace');
      seen.add(row.canonical);
      return { canonical: row.canonical, dev: row.dev, ino: row.ino };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw Error(
      `could not load task settings recovery: ${(error as Error).message}`,
    );
  }
}
function serialTaskSettings<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = settingsQueues.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(action);
  settingsQueues.set(path, pending);
  void pending
    .finally(() => {
      if (settingsQueues.get(path) === pending) settingsQueues.delete(path);
    })
    .catch(() => {});
  return pending;
}
/** Explicit app settings repair uses the same validation and atomic write as an open task service. */
export function writeTaskLimits(
  path: string,
  value: unknown,
  current: () => CollaborationLimits,
  apply: (next: CollaborationLimits) => void,
  beforeWrite?: () => void | Promise<void>,
): Promise<CollaborationLimits> {
  return serialTaskSettings(path, async () => {
    const next = limits(value, current());
    // Validate first, then make an exceptional recovery gate durable before repairing limits.
    await beforeWrite?.();
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', {
        mode: 0o600,
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    apply(next);
    return next;
  });
}
/** Narrow trusted-main adapter. Renderer selects task IDs and intent, never paths or executor code. */
export class TaskService {
  private readonly scheduler: CollaborationScheduler;
  private readonly workspace: string;
  private readonly canonicalWorkspace: string;
  private readonly canonicalDataDir: string;
  private readonly settingsPath: string;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly records = new Map<string, TaskRecord>();
  private readonly lifetime = new AbortController();
  private integrator?: Promise<TaskIntegrator>;
  private unsubscribe: () => void;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  constructor(private readonly options: TaskServiceOptions) {
    if (!isAbsolute(options.dataDir))
      throw new Error('task service data directory must be absolute');
    this.workspace = realpathSync(options.workspace);
    this.canonicalWorkspace = realpathSync.native(options.workspace);
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.canonicalDataDir = realpathSync.native(options.dataDir);
    if (options.resources && !options.settingsPath)
      throw new Error('shared task resources require a shared settings path');
    if (options.settingsPath && !isAbsolute(options.settingsPath))
      throw new Error('task settings path must be absolute');
    this.settingsPath =
      options.settingsPath ?? join(options.dataDir, 'task-settings.json');
    mkdirSync(dirname(this.settingsPath), { recursive: true, mode: 0o700 });
    const saved = readTaskLimits(
      this.settingsPath,
      options.resources?.getLimits(),
    );
    if (options.resources) options.resources.setLimits(saved);
    this.scheduler = new CollaborationScheduler({
      resources: options.resources,
      dataDir: options.dataDir,
      limits: saved,
      executor: createAgentTaskExecutor(options),
      allowedResources: taskResourceGrants(
        options.allowedResources ?? TASK_RESOURCES,
      ),
    });
    for (const task of this.scheduler.list())
      for (const attempt of this.scheduler.attempts(task.spec.id))
        this.records.set(`${attempt.spec.id}:${attempt.attempt}`, attempt);
    this.unsubscribe = this.scheduler.subscribe((event) => {
      if (event.taskId) {
        const task =
          event.attempt === undefined
            ? this.scheduler.get(event.taskId)
            : this.scheduler
                .attempts(event.taskId)
                .find((record) => record.attempt === event.attempt);
        if (task) this.records.set(`${task.spec.id}:${task.attempt}`, task);
      }
      options.emit(event);
    });
    if (options.autoStart !== false) this.scheduler.start();
  }
  private ownedSessionIds(sessionId: string): Set<string> {
    const sessions = new Set<string>([sessionId]);
    let changed: boolean;
    do {
      changed = false;
      for (const task of this.records.values()) {
        const ids = [
          task.runtimeSessionId,
          ...(task.reviewers ?? []).map((reviewer) => reviewer.sessionId),
        ].filter((id): id is string => !!id);
        if (
          sessions.has(task.spec.sessionId ?? '') ||
          ids.some((id) => sessions.has(id))
        )
          for (const id of ids)
            if (!sessions.has(id)) {
              sessions.add(id);
              changed = true;
            }
      }
    } while (changed);
    return sessions;
  }
  ownedRuntimeSessions(
    sessionId: string,
  ): { sessionId: string; worktree?: string }[] {
    const owned = this.ownedSessionIds(sessionId),
      sessions = new Map<string, { sessionId: string; worktree?: string }>();
    for (const task of this.records.values())
      for (const source of [
        { sessionId: task.runtimeSessionId, worktree: task.worktree },
        ...(task.reviewers ?? []).map((reviewer) => ({
          sessionId: reviewer.sessionId,
          worktree: reviewer.workspace,
        })),
      ])
        if (source.sessionId && owned.has(source.sessionId))
          sessions.set(source.sessionId, {
            sessionId: source.sessionId,
            ...(source.worktree ? { worktree: source.worktree } : {}),
          });
    return [...sessions.values()];
  }
  hasActiveSession(sessionId: string): boolean {
    if (this.closed) return false;
    const owned = this.ownedSessionIds(sessionId);
    return this.scheduler
      .list()
      .some(
        (task) =>
          (owned.has(task.spec.sessionId ?? '') ||
            owned.has(task.runtimeSessionId ?? '')) &&
          this.scheduler.hasActiveTask(task.spec.id),
      );
  }
  async cancelSession(sessionId: string): Promise<void> {
    if (this.closing) {
      await this.close();
      return;
    }
    const sessions = this.ownedSessionIds(sessionId);
    const owned = this.scheduler
      .list()
      .filter(
        (task) =>
          (sessions.has(task.spec.sessionId ?? '') ||
            sessions.has(task.runtimeSessionId ?? '')) &&
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
    if (this.closed) return undefined;
    return this.scheduler.get(id);
  }
  /** Trusted projection only. A parent's records never include a different owner. */
  taskAttempts(ownerSessionId: string): readonly TaskRecord[] {
    string(ownerSessionId, 'owner session id');
    const records = structuredClone(
      [...this.records.values()].filter(
        (task) =>
          task.spec.sessionId === ownerSessionId &&
          task.spec.workspace === this.canonicalWorkspace,
      ),
    );
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    };
    freeze(records);
    return records;
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
      allowedResources: taskResourceGrants(
        this.options.allowedResources ?? TASK_RESOURCES,
      ),
    };
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    return serialTaskSettings(this.settingsPath, action);
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
      case 'adoptProposal':
        return this.adoptProposal(sessionId, params);
      case 'start':
        this.scheduler.start();
        return this.scheduler.list();
      case 'cancel':
        return this.scheduler.cancel(string(params.id, 'task id'));
      case 'retry':
        return this.scheduler.retry(string(params.id, 'task id'), {
          operationId: string(params.operationId, 'operation id'),
          allowedResources: taskResourceGrants(
            this.options.allowedResources ?? TASK_RESOURCES,
          ),
        });
      case 'events':
        return this.scheduler.eventsAfter(
          params.cursor === undefined ? 0 : (params.cursor as number),
          params.limit === undefined ? 1000 : (params.limit as number),
        );
      case 'readArtifact':
        return this.readArtifact(params);
      case 'review':
        return this.serial(() => this.review(params));
      case 'reject':
        return this.serial(() => this.reject(params));
      case 'settings':
        if (params.limits === undefined)
          return this.serial(async () => this.scheduler.getLimits());
        return writeTaskLimits(
          this.settingsPath,
          params.limits,
          () => this.scheduler.getLimits(),
          (next) => this.scheduler.setLimits(next),
        );
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
            ...(params.expectedBaseline === undefined
              ? {}
              : {
                  expectedBaseline: string(
                    params.expectedBaseline,
                    'expected candidate baseline',
                  ),
                }),
            signal: this.lifetime.signal,
          },
        );
      }
      default:
        throw new Error('unknown task operation');
    }
  }
  private async adoptProposal(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<TaskRecord[]> {
    if (
      Object.keys(params).some(
        (key) =>
          ![
            'operationId',
            'artifactId',
            'expectedSha256',
            'expectedAttempt',
            'keys',
          ].includes(key),
      )
    )
      throw Error('proposal adoption cannot select task authority');
    const operationId = string(params.operationId, 'operation id'),
      artifactId = string(params.artifactId, 'proposal artifact id'),
      expectedSha256 = string(params.expectedSha256, 'proposal hash'),
      expectedAttempt = params.expectedAttempt;
    if (
      !/^[0-9a-f]{64}$/.test(expectedSha256) ||
      !Number.isSafeInteger(expectedAttempt) ||
      Number(expectedAttempt) < 1
    )
      throw Error('invalid proposal version');
    const artifact = this.scheduler
      .artifacts()
      .find((entry) => entry.id === artifactId);
    if (
      !artifact ||
      artifact.kind !== 'task-proposal' ||
      artifact.sha256 !== expectedSha256
    )
      throw Error('unknown or changed task proposal');
    const source = this.scheduler.get(artifact.taskId);
    const canonicalWorkspace = this.canonicalWorkspace;
    const assertSource = () => {
      const current = this.scheduler.get(artifact.taskId);
      if (
        !current ||
        current.spec.sessionId !== sessionId ||
        current.spec.workspace !== canonicalWorkspace ||
        current.attempt !== expectedAttempt ||
        current.attempt !== artifact.attempt ||
        current.spec.baseline !== artifact.baseline ||
        current.runtimeSessionId !== source?.runtimeSessionId ||
        !current.runtimeSessionId ||
        current.runtimeState !== 'succeeded' ||
        current.state !== 'succeeded'
      )
        throw Error(
          'proposal source is foreign, stale or not independently accepted',
        );
    };
    assertSource();
    const shown = await this.readArtifact({
      id: artifact.taskId,
      artifactId,
      limit: 1024 * 1024,
    });
    if (shown.truncated) throw Error('task proposal is too large');
    const proposal = object(JSON.parse(shown.content), 'task proposal');
    const origin = object(proposal.source, 'proposal source');
    if (
      proposal.version !== 1 ||
      Object.keys(proposal).some(
        (key) => !['version', 'source', 'tasks'].includes(key),
      ) ||
      JSON.stringify(Object.keys(origin).sort()) !==
        JSON.stringify(
          [
            'taskId',
            'attempt',
            'sessionId',
            'runtimeSessionId',
            'workspace',
            'baseline',
          ].sort(),
        ) ||
      origin.taskId !== source!.spec.id ||
      origin.attempt !== source!.attempt ||
      origin.sessionId !== sessionId ||
      origin.runtimeSessionId !== source!.runtimeSessionId ||
      origin.workspace !== canonicalWorkspace ||
      origin.baseline !== source!.spec.baseline
    )
      throw Error('task proposal provenance does not match its ledger');
    const tasks = proposedTasks(proposal.tasks);
    // The executor's independent acceptance artifact must include this exact proposal.
    // A worker's final answer or a later human override cannot substitute for it.
    const acceptance = this.scheduler
      .artifacts(source!.spec.id)
      .find(
        (entry) =>
          entry.kind === 'acceptance' &&
          entry.attempt === source!.attempt &&
          entry.baseline === source!.spec.baseline,
      );
    if (!acceptance)
      throw Error('proposal has no independent acceptance artifact');
    const accepted = await this.readArtifact({
      id: source!.spec.id,
      artifactId: acceptance.id,
      limit: 1024 * 1024,
    });
    if (accepted.truncated) throw Error('proposal acceptance is too large');
    const report = object(JSON.parse(accepted.content), 'proposal acceptance');
    if (
      report.taskId !== source!.spec.id ||
      report.attempt !== source!.attempt ||
      report.sessionId !== source!.runtimeSessionId ||
      report.verdict !== 'passed' ||
      !Array.isArray(report.proposals) ||
      !report.proposals.includes(artifactId) ||
      !Array.isArray(report.checks) ||
      !source!.spec.acceptanceCriteria.every((criterion) =>
        (report.checks as unknown[]).some((input) => {
          const check = object(input, 'proposal acceptance check');
          return (
            check.criterion === criterion &&
            check.status === 'passed' &&
            typeof check.evidence === 'string' &&
            Boolean(check.evidence.trim()) &&
            ['inspection', 'independent-review', 'command'].includes(
              String(check.source),
            ) &&
            (check.source !== 'command' ||
              (typeof check.command === 'string' &&
                Boolean(check.command.trim()) &&
                check.exitCode === 0))
          );
        }),
      )
    )
      throw Error('proposal has not passed independent acceptance');
    const changes = object(report.changes, 'accepted proposal changes');
    if (
      changes.baseline !== source!.spec.baseline ||
      typeof changes.sha256 !== 'string' ||
      !this.scheduler
        .artifacts(source!.spec.id)
        .some(
          (entry) =>
            entry.kind === 'task-patch' &&
            entry.attempt === source!.attempt &&
            entry.baseline === source!.spec.baseline &&
            entry.sha256 === changes.sha256,
        )
    )
      throw Error('proposal acceptance has no matching candidate patch');
    const keys =
      params.keys === undefined
        ? tasks.map((task) => task.key)
        : strings(params.keys, 'proposed task keys');
    const selected = new Set(keys);
    if (
      !selected.size ||
      selected.size !== keys.length ||
      keys.some((key) => !tasks.some((task) => task.key === key))
    )
      throw Error('invalid proposed task selection');
    const chosen = tasks.filter((task) => selected.has(task.key));
    if (
      chosen.some((task) => task.dependencies.some((key) => !selected.has(key)))
    )
      throw Error('proposal selection omits a required dependency');
    const idFor = (key: string) =>
      `proposal-${createHash('sha256')
        .update(JSON.stringify([artifact.id, artifact.sha256, key]))
        .digest('hex')
        .slice(0, 32)}`;
    const created = await this.scheduler.enqueue(
      chosen.map((task) =>
        this.task(
          {
            id: idFor(task.key),
            parentId: source!.spec.id,
            baseline: source!.spec.baseline,
            prompt: task.prompt,
            access: task.access,
            acceptanceCriteria: task.acceptanceCriteria,
            dependencies: [source!.spec.id, ...task.dependencies.map(idFor)],
            ...(task.resource ? { resource: task.resource } : {}),
          },
          sessionId,
        ),
      ),
      {
        operationId: `adopt:${sessionId}:${operationId}`,
        beforeCommit: assertSource,
      },
    );
    if (this.options.autoStart !== false) this.scheduler.start();
    return created;
  }
  private async readArtifact(params: Record<string, unknown>) {
    if (Object.hasOwn(params, 'path') || Object.hasOwn(params, 'patchPath'))
      throw new Error('renderer cannot select artifact paths');
    const id = string(params.id, 'task id'),
      artifactId = string(params.artifactId, 'artifact id');
    const task = this.scheduler.get(id);
    if (!task) throw new Error('unknown task');
    const artifact = this.scheduler
      .artifacts(id)
      .find((entry) => entry.id === artifactId);
    if (!artifact) throw new Error('artifact does not belong to this task');
    const attempt = this.scheduler
      .attempts(id)
      .find((entry) => entry.attempt === artifact.attempt);
    if (!attempt) throw new Error('artifact attempt is missing');
    const target = await realpath(artifact.path),
      roots: string[] = [];
    for (const root of [
      attempt.worktree,
      taskArtifactDirectory(this.options.dataDir, id, artifact.attempt),
    ])
      if (root)
        try {
          const withinData = relative(this.options.dataDir, root);
          const expected =
            !isAbsolute(withinData) &&
            withinData !== '..' &&
            !withinData.startsWith('../') &&
            !withinData.startsWith('..\\')
              ? join(this.canonicalDataDir, withinData)
              : relative(this.workspace, root) === ''
                ? this.canonicalWorkspace
                : root;
          const current = await realpath(root);
          // A replaced resource directory must not redefine the boundary. Resolve
          // the configured data-directory alias once, before any task can run.
          if (relative(expected, current) === '') roots.push(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    if (
      !roots.some((root) => {
        const path = relative(root, target);
        return (
          path === '' ||
          (!isAbsolute(path) &&
            path !== '..' &&
            !path.startsWith('../') &&
            !path.startsWith('..\\'))
        );
      })
    )
      throw new Error('artifact is outside its owned task resources');
    const info = await stat(target);
    if (!info.isFile() || info.size > 64 * 1024 * 1024)
      throw new Error('artifact is not a supported text file');
    const bytes = await readFile(target);
    if (bytes.length > 64 * 1024 * 1024)
      throw new Error('artifact is too large');
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw new Error('artifact changed after it was recorded');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('artifact is not UTF-8 text');
    }
    const offset = params.offset === undefined ? 0 : (params.offset as number),
      limit =
        params.limit === undefined ? 256 * 1024 : (params.limit as number);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > content.length ||
      !Number.isSafeInteger(limit) ||
      limit < 2 ||
      limit > 1024 * 1024
    )
      throw new Error('invalid artifact page');
    const low = (value: number) => value >= 0xdc00 && value <= 0xdfff,
      high = (value: number) => value >= 0xd800 && value <= 0xdbff;
    if (
      offset &&
      low(content.charCodeAt(offset)) &&
      high(content.charCodeAt(offset - 1))
    )
      throw new Error('artifact offset splits a character; use nextOffset');
    let end = Math.min(content.length, offset + limit);
    if (
      end < content.length &&
      high(content.charCodeAt(end - 1)) &&
      low(content.charCodeAt(end))
    )
      end--;
    const truncated = end < content.length;
    return {
      id: artifact.id,
      kind: artifact.kind,
      sha256: artifact.sha256,
      content: content.slice(offset, end),
      offset,
      ...(truncated ? { nextOffset: end } : {}),
      truncated,
      totalCharacters: content.length,
      byteLength: bytes.length,
    };
  }
  /** The task attempt and candidate patch a person was shown when they decided. */
  private reviewVersion(params: Record<string, unknown>): {
    id: string;
    expectedAttempt: number;
    expectedPatchSha256: string;
  } {
    const id = string(params.id, 'task id'),
      expectedPatchSha256 = string(
        params.expectedPatchSha256,
        'expected patch hash',
      );
    const expectedAttempt = params.expectedAttempt;
    if (
      !Number.isSafeInteger(expectedAttempt) ||
      Number(expectedAttempt) < 1 ||
      !/^[0-9a-f]{64}$/.test(expectedPatchSha256)
    )
      throw new Error('invalid task review version');
    return {
      id,
      expectedAttempt: Number(expectedAttempt),
      expectedPatchSha256,
    };
  }
  /** The shown attempt's changes, once its patch file and its worktree still match what was shown. */
  private async displayedChanges(
    task: TaskRecord,
    expectedAttempt: number,
    expectedPatchSha256: string,
  ): Promise<TaskChanges> {
    const changes = (task.result as { changes?: TaskChanges } | undefined)
      ?.changes;
    if (
      task.state !== 'needs_review' ||
      task.attempt !== expectedAttempt ||
      changes?.sha256 !== expectedPatchSha256 ||
      !task.worktree
    )
      throw new Error('task review is stale; reload the task and its patch');
    const acceptedPatch = await readFile(changes.patchPath);
    if (
      createHash('sha256').update(acceptedPatch).digest('hex') !==
      expectedPatchSha256
    )
      throw new Error('task patch changed after it was displayed');
    const temporary = await mkdtemp(
      join(dirname(changes.patchPath), 'review-'),
    );
    try {
      const current = await captureTaskChanges(task, task.worktree, temporary);
      if (
        current.head !== changes.head ||
        current.sha256 !== expectedPatchSha256
      )
        throw new Error('task worktree changed after its patch was displayed');
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return changes;
  }
  /** A person's decision, kept as an artifact of the attempt it was about. */
  private async reviewArtifact(
    task: TaskRecord,
    changes: TaskChanges,
    decision: unknown,
  ): Promise<TaskArtifact> {
    const path = join(
        dirname(changes.patchPath),
        `human-review-${randomUUID()}.json`,
      ),
      body = JSON.stringify(decision, null, 2) + '\n';
    await writeFile(path, body, { mode: 0o600 });
    return {
      id: randomUUID(),
      taskId: task.spec.id,
      attempt: task.attempt,
      baseline: task.spec.baseline,
      path,
      sha256: createHash('sha256').update(body).digest('hex'),
      kind: 'human-review',
      createdAt: Date.now(),
    };
  }
  private async review(params: Record<string, unknown>): Promise<TaskRecord> {
    const { id, expectedAttempt, expectedPatchSha256 } =
      this.reviewVersion(params);
    const task = this.scheduler.get(id);
    if (!task) throw new Error('unknown task');
    if (!Array.isArray(params.checks) || params.checks.length > 1000)
      throw new Error('explicit acceptance evidence is required');
    const checks = params.checks
      .map((input) => {
        const value = object(input, 'acceptance evidence');
        return {
          criterion: string(value.criterion, 'acceptance criterion', 8192),
          evidence: string(value.evidence, 'acceptance evidence', 8192),
        };
      })
      .sort((a, b) =>
        a.criterion < b.criterion ? -1 : a.criterion > b.criterion ? 1 : 0,
      );
    if (
      new Set(checks.map((check) => check.criterion)).size !== checks.length ||
      checks.some(
        (check) => !task.spec.acceptanceCriteria.includes(check.criterion),
      ) ||
      !task.spec.acceptanceCriteria.every((criterion) =>
        checks.some((check) => check.criterion === criterion),
      )
    )
      throw new Error(
        'each acceptance criterion requires explicit human evidence',
      );
    const previous = task.result as
      | {
          verdict?: string;
          changes?: TaskChanges;
          checks?: Json[];
          review?: {
            reviewer?: string;
            expectedAttempt?: number;
            expectedPatchSha256?: string;
            checks?: typeof checks;
          };
        }
      | undefined;
    if (
      task.state === 'succeeded' &&
      previous?.review?.reviewer === 'human' &&
      previous.review.expectedAttempt === expectedAttempt &&
      previous.review.expectedPatchSha256 === expectedPatchSha256 &&
      JSON.stringify(previous.review.checks) === JSON.stringify(checks)
    )
      return task;
    const changes = await this.displayedChanges(
      task,
      expectedAttempt,
      expectedPatchSha256,
    );
    const reviewed = {
      reviewer: 'human',
      at: Date.now(),
      expectedAttempt,
      expectedPatchSha256,
      head: changes.head,
      checks,
    };
    const artifact = await this.reviewArtifact(task, changes, reviewed);
    const result = {
      ...previous,
      verdict: 'passed',
      reason: 'all acceptance criteria were explicitly reviewed by a person',
      review: reviewed,
      checks: [
        ...(previous?.checks ?? []),
        ...checks.map((check) => ({
          ...check,
          status: 'passed',
          source: 'independent-review',
          reviewer: 'human',
        })),
      ],
    };
    return this.scheduler.acceptHumanReview(id, {
      expectedAttempt,
      expectedPatchSha256,
      checks,
      result: result as unknown as Json,
      artifact,
    });
  }
  /**
   * A person sends the shown attempt back with a reason, under the same checks
   * as a passing review. The task runs again as a new attempt, as a retry
   * runs it, and that attempt's worker is told the reason.
   */
  private async reject(params: Record<string, unknown>): Promise<TaskRecord> {
    const { id, expectedAttempt, expectedPatchSha256 } =
      this.reviewVersion(params);
    const reason = string(
      params.reason,
      'reason for sending the task back',
      8192,
    ).trim();
    const task = this.scheduler.get(id);
    if (!task) throw new Error('unknown task');
    // The same decision again, after it took effect, starts no other attempt.
    const sent = (
      this.scheduler
        .attempts(id)
        .find((record) => record.attempt === expectedAttempt)?.result as
        { review?: Partial<TaskSendBack> } | undefined
    )?.review;
    if (
      sent?.reviewer === 'human' &&
      sent.decision === 'rejected' &&
      sent.expectedPatchSha256 === expectedPatchSha256 &&
      sent.reason === reason
    )
      return task;
    const changes = await this.displayedChanges(
      task,
      expectedAttempt,
      expectedPatchSha256,
    );
    const decision: TaskSendBack = {
      reviewer: 'human',
      decision: 'rejected',
      expectedAttempt,
      expectedPatchSha256,
      head: changes.head,
      reason,
      at: Date.now(),
    };
    const artifact = await this.reviewArtifact(task, changes, decision);
    return this.scheduler.rejectHumanReview(id, {
      decision,
      result: {
        ...(task.result as Record<string, Json>),
        verdict: 'failed',
        reason: 'a person sent this attempt back',
        review: decision as unknown as Json,
      },
      artifact,
      allowedResources: taskResourceGrants(
        this.options.allowedResources ?? TASK_RESOURCES,
      ),
    });
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
      this.closed = true;
    })();
    return this.closePromise;
  }
}
