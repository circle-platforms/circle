import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalPath } from './paths.js';

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith('..' + sep) &&
    !isAbsolute(rel)
  );
};

const gitdirOf = (dotGit: string): string | undefined => {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
  return match ? resolve(dirname(dotGit), match[1]!) : undefined;
};

/**
 * The other checkouts of the workspace's repository: its linked worktrees, and its main
 * checkout when the workspace is itself a linked one. Git lists them; each is then checked
 * both ways, as git links them, so a folder that is only listed, or that only claims to be
 * one, is not one: a linked worktree's `.git` file names a record under this repository's
 * `worktrees/`, and that record's `gitdir` names the worktree's `.git` back; the main
 * checkout's `.git` is the repository itself. A bare entry, one git marks prunable and one
 * that is missing are left out. Not a repository, or no git: none.
 */
export function repositoryWorktrees(workspace: string): string[] {
  let listed: string;
  let common: string;
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', workspace, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
    common = canonicalPath(
      resolve(workspace, git('rev-parse', '--git-common-dir').trim()),
    );
    listed = git('worktree', 'list', '--porcelain');
  } catch {
    return [];
  }
  const own = canonicalPath(workspace);
  const roots: string[] = [];
  for (const entry of listed.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(entry)?.[1];
    if (!path || /^(bare|prunable)\b/m.test(entry)) continue;
    let root: string;
    try {
      root = canonicalPath(resolve(path));
    } catch {
      continue;
    }
    if (root === own) continue;
    try {
      const dotGit = resolve(root, '.git');
      if (statSync(dotGit).isDirectory()) {
        if (canonicalPath(dotGit) === common) roots.push(root);
        continue;
      }
      const record = gitdirOf(dotGit);
      if (!record) continue;
      const recordPath = canonicalPath(record);
      if (!inside(resolve(common, 'worktrees'), recordPath)) continue;
      const back = readFileSync(resolve(recordPath, 'gitdir'), 'utf8').trim();
      if (canonicalPath(resolve(recordPath, back)) === canonicalPath(dotGit))
        roots.push(root);
    } catch {
      // Missing or unreadable: not a checkout of this repository now
    }
  }
  return roots;
}
