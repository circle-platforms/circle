// Skill-pack outputs already on disk. A later run must not replace them
// without a fresh confirmation: accept-edits and a saved workspace rule do
// not cover these files. A declared file at the workspace root protects only
// that file. A declared file in a subdirectory protects the existing files
// in that directory.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', '.circle']);

interface Guard {
  /** A directory of outputs. Existing files inside it are protected. */
  directory?: string;
  /** One file at the workspace root. */
  file?: string;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !/^[A-Za-z]:/.test(rel);
}

/** One spelling of a path. An existing path is realpath'd. A path that is
 * not there yet keeps its last part and uses the realpath of its parent, so
 * `/var/…/out/report.md` and `/private/var/…/out/report.md` compare equal. */
function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    if (existsSync(absolute)) return realpathSync(absolute);
  } catch {
    return absolute;
  }
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  const tail = absolute.slice(parent.length + (parent.endsWith(sep) ? 0 : 1));
  return join(canonical(parent), tail);
}

function guards(workspace: string): Guard[] {
  const root = canonical(workspace);
  const found: Guard[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'skillpack.json' && entry.isFile()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(joinSafe(dir, entry.name), 'utf8'));
        } catch {
          continue;
        }
        const outputs =
          parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { outputs?: unknown }).outputs)
            ? (parsed as { outputs: unknown[] }).outputs
            : [];
        for (const output of outputs) {
          if (typeof output !== 'string' || !output.trim()) continue;
          const full = canonical(resolve(root, output));
          if (!inside(root, full) || !existsSync(full)) continue;
          let stat;
          try {
            stat = statSync(full);
          } catch {
            continue;
          }
          if (stat.isDirectory()) {
            if (full !== root) found.push({ directory: full });
            continue;
          }
          if (!stat.isFile()) continue;
          const parent = dirname(full);
          if (parent === root) found.push({ file: full });
          else found.push({ directory: parent });
        }
        continue;
      }
      if (
        entry.isDirectory() &&
        !SKIP.has(entry.name) &&
        !entry.name.startsWith('.')
      )
        visit(joinSafe(dir, entry.name), depth + 1);
    }
  };
  if (existsSync(root)) visit(root, 0);
  return found;
}

function joinSafe(dir: string, name: string): string {
  return resolve(dir, name);
}

/** An existing file a skill pack already produced, or another file in that directory. */
export function isExistingRunOutput(workspace: string, path: string): boolean {
  const root = canonical(workspace);
  const full = canonical(path);
  if (!inside(root, full) || !existsSync(full)) return false;
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  for (const guard of guards(workspace)) {
    if (guard.file && guard.file === full) return true;
    if (guard.directory && inside(guard.directory, full)) return true;
  }
  return false;
}

/** Whether a shell command names a protected output directory or root file. */
export function commandTouchesRunOutput(
  workspace: string,
  command: string,
): boolean {
  const root = canonical(workspace);
  for (const guard of guards(workspace)) {
    if (guard.file) {
      const rel = relative(root, guard.file).split(sep).join('/');
      if (rel && command.includes(rel)) return true;
    }
    if (guard.directory) {
      const rel = relative(root, guard.directory).split(sep).join('/');
      if (rel && (command.includes(rel + '/') || command.includes(rel + ' ')))
        return true;
    }
  }
  return false;
}
