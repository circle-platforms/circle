// Which startup file should gain the launcher's folder. The installer used to
// trust $SHELL alone and write ~/.zshrc whenever the name was not bash, including
// on a machine with no zsh. A candidate counts only when that shell is installed.
import { posix } from 'node:path';

export type ShellFamily = 'bash' | 'zsh';
const BARE_DIRS = ['/bin', '/usr/bin', '/usr/local/bin'];

function familyOf(shell: string): ShellFamily | undefined {
  const base = shell.trim().split(/[/\\]/).pop()?.toLowerCase();
  if (base === 'bash') return 'bash';
  if (base === 'zsh') return 'zsh';
  return undefined;
}

function installed(shell: string, exists: (path: string) => boolean): boolean {
  const name = shell.trim();
  if (!name) return false;
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) return exists(name);
  // `/usr/bin/zsh` is a Unix path. path.join on Windows would ask for `\usr\bin\zsh`.
  return BARE_DIRS.some((dir) => exists(posix.join(dir, name)));
}

/**
 * The rc file for the first installed bash or zsh among $SHELL, $BASH and the
 * login shell from the password database. Undefined when none of those is an
 * installed bash or zsh: the installer then leaves startup files alone.
 */
export function shellStartupFile(options: {
  home: string;
  env: { SHELL?: string; BASH?: string };
  exists: (path: string) => boolean;
  loginShell?: string;
}): { file: string; family: ShellFamily } | undefined {
  for (const candidate of [
    options.env.SHELL,
    options.env.BASH,
    options.loginShell,
  ]) {
    if (!candidate) continue;
    const family = familyOf(candidate);
    if (!family || !installed(candidate, options.exists)) continue;
    return {
      family,
      file: posix.join(options.home, family === 'bash' ? '.bashrc' : '.zshrc'),
    };
  }
  return undefined;
}

/**
 * Looks up shell programs under `root` instead of `/`. `/bin/zsh` becomes
 * `<root>/bin/zsh`. Without a root, the probe is the machine's own files.
 * The installer sets the root only from `CIRCLE_SHELL_ROOT`, which the tests use
 * so a Mac's `/bin/zsh` does not decide the result.
 */
export function shellProbe(
  exists: (path: string) => boolean,
  root?: string,
): (path: string) => boolean {
  if (!root) return exists;
  return (path) =>
    exists(path.startsWith('/') ? posix.join(root, path.slice(1)) : path);
}

/** zsh's program is on the usual paths. A name in $SHELL is not enough. */
export function zshIsInstalled(exists: (path: string) => boolean): boolean {
  return installed('zsh', exists);
}

/**
 * Drops blocks the old installer appended: a `# circle path` line and the
 * `export PATH="…:$PATH"` line under it. A file someone edited stays.
 * Returns the new text when a block went, otherwise undefined.
 */
export function withoutStrayZshrc(text: string): string | undefined {
  const lines = text.split('\n');
  const kept: string[] = [];
  let removed = false;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] === '# circle path') {
      const next = lines[index + 1] ?? '';
      if (next.startsWith('export PATH="') && next.endsWith(':$PATH"')) {
        removed = true;
        index++;
        if (kept.at(-1) === '') kept.pop();
        continue;
      }
    }
    kept.push(lines[index]!);
  }
  return removed ? kept.join('\n') : undefined;
}
