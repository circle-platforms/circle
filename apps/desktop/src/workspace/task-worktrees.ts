import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { TaskRecord } from './task-store.js';
import { serializeGitMutation } from './git.js';

const exec = promisify(execFile);
async function git(workspace: string, args: string[]): Promise<string> {
  const result = await exec('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.stdout.trim();
}
/** Registration changes share native Git's actual common-repository lock,
 * including callers authorized through different linked worktree roots.
 * Only hold this around the Git mutation, never an oracle or model request. */
export async function serializeTaskRepositoryMutation<T>(
  workspace: string,
  action: () => Promise<T>,
): Promise<T> {
  const common = await git(workspace, ['rev-parse', '--git-common-dir']);
  return serializeGitMutation(resolve(workspace, common), action);
}
export async function resolveTaskBaseline(
  workspace: string,
  baseline = 'HEAD',
): Promise<{ workspace: string; baseline: string }> {
  const root = await realpath(workspace);
  const repository = await realpath(
    await git(root, ['rev-parse', '--show-toplevel']),
  );
  if (root !== repository)
    throw new Error('task workspace must be the authorized repository root');
  // --end-of-options prevents user refs from being interpreted as Git flags.
  const commit = await git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${baseline}^{commit}`,
  ]);
  if (!/^[0-9a-f]{40,64}$/.test(commit))
    throw new Error('invalid baseline commit');
  return { workspace: root, baseline: commit };
}
/** Isolation for concurrent edits, not a permission or process security sandbox. */
export class TaskWorktrees {
  constructor(readonly directory: string) {}
  async prepare(task: TaskRecord): Promise<{ path: string; branch?: string }> {
    const key = createHash('sha256')
      .update(this.directory)
      .update('\0')
      .update(task.spec.id)
      .digest('hex')
      .slice(0, 24);
    const path = join(this.directory, `${key}-${task.attempt}`);
    const branch =
      task.spec.access === 'write'
        ? `codex/task-${key}-${task.attempt}`
        : undefined;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await serializeTaskRepositoryMutation(task.spec.workspace, () =>
      git(
        task.spec.workspace,
        branch
          ? ['worktree', 'add', '-b', branch, path, task.spec.baseline]
          : ['worktree', 'add', '--detach', path, task.spec.baseline],
      ),
    );
    return { path, ...(branch ? { branch } : {}) };
  }
  /** Refuses dirty or non-owned trees. Output is retained unless explicitly discarded elsewhere. */
  async removeClean(task: TaskRecord): Promise<boolean> {
    if (!task.worktree) return true;
    const directory = await realpath(this.directory);
    const path = await realpath(task.worktree);
    const child = relative(directory, path);
    if (
      !child ||
      child === '..' ||
      child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(child)
    )
      throw new Error('worktree is not owned by the task manager');
    return serializeTaskRepositoryMutation(task.spec.workspace, async () => {
      if (await git(path, ['status', '--porcelain', '--untracked-files=all']))
        return false;
      await git(task.spec.workspace, ['worktree', 'remove', path]);
      return true;
    });
  }
}
