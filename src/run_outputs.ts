// Skill-pack outputs already on disk. A later run must not replace them
// without a fresh confirmation: accept-edits and a saved workspace rule do
// not cover these files. A declared file at the workspace root protects only
// that file. A declared file in a subdirectory protects the existing files
// in that directory.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { canonicalPath } from './paths.js';

const SKIP = new Set(['node_modules', '.git', 'dist', '.circle']);

interface Guard {
  /** A directory of outputs. Existing files inside it are protected. */
  directory?: string;
  /** One file at the workspace root. */
  file?: string;
}

function inside(root: string, path: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(path));
  return rel !== '..' && !rel.startsWith('..' + sep) && !/^[A-Za-z]:/.test(rel);
}

function guards(workspace: string): Guard[] {
  const root = canonicalPath(workspace);
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
          const full = canonicalPath(resolve(root, output));
          if (!inside(root, full) || !existsSync(full)) continue;
          let stat;
          try {
            stat = statSync(full);
          } catch {
            continue;
          }
          if (stat.isDirectory()) {
            // The workspace itself is not a folder of outputs: that would
            // protect every existing file.
            if (full !== root) found.push({ directory: full });
            continue;
          }
          if (!stat.isFile()) continue;
          // dirname() is not a realpath. Compare it through the same helper
          // as the root, or a spelling difference stores the workspace root
          // as an output folder and every existing file asks again.
          const parent = canonicalPath(dirname(full));
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
  const root = canonicalPath(workspace);
  const full = canonicalPath(path);
  if (!inside(root, full) || !existsSync(full)) return false;
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  for (const guard of guards(workspace)) {
    if (guard.file && canonicalPath(guard.file) === full) return true;
    if (guard.directory && inside(guard.directory, full)) return true;
  }
  return false;
}

/** Whether a shell command names a protected output directory or root file. */
export function commandTouchesRunOutput(
  workspace: string,
  command: string,
): boolean {
  const root = canonicalPath(workspace);
  for (const guard of guards(workspace)) {
    if (guard.file) {
      const rel = relative(root, canonicalPath(guard.file))
        .split(sep)
        .join('/');
      if (rel && command.includes(rel)) return true;
    }
    if (guard.directory) {
      const rel = relative(root, canonicalPath(guard.directory))
        .split(sep)
        .join('/');
      if (rel && (command.includes(rel + '/') || command.includes(rel + ' ')))
        return true;
    }
  }
  return false;
}
