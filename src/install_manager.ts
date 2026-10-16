// Installs a verified release directory. Run by install.sh and install.ps1 with the release's
// own Node.js:
//   install_manager <release-directory> [prefix] [bin-directory] [repository]
// Missing arguments come from CIRCLE_PREFIX, CIRCLE_BIN_DIR and CIRCLE_REPO. Without a prefix,
// the release goes where the Python implementation was installed, else to the default.
// Copies of the Python implementation are removed after the new release has been checked and
// before it is selected; if one is still running, nothing changes.
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
  shellStartupFile,
  withoutStrayZshrc,
  zshIsInstalled,
} from './shell_rc.js';
import {
  DEFAULT_REPO,
  activeVersion,
  pointToRelease,
  pruneVersions,
  stageRelease,
  validRepo,
} from './install_layout.js';
import {
  chooseLocation,
  findPythonCopies,
  removePythonCopies,
  runningCopies,
  surroundings,
} from './legacy_install.js';

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
const where = surroundings();
if (prefixArgument) where.prefix = prefixArgument;
if (binArgument) where.binDir = binArgument;
const copies = findPythonCopies(where);
let running: number[];
try {
  running = runningCopies(copies, where);
} catch (error) {
  process.stderr.write(
    `[circle-install] the Python circle may still be running: ${error instanceof Error ? error.message : String(error)}. ` +
      'Close those sessions, then run the installer again. Nothing was changed.\n',
  );
  process.exit(1);
}
if (running.length) {
  process.stderr.write(
    `[circle-install] the Python circle is still running (process ${running.join(', ')}). ` +
      'Close those sessions, then run the installer again. Nothing was changed.\n',
  );
  process.exit(1);
}
const { prefix, binDir } = chooseLocation(copies, where);
const manifest = stageRelease(root, prefix, say);
for (const copy of copies)
  say(
    copy.kind === 'installer'
      ? `removing the Python circle installed in ${copy.prefix}`
      : `removing the Python circle installed with pip (${copy.script})`,
  );
removePythonCopies(copies);
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
    JSON.stringify({
      version: manifest.version,
      prefix,
      binDir,
      removedPrefixes: copies.flatMap((copy) =>
        copy.kind === 'installer' ? [copy.prefix] : [],
      ),
    }) + '\n',
  );
say(`installed circle ${manifest.version} in ${prefix}`);
if (process.platform !== 'win32') {
  const onPath = where.path
    .split(delimiter)
    .some((entry) => entry && resolve(entry) === binDir);
  if (onPath)
    say('start it in a project folder: cd /path/to/project && circle');
  else if (process.env.CIRCLE_NO_PATH === '1')
    say(`add ${binDir} to PATH, or run ${binDir}/circle`);
  else {
    // $SHELL, then $BASH, then the login shell. Skip a shell that is not installed,
    // so a bash-only machine does not grow a ~/.zshrc.
    let loginShell: string | undefined;
    try {
      loginShell = userInfo().shell || undefined;
    } catch {
      loginShell = undefined;
    }
    const startup = shellStartupFile({
      home: where.home,
      env: process.env,
      exists: existsSync,
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
    if (!zshIsInstalled(existsSync)) {
      const zshrc = resolve(where.home, '.zshrc');
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
