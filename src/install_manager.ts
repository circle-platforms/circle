// Installs a verified release directory. Run by install.sh and install.ps1 with the release's
// own Node.js:
//   install_manager <release-directory> [prefix] [bin-directory] [repository]
// Missing arguments come from CIRCLE_PREFIX, CIRCLE_BIN_DIR and CIRCLE_REPO; without a prefix
// or bin folder the release goes to the default location.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, resolve } from 'node:path';
import {
  shellProbe,
  shellStartupFile,
  withoutStrayZshrc,
  zshIsInstalled,
} from './shell_rc.js';
import { t } from './locale.js';
import {
  DEFAULT_REPO,
  activeVersion,
  installLocation,
  pointToRelease,
  pruneVersions,
  stageRelease,
  validRepo,
} from './install_layout.js';

function installLine(text: string): string {
  const copying = /^copying circle (\S+) to (.+)$/.exec(text);
  if (copying)
    return t('copying circle {version} to {path}', {
      version: copying[1]!,
      path: copying[2]!,
    });
  const removed = /^removed circle (\S+)$/.exec(text);
  if (removed) return t('removed circle {version}', { version: removed[1]! });
  const installed = /^installed circle (\S+) in (.+)$/.exec(text);
  if (installed)
    return t('installed circle {version} in {prefix}', {
      version: installed[1]!,
      prefix: installed[2]!,
    });
  const add = /^add (.+) to PATH, or run (\S+)$/.exec(text);
  if (add)
    return t('add {dir} to PATH, or run {bin}', { dir: add[1]!, bin: add[2]! });
  const added = /^added (.+) to PATH in (.+)$/.exec(text);
  if (added)
    return t('added {dir} to PATH in {file}', {
      dir: added[1]!,
      file: added[2]!,
    });
  const opened =
    /^open a new terminal \(or run: source (.+)\), then: cd \/path\/to\/project && circle$/.exec(
      text,
    );
  if (opened)
    return t(
      'open a new terminal (or run: source {file}), then: cd /path/to/project && circle',
      { file: opened[1]! },
    );
  const removedFile =
    /^removed (.+); it only had a circle PATH line and zsh is not installed$/.exec(
      text,
    );
  if (removedFile)
    return t(
      'removed {file}; it only had a circle PATH line and zsh is not installed',
      { file: removedFile[1]! },
    );
  const removedLine =
    /^removed a circle PATH line from (.+); zsh is not installed$/.exec(text);
  if (removedLine)
    return t('removed a circle PATH line from {file}; zsh is not installed', {
      file: removedLine[1]!,
    });
  return t(text);
}
const say = (text: string): void => {
  process.stdout.write(`[circle-install] ${installLine(text)}\n`);
};
const [root, prefixArgument, binArgument, repoArgument] = process.argv.slice(2);
if (!root)
  throw new Error(
    'usage: install_manager <release-directory> [prefix] [bin-directory] [repository]',
  );
const repo = repoArgument || process.env.CIRCLE_REPO || DEFAULT_REPO;
if (!validRepo(repo)) throw new Error('invalid release repository');
const { prefix, binDir } = installLocation({
  prefix: prefixArgument || process.env.CIRCLE_PREFIX,
  binDir: binArgument || process.env.CIRCLE_BIN_DIR,
});
const manifest = stageRelease(root, prefix, say);
const previous = activeVersion(prefix);
pointToRelease(manifest, prefix, binDir, repo);
for (const name of pruneVersions(prefix, [
  manifest.version,
  ...(previous ? [previous] : []),
]))
  say(`removed circle ${name}`);
if (process.env.CIRCLE_INSTALL_RESULT)
  writeFileSync(
    process.env.CIRCLE_INSTALL_RESULT,
    JSON.stringify({ version: manifest.version, prefix, binDir }) + '\n',
  );
say(`installed circle ${manifest.version} in ${prefix}`);
if (process.platform !== 'win32') {
  const onPath = (process.env.PATH ?? '')
    .split(delimiter)
    .some((entry) => entry && resolve(entry) === binDir);
  if (onPath)
    say('start it in a project folder: cd /path/to/project && circle');
  else if (process.env.CIRCLE_NO_PATH === '1')
    say(`add ${binDir} to PATH, or run ${binDir}/circle`);
  else {
    // $SHELL, then $BASH, then the login shell. Skip a shell that is not
    // installed, so a bash-only machine does not grow a ~/.zshrc. The marked
    // line is the one circle uninstall removes.
    let loginShell: string | undefined;
    try {
      loginShell = userInfo().shell || undefined;
    } catch {
      loginShell = undefined;
    }
    const home = process.env.HOME || process.env.USERPROFILE || '';
    // Tests set CIRCLE_SHELL_ROOT so `/bin/zsh` is a file they created, not the
    // machine's. A real install leaves it unset and sees the real programs.
    const shellExists = shellProbe(existsSync, process.env.CIRCLE_SHELL_ROOT);
    const startup = shellStartupFile({
      home,
      env: process.env,
      exists: shellExists,
      loginShell,
    });
    if (!startup) say(`add ${binDir} to PATH, or run ${binDir}/circle`);
    else {
      const rc = startup.file;
      const marked =
        existsSync(rc) && readFileSync(rc, 'utf8').includes('# circle path');
      if (!marked) {
        appendFileSync(
          rc,
          `\n# circle path\nexport PATH="${binDir.replaceAll('"', '\\"')}:$PATH"\n`,
        );
        say(`added ${binDir} to PATH in ${rc}`);
      }
      say(
        `open a new terminal (or run: source ${rc}), then: cd /path/to/project && circle`,
      );
    }
    // The old installer wrote ~/.zshrc whenever $SHELL was not bash, including
    // on a machine with no zsh. That line does nothing there; take it out.
    if (!zshIsInstalled(shellExists)) {
      const zshrc = resolve(home, '.zshrc');
      if (existsSync(zshrc)) {
        const next = withoutStrayZshrc(readFileSync(zshrc, 'utf8'));
        if (next !== undefined) {
          // The old installer created this file for the block. Nothing else
          // was in it, so an empty file would only be ours.
          if (next.trim() === '') unlinkSync(zshrc);
          else writeFileSync(zshrc, next);
          say(
            next.trim() === ''
              ? `removed ${zshrc}; it only had a circle PATH line and zsh is not installed`
              : `removed a circle PATH line from ${zshrc}; zsh is not installed`,
          );
        }
      }
    }
  }
}
