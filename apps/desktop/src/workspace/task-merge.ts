import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { TaskRecord } from './collaboration.js';
import type { TaskChanges } from './task-executor.js';
import { resolveTaskBaseline } from './task-worktrees.js';
const exec = promisify(execFile);
const queues = new Map<string, Promise<unknown>>();
async function git(
  path: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<Buffer> {
  return (
    await exec('git', ['-C', path, ...args], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    })
  ).stdout;
}
async function gitInput(
  path: string,
  args: string[],
  input: Buffer,
  env: NodeJS.ProcessEnv = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', path, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) child.kill();
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) child.kill();
      else errors.push(chunk);
    });
    child.once('error', reject);
    child.stdin.on('error', () => {});
    child.once('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(output))
        : reject(
            new Error(
              `git ${args[0]} failed (${code}): ${Buffer.concat(errors).toString('utf8')}`,
            ),
          ),
    );
    child.stdin.end(input);
  });
}
const text = (value: Buffer) => value.toString('utf8').trim();
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
export interface IntegrationWorkspace {
  id: string;
  path: string;
  repository: string;
  baseline: string;
  merged: {
    taskId: string;
    attempt: number;
    patchSha256: string;
    commit: string;
  }[];
}
export interface MergeCandidatesResult {
  status: 'merged' | 'baseline_changed' | 'conflict' | 'needs_review';
  workspace: IntegrationWorkspace;
  head: string;
  taskId?: string;
  reason?: string;
  conflicts?: string[];
}
export interface TaskIntegratorOptions {
  workspace: string;
  dataDir: string;
  identity: { name: string; email: string };
}
export interface MergeCandidatesOptions {
  expectedHead: string;
  /** Exact creation baseline of this repair round; must be an ancestor of the owned integration HEAD. */
  expectedBaseline?: string;
  signal?: AbortSignal;
}
/** Applies reviewed patches only in an owned integration worktree; never alters the caller's index or working files. */
export class TaskIntegrator {
  constructor(private readonly options: TaskIntegratorOptions) {
    if (!isAbsolute(options.dataDir))
      throw new Error('integration data directory must be absolute');
    if (
      !options.identity.name.trim() ||
      !options.identity.email.trim() ||
      /[\r\n]/.test(options.identity.name + options.identity.email)
    )
      throw new Error('integration commit identity is required');
  }
  private directory(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid integration id');
    return join(this.options.dataDir, 'integrations', id);
  }
  private async save(workspace: IntegrationWorkspace): Promise<void> {
    await writeFile(
      join(this.directory(workspace.id), 'owner.json'),
      JSON.stringify(workspace, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
  async create(baseline = 'HEAD'): Promise<IntegrationWorkspace> {
    const pin = await resolveTaskBaseline(this.options.workspace, baseline);
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    if (inside(pin.workspace, await realpath(this.options.dataDir)))
      throw new Error('integration data must be outside the source workspace');
    const id = randomUUID(),
      directory = this.directory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'workspace');
    await git(pin.workspace, [
      'worktree',
      'add',
      '--detach',
      path,
      pin.baseline,
    ]);
    const workspace: IntegrationWorkspace = {
      id,
      path,
      repository: pin.workspace,
      baseline: pin.baseline,
      merged: [],
    };
    await this.save(workspace);
    return workspace;
  }
  async get(id: string): Promise<IntegrationWorkspace> {
    const workspace = JSON.parse(
      await readFile(join(this.directory(id), 'owner.json'), 'utf8'),
    ) as IntegrationWorkspace;
    if (
      workspace.id !== id ||
      (await realpath(workspace.repository)) !==
        (await realpath(this.options.workspace)) ||
      (await realpath(workspace.path)) !==
        (await realpath(join(this.directory(id), 'workspace')))
    )
      throw new Error('integration ownership mismatch');
    const sourceCommon = await realpath(
      resolve(
        this.options.workspace,
        text(
          await git(this.options.workspace, ['rev-parse', '--git-common-dir']),
        ),
      ),
    );
    const targetCommon = await realpath(
      resolve(
        workspace.path,
        text(await git(workspace.path, ['rev-parse', '--git-common-dir'])),
      ),
    );
    if (
      sourceCommon !== targetCommon ||
      (await realpath(workspace.path)) ===
        (await realpath(this.options.workspace))
    )
      throw new Error('integration is not an isolated worktree');
    return workspace;
  }
  async mergeCandidates(
    id: string,
    tasks: TaskRecord[],
    options: MergeCandidatesOptions,
  ): Promise<MergeCandidatesResult> {
    const key = join(this.options.dataDir, id),
      previous = queues.get(key) ?? Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(() => this.merge(id, tasks, options));
    queues.set(key, result);
    try {
      return await result;
    } finally {
      if (queues.get(key) === result) queues.delete(key);
    }
  }
  private async merge(
    id: string,
    tasks: TaskRecord[],
    options: MergeCandidatesOptions,
  ): Promise<MergeCandidatesResult> {
    const workspace = await this.get(id);
    let head = text(await git(workspace.path, ['rev-parse', 'HEAD']));
    const outcome = (
      status: MergeCandidatesResult['status'],
      fields: Partial<MergeCandidatesResult> = {},
    ): MergeCandidatesResult => ({ status, workspace, head, ...fields });
    if (head !== options.expectedHead)
      return outcome('baseline_changed', {
        reason: 'integration HEAD changed; revalidate the candidate set',
      });
    const baseline = options.expectedBaseline ?? workspace.baseline;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseline))
      return outcome('needs_review', {
        reason: 'candidate baseline must be a fixed commit SHA',
      });
    try {
      await git(workspace.path, [
        'merge-base',
        '--is-ancestor',
        baseline,
        head,
      ]);
    } catch {
      return outcome('needs_review', {
        reason: 'candidate baseline is not an ancestor of integration HEAD',
      });
    }
    if (
      text(
        await git(workspace.path, [
          'status',
          '--porcelain',
          '--untracked-files=all',
        ]),
      )
    )
      return outcome('needs_review', {
        reason:
          'integration worktree contains changes; resolve or retain them before continuing',
      });
    const candidates = new Map(tasks.map((task) => [task.spec.id, task]));
    if (candidates.size !== tasks.length)
      return outcome('needs_review', { reason: 'duplicate candidates' });
    const ordered: TaskRecord[] = [],
      visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (task: TaskRecord): void => {
      if (visiting.has(task.spec.id))
        throw new Error('candidate dependency cycle');
      if (visited.has(task.spec.id)) return;
      visiting.add(task.spec.id);
      for (const dependency of task.spec.dependencies) {
        const prior = candidates.get(dependency);
        if (prior) visit(prior);
        else if (!workspace.merged.some((entry) => entry.taskId === dependency))
          throw new Error(`dependency ${dependency} has not been integrated`);
      }
      visiting.delete(task.spec.id);
      visited.add(task.spec.id);
      ordered.push(task);
    };
    try {
      for (const task of tasks) visit(task);
    } catch (error) {
      return outcome('needs_review', { reason: (error as Error).message });
    }
    for (const task of ordered) {
      options.signal?.throwIfAborted();
      const report = task.result as
        { verdict?: string; changes?: TaskChanges } | undefined;
      const changes = report?.changes;
      if (
        task.state !== 'succeeded' ||
        report?.verdict !== 'passed' ||
        !changes ||
        changes.baseline !== baseline ||
        task.spec.baseline !== baseline
      )
        return outcome('needs_review', {
          taskId: task.spec.id,
          reason:
            'candidate is not independently accepted against this integration baseline',
        });
      const integrated = workspace.merged.find(
        (entry) => entry.taskId === task.spec.id,
      );
      if (integrated) {
        if (
          integrated.attempt !== task.attempt ||
          integrated.patchSha256 !== changes.sha256
        )
          return outcome('needs_review', {
            taskId: task.spec.id,
            reason: 'a different attempt is already integrated',
          });
        continue;
      }
      const artifactRoot = await realpath(
        join(this.options.dataDir, 'artifacts'),
      );
      const patchPath = await realpath(changes.patchPath);
      if (!inside(artifactRoot, patchPath))
        return outcome('needs_review', {
          taskId: task.spec.id,
          reason: 'patch is outside task artifact storage',
        });
      const patch = await readFile(patchPath);
      if (createHash('sha256').update(patch).digest('hex') !== changes.sha256)
        return outcome('needs_review', {
          taskId: task.spec.id,
          reason: 'patch changed after acceptance',
        });
      const before = text(await git(workspace.path, ['rev-parse', 'HEAD']));
      if (before !== head)
        return outcome('baseline_changed', {
          reason: 'integration HEAD changed during merge',
          head: before,
        });
      if (patch.length) {
        const indexPath = text(
          await git(workspace.path, [
            'rev-parse',
            '--path-format=absolute',
            '--git-path',
            'index',
          ]),
        );
        const lockPath = `${indexPath}.lock`;
        let lock;
        try {
          lock = await open(lockPath, 'wx', 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            return outcome('needs_review', {
              taskId: task.spec.id,
              reason: 'integration Git index is in use',
            });
          throw error;
        }
        let temporary: string;
        try {
          temporary = await mkdtemp(join(this.directory(id), 'merge-'));
        } catch (error) {
          await lock.close();
          await rm(lockPath, { force: true });
          throw error;
        }
        const env = {
          GIT_INDEX_FILE: join(temporary, 'index'),
          GIT_OPTIONAL_LOCKS: '0',
        };
        let installed = false;
        const installIndex = async () => {
          await lock.writeFile(await readFile(env.GIT_INDEX_FILE));
          await lock.close();
          await rename(lockPath, indexPath);
          installed = true;
        };
        try {
          // Recheck under the real Git index lock. Concurrent stage/checkout cannot join this commit.
          if (
            text(
              await git(
                workspace.path,
                ['status', '--porcelain', '--untracked-files=all'],
                { GIT_OPTIONAL_LOCKS: '0' },
              ),
            )
          )
            return outcome('needs_review', {
              reason:
                'integration worktree changed before its Git index lock was acquired',
            });
          await git(workspace.path, ['read-tree', before], env);
          await git(workspace.path, ['update-index', '--refresh'], env);
          try {
            await gitInput(
              workspace.path,
              ['apply', '--3way', '--index', '-'],
              patch,
              env,
            );
          } catch (error) {
            const conflicts = [
              ...new Set(
                (
                  await git(
                    workspace.path,
                    ['ls-files', '--unmerged', '-z'],
                    env,
                  )
                )
                  .toString()
                  .split('\0')
                  .filter(Boolean)
                  .map((line) => line.slice(line.indexOf('\t') + 1)),
              ),
            ];
            await installIndex();
            return outcome('conflict', {
              taskId: task.spec.id,
              conflicts,
              reason: `patch could not be integrated; working files retained: ${(error as Error).message}`,
            });
          }
          options.signal?.throwIfAborted();
          if (text(await git(workspace.path, ['rev-parse', 'HEAD'])) !== before)
            return outcome('baseline_changed', {
              reason: 'integration HEAD changed before commit',
            });
          const paths = (
            await git(
              workspace.path,
              ['diff', '--cached', '--name-only', '-z'],
              env,
            )
          )
            .toString()
            .split('\0')
            .filter(Boolean);
          if (paths.some((path) => !changes.paths.includes(path)))
            return outcome('needs_review', {
              taskId: task.spec.id,
              reason:
                'unexpected paths entered the candidate index; files retained',
            });
          if (paths.length) {
            const tree = text(await git(workspace.path, ['write-tree'], env));
            const title = `Integrate task ${task.spec.id.replace(/[\r\n]/g, ' ')}`;
            const body = Buffer.from(
              `${title}\n\nSigned-off-by: ${this.options.identity.name} <${this.options.identity.email}>\n`,
            );
            const identity = {
              ...env,
              GIT_AUTHOR_NAME: this.options.identity.name,
              GIT_AUTHOR_EMAIL: this.options.identity.email,
              GIT_COMMITTER_NAME: this.options.identity.name,
              GIT_COMMITTER_EMAIL: this.options.identity.email,
            };
            const commit = text(
              await gitInput(
                workspace.path,
                ['commit-tree', tree, '-p', before, '-F', '-'],
                body,
                identity,
              ),
            );
            try {
              await git(workspace.path, ['update-ref', 'HEAD', commit, before]);
            } catch {
              return outcome('baseline_changed', {
                reason: 'integration HEAD changed while committing',
              });
            }
            head = commit;
          }
          await installIndex();
        } finally {
          await lock.close().catch(() => {});
          if (!installed) await rm(lockPath, { force: true });
          await rm(temporary, { recursive: true, force: true });
        }
      }
      workspace.merged.push({
        taskId: task.spec.id,
        attempt: task.attempt,
        patchSha256: changes.sha256,
        commit: head,
      });
      await this.save(workspace);
    }
    return outcome('merged');
  }
}
