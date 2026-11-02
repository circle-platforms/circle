import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

export function expandUser(path: string): string {
  return path === '~'
    ? homedir()
    : path.startsWith('~/') || path.startsWith('~\\')
      ? join(homedir(), path.slice(2))
      : path;
}
/** Match fs/promises.realpath, including Windows short-name expansion, for missing file tails too. */
export function canonicalPath(path: string): string {
  const absolute = resolve(expandUser(path));
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling link cannot become a granted lexical file just because its
    // target is missing. Nested missing paths encounter this check at the link.
    try {
      if (lstatSync(absolute).isSymbolicLink()) throw error;
    } catch (entryError) {
      if (
        entryError === error ||
        (entryError as NodeJS.ErrnoException).code !== 'ENOENT'
      )
        throw entryError;
    }
    const parent = dirname(absolute);
    return parent === absolute
      ? absolute
      : join(canonicalPath(parent), basename(absolute));
  }
}
export function normalizeWorkspace(path: string): string {
  const absolute = resolve(expandUser(path));
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Workspace names may be recorded before their directory exists. Keep that
    // stable lexical identity; file targets use canonicalPath's existing parent.
    return absolute;
  }
}
export function circleHome(override?: string): string {
  return normalizeWorkspace(
    override ?? (process.env.CIRCLE_HOME?.trim() || join(homedir(), '.circle')),
  );
}
export function settingsPath(home = circleHome()): string {
  return join(home, 'settings.json');
}
export function credentialsPath(home = circleHome()): string {
  return join(home, 'credentials.json');
}
export function ensureHome(home = circleHome()): string {
  mkdirSync(home, { recursive: true });
  return home;
}
export function projectAgentDir(workspace: string): string {
  return join(normalizeWorkspace(workspace), '.agent');
}
/** The built-in root of tasks that belong to no project: one folder per task inside it. */
export const tasksRoot = (home = circleHome()): string => join(home, 'tasks');
/** The root a person pointed Circle at for their tasks, or the built-in one. */
export function tasksFolder(configured: string, home = circleHome()): string {
  const raw = (configured || '').trim();
  if (!raw) return tasksRoot(home);
  try {
    return normalizeWorkspace(raw);
  } catch {
    return tasksRoot(home);
  }
}
/** A task's folder name out of whatever it was called: a name, never a path. */
export function taskName(name: string): string {
  return (
    name
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 48) || 'task'
  );
}
/** A name for a task nobody named: today's date and a short id. */
export function newTaskName(now = new Date()): string {
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return day + '-' + randomUUID().slice(0, 6);
}
/** The folder a task with no project works in. */
export function taskWorkspace(name: string, root = tasksRoot()): string {
  return join(normalizeWorkspace(root), taskName(name));
}
/** Whether a workspace is one task's own folder directly under this root. */
export function isTaskWorkspace(path: string, root = tasksRoot()): boolean {
  const target = normalizeWorkspace(path);
  const base = normalizeWorkspace(root);
  return (
    target.length > base.length + 1 &&
    target.startsWith(base + sep) &&
    !target.slice(base.length + 1).includes(sep)
  );
}
export function projectDataDir(workspace: string, home = circleHome()): string {
  const target = normalizeWorkspace(workspace);
  const digest = createHash('sha256').update(target).digest('hex').slice(0, 12);
  const name =
    basename(target)
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 40)
      .replace(/^[._]+|[._]+$/g, '') || 'root';
  return join(home, 'projects', `${name}-${digest}`);
}

/** The folder that holds scheduled tasks: one folder per schedule, with its runs. */
export function schedulesRoot(home = circleHome()): string {
  return join(home, 'schedules');
}
