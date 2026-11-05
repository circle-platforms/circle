import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export function isSafePackPath(path: string, maxDepth = 16): boolean {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\u0000')
  )
    return false;
  const parts = path.split('/');
  return (
    parts.length <= maxDepth &&
    !parts.some((part) => part === '' || part === '.' || part === '..')
  );
}

export function assertNoCaseCollisions(
  paths: readonly string[],
  errorMessage = 'personal pack path component case collision',
): void {
  const prefixes = new Map<string, string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'),
        key = prefix.toLowerCase();
      if (prefixes.has(key) && prefixes.get(key) !== prefix)
        throw Error(errorMessage);
      prefixes.set(key, prefix);
    }
  }
}

export function readSafePackFileSync(
  root: string,
  relPath: string,
  maxBytes: number,
): Buffer {
  if (lstatSync(root).isSymbolicLink())
    throw Error('pack root symlink refused');
  const directory = realpathSync(root),
    target = resolve(directory, relPath),
    rel = relative(directory, target);
  if (rel.startsWith('..') || isAbsolute(rel) || !isSafePackPath(relPath))
    throw Error('pack path escapes installation');
  let current = directory;
  for (const part of relPath.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw Error('pack symlinks are not installed');
  }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > maxBytes)
    throw Error('pack file unavailable or oversized');
  return readFileSync(target);
}
