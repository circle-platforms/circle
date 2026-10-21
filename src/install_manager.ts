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
import { reportInstalled } from './update.js';
import { compareVersions } from './version.js';
import {
  shellProbe,
  shellStartupFile,
  withoutStrayZshrc,
  zshIsInstalled,
} from './shell_rc.js';
import {
  DEFAULT_REPO,
  activeVersion,
  installLocation,
  pointToRelease,
  pruneVersions,
  stageRelease,
  validRepo,
} from './install_layout.js';

const say = (text: string): void => {
  process.stdout.write(`[circle-install] ${text}\n`);
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
// The published 1.10.0 updater already reports, but predates the explicit
// handoff flag. Its launcher identifies the installation it is updating.
const updaterReports =
  process.env.CIRCLE_UPDATE_REPORT === '1' ||
  (previous &&
    process.env.CIRCLE_INSTALL_PREFIX &&
    resolve(process.env.CIRCLE_INSTALL_PREFIX) === prefix &&
    compareVersions(previous, '1.10.0') >= 0);
if (
  previous &&
  compareVersions(manifest.version, previous) > 0 &&
  !updaterReports
)
  await reportInstalled(
    process.stdout,
    prefix,
    previous,
    manifest.version,
    repo,
  );
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
