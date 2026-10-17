import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

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
