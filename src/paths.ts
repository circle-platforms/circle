import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

export function expandUser(path: string): string {
  return path === '~'
    ? homedir()
    : path.startsWith('~/') || path.startsWith('~\\')
      ? join(homedir(), path.slice(2))
      : path;
}
export function normalizeWorkspace(path: string): string {
  const absolute = resolve(expandUser(path));
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}
/** The spelling used before comparing paths. An existing path uses the
 * operating system's realpath, so a macOS temporary folder is `/private/var/…`
 * from either `/var/…` or `/private/var/…`. A missing path keeps its last
 * part and takes the realpath of its parent. */
export function canonicalPath(path: string): string {
  const absolute = resolve(expandUser(path));
  try {
    if (existsSync(absolute)) return realpathSync.native(absolute);
  } catch {
    try {
      if (existsSync(absolute)) return realpathSync(absolute);
    } catch {
      return absolute;
    }
  }
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  const tail = absolute.slice(parent.length + (parent.endsWith(sep) ? 0 : 1));
  return join(canonicalPath(parent), tail);
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
