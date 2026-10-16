import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import type { TaskRecord } from './collaboration.js';
import type { CyclePorts, CycleRecord, CycleCheck } from './delivery-cycle.js';
import { DeliveryService } from './delivery.js';
import { GitWorkspaceService, type GitSnapshot } from './git.js';
import { cycleRepositoryIdentity } from './cycle-repository-identity.js';
import {
  captureTaskChanges,
  type TaskVerificationCheck,
  type TaskVerificationContext,
} from './task-executor.js';
import type {
  IntegrationWorkspace,
  MergeCandidatesResult,
} from './task-merge.js';
import type { TaskService } from './task-service.js';

export interface WorkspaceCyclePortsOptions {
  /** Granted source repository. It is never staged, committed or checked out. */
  workspace: string;
  dataDir: string;
  sessionId: string;
  getTaskService(): TaskService | Promise<TaskService>;
  verify(
    task: TaskRecord,
    context: TaskVerificationContext,
  ): Promise<TaskVerificationCheck[]>;
  withResource: TaskVerificationContext['withResource'];
  createGit?: (ownedWorkspace: string) => GitWorkspaceService;
  createDelivery?: (ownedWorkspace: string) => DeliveryService;
  identity: { name: string; email: string };
  signal?: AbortSignal;
  redact?: (text: string) => string;
}
interface Round {
  operationId: string;
  baseline: string;
  taskIds: string[];
  kind: 'implementation' | 'repair' | 'diagnosis';
}
interface Ownership {
  version: 1;
  cycleId: string;
  sessionId: string;
  specification: string;
  source: string;
  integration: IntegrationWorkspace;
  branch: string;
  rounds: Round[];
}
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const specification = (cycle: CycleRecord) =>
  hash({
    id: cycle.id,
    title: cycle.title,
    body: cycle.body,
    acceptanceCriteria: cycle.acceptanceCriteria,
  });
function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === '' ||
    (!isAbsolute(child) &&
      child !== '..' &&
      !child.startsWith('../') &&
      !child.startsWith('..\\'))
  );
}
/** Trusted-main adapters for the durable cycle runner. Renderer paths never choose an integration repository. */
export function createWorkspaceCyclePorts(
  options: WorkspaceCyclePortsOptions,
): CyclePorts {
  if (
    !isAbsolute(options.workspace) ||
    !isAbsolute(options.dataDir) ||
    !options.sessionId.trim()
  )
    throw Error(
      'authorized cycle workspace, private data and session are required',
    );
  if (
    !options.identity.name.trim() ||
    !options.identity.email.trim() ||
    /[\r\n\0]/.test(options.identity.name + options.identity.email)
  )
    throw Error('cycle commit identity is required');
  const signal = options.signal ?? new AbortController().signal;
  const redacted = options.redact ?? ((text: string) => text);
  const gitFor =
    options.createGit ??
    ((path: string) =>
      new GitWorkspaceService(path, {
        identity: options.identity,
        signoff: true,
        setUpstream: false,
      }));
  const deliveryFor =
    options.createDelivery ?? ((path: string) => new DeliveryService(path));
  const source = realpath(options.workspace);
  const gitCache = new Map<string, GitWorkspaceService>();
  const deliveryCache = new Map<string, DeliveryService>();
  const locks = new Map<string, Promise<unknown>>();
  const pathFor = (cycle: CycleRecord) =>
    join(
      options.dataDir,
      'cycle-ownership',
      hash(options.sessionId),
      `${hash(cycle.id)}.json`,
    );
  async function save(cycle: CycleRecord, owner: Ownership): Promise<void> {
    await mkdir(dirname(pathFor(cycle)), { recursive: true, mode: 0o700 });
    const temporary = `${pathFor(cycle)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(owner, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename(temporary, pathFor(cycle));
  }
  async function git(path: string): Promise<GitWorkspaceService> {
    let service = gitCache.get(path);
    if (!service) {
      service = gitFor(path);
      if ((await realpath(service.root)) !== (await realpath(path)))
        throw Error('cycle Git factory changed the owned workspace');
      gitCache.set(path, service);
    }
    return service;
  }
  async function delivery(owner: Ownership): Promise<DeliveryService> {
    let service = deliveryCache.get(owner.integration.path);
    if (!service) {
      service = deliveryFor(owner.integration.path);
      if (
        (await realpath(service.root)) !==
        (await realpath(owner.integration.path))
      )
        throw Error('cycle delivery factory changed the owned workspace');
      deliveryCache.set(owner.integration.path, service);
    }
    return service;
  }
  async function owned(cycle: CycleRecord): Promise<Ownership> {
    signal.throwIfAborted();
    const original = await source;
    const owner = JSON.parse(
      await readFile(pathFor(cycle), 'utf8'),
    ) as Ownership;
    if (
      owner.version !== 1 ||
      owner.cycleId !== cycle.id ||
      owner.sessionId !== options.sessionId ||
      owner.specification !== specification(cycle) ||
      owner.source !== original ||
      !Array.isArray(owner.rounds)
    )
      throw Error('cycle ownership record mismatch');
    const target = await realpath(owner.integration.path);
    const current = await realpath(cycle.workspace);
    if (
      target === original ||
      inside(original, target) ||
      (current !== original && current !== target)
    )
      throw Error('cycle workspace is not its owned integration');
    const manifest = JSON.parse(
      await readFile(join(dirname(target), 'owner.json'), 'utf8'),
    ) as IntegrationWorkspace;
    if (
      basename(dirname(target)) !== owner.integration.id ||
      manifest.id !== owner.integration.id ||
      (await realpath(manifest.path)) !== target ||
      (await realpath(manifest.repository)) !== original ||
      manifest.baseline !== owner.integration.baseline
    )
      throw Error('integration ownership changed');
    const [sourceRepository, targetRepository] = await Promise.all([
      cycleRepositoryIdentity(original),
      cycleRepositoryIdentity(target),
    ]);
    if (sourceRepository.common !== targetRepository.common)
      throw Error('cycle integration belongs to another repository');
    if (
      !owner.branch.startsWith('codex/') ||
      targetRepository.head !== `ref: refs/heads/${owner.branch}`
    )
      throw Error(
        'cycle integration branch changed; inspect before continuing',
      );
    return owner;
  }
  async function initialize(cycle: CycleRecord): Promise<Ownership> {
    let existing = false;
    try {
      await readFile(pathFor(cycle), 'utf8');
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A missing worktree or manifest is an ownership failure, never a new cycle.
    if (existing) return owned(cycle);
    const original = await source;
    if ((await realpath(cycle.workspace)) !== original)
      throw Error('new cycle must use its granted source workspace');
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    if (inside(original, await realpath(options.dataDir)))
      throw Error('cycle data must be outside the source repository');
    const tasks = await options.getTaskService();
    const integration = (await tasks.call(
      options.sessionId,
      'createIntegration',
      {},
    )) as IntegrationWorkspace;
    const target = await realpath(integration.path);
    if (
      target === original ||
      inside(original, target) ||
      (await realpath(integration.repository)) !== original
    )
      throw Error('task service returned an unowned integration');
    const branch = `codex/cycle-${hash(cycle.id).slice(0, 16)}-${integration.id.slice(0, 8)}`;
    const owner: Ownership = {
      version: 1,
      cycleId: cycle.id,
      sessionId: options.sessionId,
      specification: specification(cycle),
      source: original,
      integration,
      branch,
      rounds: [],
    };
    // Persist the selected worktree before checkout. A crash is reviewed, never silently re-created.
    await save(cycle, owner);
    await (await git(target)).git(['switch', '-c', branch]);
    return owned(cycle);
  }
  async function serial<T>(
    cycle: CycleRecord,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(cycle.id) ?? Promise.resolve();
    const running = previous.catch(() => {}).then(action);
    locks.set(cycle.id, running);
    try {
      return await running;
    } finally {
      if (locks.get(cycle.id) === running) locks.delete(cycle.id);
    }
  }
  function roundFor(owner: Ownership, ids: string[]): Round {
    const round = owner.rounds.find(
      (item) =>
        item.taskIds.length === ids.length &&
        item.taskIds.every((id) => ids.includes(id)),
    );
    if (!round || !ids.length || new Set(ids).size !== ids.length)
      throw Error('cycle tasks are not an owned candidate set');
    return round;
  }
  async function records(
    owner: Ownership,
    ids: string[],
  ): Promise<TaskRecord[]> {
    const round = roundFor(owner, ids),
      tasks = await options.getTaskService();
    return ids.map((id) => {
      const task = tasks.getTask(id);
      if (
        !task ||
        task.spec.sessionId !== options.sessionId ||
        task.spec.workspace !== owner.source ||
        task.spec.baseline !== round.baseline
      )
        throw Error('cycle task ownership or baseline changed');
      return task;
    });
  }
  async function state(
    cycle: CycleRecord,
    expected?: { revision: string; head?: string },
  ) {
    const owner = await owned(cycle),
      service = await git(owner.integration.path),
      snapshot = await service.snapshot();
    if (
      (await realpath(snapshot.root)) !==
      (await realpath(owner.integration.path))
    )
      throw Error('cycle Git worktree root changed; inspect before continuing');
    if (snapshot.branch !== owner.branch)
      throw Error(
        'cycle integration branch changed; inspect before continuing',
      );
    if (
      expected &&
      (snapshot.revision !== expected.revision ||
        (expected.head !== undefined && snapshot.head !== expected.head))
    )
      throw Error('cycle repository changed; revalidate before continuing');
    return { owner, service, snapshot };
  }
  async function pr(
    owner: Ownership,
  ): Promise<{ url: string; number?: number; head: string }> {
    const value = JSON.parse(
      await (
        await delivery(owner)
      ).gh([
        'pr',
        'view',
        '--json',
        'number,url,isDraft,headRefOid,headRefName,state',
      ]),
    ) as {
      url?: unknown;
      number?: unknown;
      headRefOid?: unknown;
      headRefName?: unknown;
      state?: unknown;
    };
    if (
      typeof value.url !== 'string' ||
      typeof value.headRefOid !== 'string' ||
      value.headRefName !== owner.branch ||
      value.state !== 'OPEN'
    )
      throw Error('pull request no longer belongs to the active cycle branch');
    return {
      url: value.url,
      ...(typeof value.number === 'number' ? { number: value.number } : {}),
      head: value.headRefOid,
    };
  }
  return {
    tasks: {
      create: (cycle, request, operation) =>
        serial(cycle, async () => {
          const owner = await initialize(cycle);
          let round = owner.rounds.find(
            (item) => item.operationId === operation.operationId,
          );
          if (round && round.kind !== request.kind)
            throw Error('cycle task operation was reused');
          if (!round) {
            const snapshot = await (
              await git(owner.integration.path)
            ).snapshot();
            if (snapshot.entries.length)
              throw Error(
                'preserve integration changes before creating new cycle tasks',
              );
            round = {
              operationId: operation.operationId,
              baseline: snapshot.head,
              kind: request.kind,
              taskIds: [
                `cycle-${hash([options.sessionId, cycle.id, operation.operationId]).slice(0, 40)}`,
              ],
            };
            owner.rounds.push(round);
            await save(cycle, owner);
          }
          await (
            await options.getTaskService()
          ).call(options.sessionId, 'enqueue', {
            operationId: `cycle-enqueue-${hash([options.sessionId, cycle.id, operation.operationId])}`,
            tasks: round.taskIds.map((id) => ({
              id,
              baseline: round!.baseline,
              access: request.kind === 'diagnosis' ? 'readonly' : 'write',
              resource: 'agent',
              dependencies: [],
              acceptanceCriteria:
                request.kind === 'diagnosis'
                  ? [
                      'diagnose the actual repeated CI failure and propose a revised plan',
                    ]
                  : cycle.acceptanceCriteria,
              prompt: `${request.prompt}\n\nTask: ${cycle.title}\n${cycle.body}\n\nAcceptance criteria:\n${cycle.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`,
            })),
          });
          return [...round.taskIds];
        }),
      status: async (cycle, ids) => {
        const owner = await owned(cycle),
          tasks = await records(owner, ids);
        if (
          tasks.some((task) =>
            ['needs_review', 'interrupted'].includes(task.state),
          )
        )
          return 'needs_review';
        if (
          tasks.some((task) =>
            ['failed', 'blocked', 'cancelled'].includes(task.state),
          )
        )
          return 'failed';
        if (tasks.some((task) => task.state !== 'succeeded')) return 'pending';
        return tasks.every(
          (task) =>
            (task.result as { verdict?: string } | undefined)?.verdict ===
            'passed',
        )
          ? 'passed'
          : 'needs_review';
      },
      merge: (cycle, ids) =>
        serial(cycle, async () => {
          const owner = await owned(cycle),
            round = roundFor(owner, ids),
            tasks = await records(owner, ids);
          if (
            round.kind === 'diagnosis' ||
            tasks.some(
              (task) =>
                task.state !== 'succeeded' ||
                (task.result as { verdict?: string } | undefined)?.verdict !==
                  'passed',
            )
          )
            return { status: 'needs_review' };
          const snapshot = await (await git(owner.integration.path)).snapshot();
          if (snapshot.entries.length || snapshot.head !== round.baseline)
            return { status: 'needs_review' };
          const result = (await (
            await options.getTaskService()
          ).call(options.sessionId, 'mergeCandidates', {
            integrationId: owner.integration.id,
            taskIds: ids,
            expectedHead: snapshot.head,
            expectedBaseline: round.baseline,
          })) as MergeCandidatesResult;
          return {
            status:
              result.status === 'merged'
                ? 'merged'
                : result.status === 'conflict'
                  ? 'conflict'
                  : 'needs_review',
            workspace: owner.integration.path,
          };
        }),
    },
    verify: async (cycle) => {
      const { owner, snapshot } = await state(cycle);
      // Keep temporary index paths within native Windows mkdtemp limits even
      // when the authorized application data root is already deeply nested.
      // Atomic allocation isolates attempts; full ownership stays in metadata.
      const artifactDirectory = await mkdtemp(join(options.dataDir, 'cv-'));
      await writeFile(
        join(artifactDirectory, 'verification.json'),
        JSON.stringify({
          sessionId: options.sessionId,
          cycleId: cycle.id,
          attempt: cycle.attempt,
          workspace: owner.integration.path,
          head: snapshot.head,
          revision: snapshot.revision,
        }),
        { mode: 0o600 },
      );
      const task: TaskRecord = {
        spec: {
          id: `cycle-verification-${hash(cycle.id).slice(0, 32)}`,
          sessionId: options.sessionId,
          workspace: owner.source,
          baseline: owner.integration.baseline,
          dependencies: [],
          access: 'readonly',
          resource: 'agent',
          prompt: `Independently verify the integrated candidate for ${cycle.title}`,
          acceptanceCriteria: [...cycle.acceptanceCriteria],
        },
        state: 'running',
        attempt: cycle.attempt + 1,
        worktree: owner.integration.path,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const changes = await captureTaskChanges(
        task,
        owner.integration.path,
        artifactDirectory,
      );
      const checks = await options.verify(task, {
        worktree: owner.integration.path,
        changes,
        signal,
        artifactDirectory,
        answer: '',
        events: [],
        withResource: options.withResource,
      });
      const after = await (await git(owner.integration.path)).snapshot();
      const accepted = (check: TaskVerificationCheck) =>
        check.status === 'passed' &&
        Boolean(check.evidence.trim()) &&
        (check.source !== 'command' ||
          (Boolean(check.command?.trim()) && check.exitCode === 0));
      const evidence = checks.map((check) => ({
        criterion: check.criterion,
        status:
          check.status === 'passed' && !accepted(check)
            ? ('needs_review' as const)
            : check.status,
        source: check.source,
        detail: redacted(
          check.status === 'passed' && !accepted(check)
            ? 'acceptance requires nonempty evidence and an identified command with exit code zero when command-based'
            : check.evidence,
        ),
      }));
      return {
        passed:
          snapshot.revision === after.revision &&
          checks.length > 0 &&
          checks.every(accepted) &&
          cycle.acceptanceCriteria.every((criterion) =>
            checks.some(
              (check) =>
                check.criterion === criterion && check.status === 'passed',
            ),
          ),
        head: after.head,
        evidence,
        paths: changes.paths,
      };
    },
    git: {
      snapshot: async (cycle) => {
        const { snapshot } = await state(cycle);
        return {
          head: snapshot.head,
          revision: snapshot.revision,
          branch: snapshot.branch,
          dirty: snapshot.entries.length > 0,
        };
      },
      commit: (cycle, input) =>
        serial(cycle, async () => {
          const { service, snapshot } = await state(cycle, input);
          if (
            !input.paths.length ||
            snapshot.entries.some((entry) => !input.paths.includes(entry.path))
          )
            throw Error('cycle commit must select every verified changed path');
          const stagedState = (await service.call('stage', {
            revision: snapshot.revision,
            paths: input.paths,
          })) as GitSnapshot;
          const staged = (
            await service.git(['diff', '--cached', '--name-only', '-z'])
          )
            .split('\0')
            .filter(Boolean)
            .sort();
          if (
            JSON.stringify([...new Set(input.paths)].sort()) !==
            JSON.stringify(staged)
          )
            throw Error(
              'cycle commit index differs from the verified path selection',
            );
          // The mutation already returns its fresh snapshot under the common
          // repository lock. Commit independently checks this expected revision.
          const committed = (await service.call('commit', {
            revision: stagedState.revision,
            paths: input.paths,
            message: input.message,
          })) as GitSnapshot;
          // The runner still re-reads the repository before accepting this HEAD.
          return { head: committed.head };
        }),
      push: (cycle, input) =>
        serial(cycle, async () => {
          const { service, snapshot } = await state(cycle, input);
          if (snapshot.entries.length)
            throw Error('cycle push requires a clean accepted candidate');
          await service.call('push', { revision: input.revision });
        }),
    },
    delivery: {
      publish: (cycle, input) =>
        serial(cycle, async () => {
          const owner = await owned(cycle);
          // publishPushed independently checks this exact revision/head, a clean
          // feature branch and the remote SHA using fresh candidate snapshots.
          await (
            await delivery(owner)
          ).publishPushed({
            revision: input.revision,
            head: input.head,
            title: cycle.title,
            body: cycle.body,
          });
          return pr(owner);
        }),
      checks: async (cycle) => {
        const owner = await owned(cycle),
          before = await pr(owner);
        const result = (await (await delivery(owner)).call('checks')) as {
          name: string;
          bucket: string;
          link?: string;
        }[];
        const after = await pr(owner);
        if (before.head !== after.head)
          throw Error('PR head changed while reading CI checks');
        const checks: CycleCheck[] = result.map((check) => {
          if (
            !['pass', 'fail', 'pending', 'cancel', 'skipping'].includes(
              check.bucket,
            ) ||
            typeof check.name !== 'string'
          )
            throw Error('invalid CI check result');
          const run = check.link?.match(/\/actions\/runs\/(\d+)(?:\/|$)/),
            runId = run ? Number(run[1]) : undefined;
          return {
            name: check.name,
            bucket: check.bucket as CycleCheck['bucket'],
            ...(Number.isSafeInteger(runId) && runId! > 0 ? { runId } : {}),
          };
        });
        return { head: after.head, checks };
      },
      logs: async (cycle, runId) => {
        const owner = await owned(cycle);
        const result = (await (
          await delivery(owner)
        ).call('logs', { runId })) as { text: string };
        return redacted(result.text);
      },
      retry: (cycle, runId) =>
        serial(cycle, async () => {
          const owner = await owned(cycle);
          await (await delivery(owner)).call('retry', { runId });
        }),
      ready: (cycle, input) =>
        serial(cycle, async () => {
          const { owner } = await state(cycle, input);
          const candidate = await pr(owner);
          if (candidate.head !== input.head)
            throw Error('PR candidate changed before review');
          await (
            await delivery(owner)
          ).call('ready', { revision: input.revision });
        }),
    },
  };
}
