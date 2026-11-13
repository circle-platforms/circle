import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryWorktrees } from '../../../src/worktrees';
import { serializeTaskRepositoryMutation } from './workspace/task-worktrees';

export interface Checkout {
  id: string;
  path: string;
  branch: string;
  current: boolean;
}
export interface CheckoutBranches {
  branches: string[];
  current: string | null;
}

export interface GeneratedCheckout {
  checkout: Checkout;
  revision: string;
}

const identity = (path: string) =>
  createHash('sha256').update(path).digest('hex').slice(0, 24);
const git = (root: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '--no-pager',
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-C',
      root,
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();

function namedBranch(root: string): string | null {
  try {
    const ref = git(root, 'symbolic-ref', '--quiet', 'HEAD');
    return ref.startsWith('refs/heads/')
      ? ref.slice('refs/heads/'.length)
      : null;
  } catch {
    return null;
  }
}

export function listCheckoutBranches(root: string): CheckoutBranches {
  try {
    git(root, 'rev-parse', '--show-toplevel');
  } catch {
    return { branches: [], current: null };
  }
  const branches = git(
    root,
    'for-each-ref',
    '--sort=refname',
    '--format=%(refname:strip=2)',
    'refs/heads/',
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const current = namedBranch(root);
  return {
    branches,
    current: current && branches.includes(current) ? current : null,
  };
}

export function listCheckouts(root: string, current?: string): Checkout[] {
  try {
    git(root, 'rev-parse', '--show-toplevel');
  } catch {
    return [];
  }
  const canonical = realpathSync.native(root);
  return [canonical, ...repositoryWorktrees(root)].map((path) => ({
    id: identity(path),
    path,
    branch: namedBranch(path) ?? git(path, 'rev-parse', '--short=7', 'HEAD'),
    current: path === (current ?? canonical),
  }));
}
export function checkoutTarget(
  root: string,
  id: string,
  expectedBranch?: string,
): Checkout {
  const checkout = listCheckouts(root).find((row) => row.id === id);
  if (!checkout)
    throw Error('checkout is missing or no longer belongs to this repository');
  if (expectedBranch !== undefined && checkout.branch !== expectedBranch)
    throw Error('destination branch changed; reopen the worktree menu');
  return checkout;
}
export function createCheckout(
  root: string,
  folder: string,
  branch: string,
  start: string,
): Checkout {
  if (
    !branch ||
    branch.startsWith('-') ||
    branch.length > 200 ||
    !start ||
    start.startsWith('-') ||
    start.length > 200
  )
    throw Error('invalid worktree branch or starting revision');
  git(root, 'check-ref-format', '--branch', branch);
  return addCheckout(root, folder, branch, resolveRevision(root, start));
}

function resolveRevision(root: string, start: string): string {
  return git(
    root,
    'rev-parse',
    '--verify',
    '--end-of-options',
    start + '^{commit}',
  );
}

function addCheckout(
  root: string,
  folder: string,
  branch: string,
  revision: string,
): Checkout {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'checkout-' + randomUUID());
  git(root, 'worktree', 'add', '-b', branch, path, revision);
  const canonical = realpathSync.native(path);
  return { id: identity(canonical), path: canonical, branch, current: false };
}

/** Pin a local branch for a new conversation or the current execution checkout for a move. */
export async function createGeneratedCheckout(
  root: string,
  folder: string,
  { base, expectedBranch }: { base?: string; expectedBranch?: string } = {},
): Promise<GeneratedCheckout> {
  return serializeTaskRepositoryMutation(root, async () => {
    const sourceBranch = base ?? namedBranch(root);
    const ref = sourceBranch === null ? 'HEAD' : 'refs/heads/' + sourceBranch;
    if (base !== undefined) git(root, 'check-ref-format', ref);
    const revision = resolveRevision(root, ref);
    if (
      expectedBranch !== undefined &&
      expectedBranch !== (sourceBranch ?? revision.slice(0, 7))
    )
      throw Error('execution branch changed; reopen the worktree menu');
    const slug = (sourceBranch ?? 'worktree')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 32)
      .replace(/^-|-$/g, '');
    const branch = `circle-${slug || 'worktree'}-${randomUUID().slice(0, 8)}`;
    mkdirSync(folder, { recursive: true });
    const path = join(realpathSync.native(folder), branch);
    // Own the directory before invoking Git, which can fail after registering it.
    mkdirSync(path);
    const reserved = lstatSync(path);
    const generated = {
      checkout: { id: identity(path), path, branch, current: false },
      revision,
    };
    try {
      git(root, 'worktree', 'add', '-b', branch, path, revision);
      return generated;
    } catch (error) {
      let kept = false;
      try {
        const present = lstatSync(path, { throwIfNoEntry: false });
        if (present) {
          if (present.dev !== reserved.dev || present.ino !== reserved.ino)
            kept = true;
          else if (repositoryWorktrees(root).includes(path))
            kept = !removeUntouchedCheckout(root, generated);
          else rmdirSync(path);
        }
      } catch {
        kept = true;
      }
      if (kept) {
        const reason =
          error instanceof Error ? error.message.trim() : String(error);
        throw Error(`${reason}. new worktree kept at ${path}`);
      }
      throw error;
    }
  });
}

/** Roll back only our untouched checkout. Git itself also refuses to remove dirty worktrees. */
export async function removeGeneratedCheckout(
  root: string,
  { checkout, revision }: GeneratedCheckout,
): Promise<boolean> {
  return serializeTaskRepositoryMutation(root, async () =>
    removeUntouchedCheckout(root, { checkout, revision }),
  );
}

function removeUntouchedCheckout(
  root: string,
  { checkout, revision }: GeneratedCheckout,
): boolean {
  if (
    namedBranch(checkout.path) !== checkout.branch ||
    resolveRevision(checkout.path, 'HEAD') !== revision ||
    git(
      checkout.path,
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignored',
    )
  )
    return false;
  git(root, 'worktree', 'remove', checkout.path);
  const ref = 'refs/heads/' + checkout.branch;
  // Do not delete a branch that changed, or one another checkout started using.
  const occupied = git(root, 'worktree', 'list', '--porcelain')
    .split(/\r?\n/)
    .includes('branch ' + ref);
  if (!occupied) {
    try {
      git(root, 'update-ref', '-d', ref, revision);
    } catch {
      // A concurrent ref update keeps the branch.
    }
  }
  return true;
}
