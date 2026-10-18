import { opendir, lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { DEFAULT_CREDENTIAL_FILES, wildcard } from '../../../src/approvals.ts';

/** Incremental metadata discovery. No file bodies, model calls or directory links. */
export async function* discoverWorkspace(
  root: string,
  state: { truncated: boolean },
  check: () => void,
  limits = { files: 100_000, entries: 250_000, depth: 128 },
): AsyncGenerator<string> {
  let files = 0,
    visited = 0;
  const ignored = new Set([
    '.git',
    'node_modules',
    '.circle',
    '.venv',
    'dist',
    'build',
    'coverage',
    '.ssh',
    '.aws',
    '.gnupg',
  ]);
  async function* walk(folder: string, depth: number): AsyncGenerator<string> {
    check();
    if (depth > limits.depth) {
      state.truncated = true;
      return;
    }
    const local = relative(root, folder);
    const info = await lstat(folder);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (await realpath(folder)) !== folder ||
      isAbsolute(local) ||
      local === '..' ||
      local.startsWith('../')
    ) {
      state.truncated = true;
      return;
    }
    let directory;
    try {
      directory = await opendir(folder);
    } catch {
      state.truncated = true;
      return;
    }
    try {
      for await (const entry of directory) {
        check();
        if (++visited > limits.entries || files >= limits.files) {
          state.truncated = true;
          return;
        }
        if (
          entry.isSymbolicLink() ||
          ignored.has(entry.name) ||
          DEFAULT_CREDENTIAL_FILES.some((pattern) =>
            wildcard(pattern.toLowerCase(), entry.name.toLowerCase()),
          )
        )
          continue;
        const full = join(folder, entry.name);
        if (entry.isDirectory()) yield* walk(full, depth + 1);
        else if (entry.isFile()) {
          const actual = await lstat(full);
          if (
            !actual.isFile() ||
            actual.isSymbolicLink() ||
            actual.nlink > 1 ||
            (await realpath(full)) !== full
          )
            continue;
          check();
          files++;
          yield full;
        }
      }
    } catch (error) {
      check();
      state.truncated = true;
    }
  }
  yield* walk(root, 0);
}
