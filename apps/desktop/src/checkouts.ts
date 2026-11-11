import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryWorktrees } from '../../../src/worktrees';

export interface Checkout {
  id: string;
  path: string;
  branch: string;
  current: boolean;
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

export function listCheckouts(root: string, current = root): Checkout[] {
  try {
    git(root, 'rev-parse', '--show-toplevel');
  } catch {
    return [];
  }
  return [realpathSync.native(root), ...repositoryWorktrees(root)].map(
    (path) => ({
      id: identity(path),
      path,
      branch: git(path, 'rev-parse', '--abbrev-ref', 'HEAD'),
      current: path === current,
    }),
  );
}
export function checkoutTarget(root: string, id: string): Checkout {
  const checkout = listCheckouts(root).find((row) => row.id === id);
  if (!checkout)
    throw Error('checkout is missing or no longer belongs to this repository');
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
  const revision = git(
    root,
    'rev-parse',
    '--verify',
    '--end-of-options',
    start + '^{commit}',
  );
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'checkout-' + randomUUID());
  git(root, 'worktree', 'add', '-b', branch, path, revision);
  return checkoutTarget(root, identity(realpathSync.native(path)));
}
