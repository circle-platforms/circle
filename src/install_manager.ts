// Installs a verified release directory. Run by install.sh and install.ps1 with the release's
// own Node.js:
//   install_manager <release-directory> [prefix] [bin-directory] [repository]
// Missing arguments come from CIRCLE_PREFIX, CIRCLE_BIN_DIR and CIRCLE_REPO; without a prefix
// or bin folder the release goes to the default location.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
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
if (process.platform !== 'win32') {
  const onPath = (process.env.PATH ?? '')
    .split(delimiter)
    .some((entry) => entry && resolve(entry) === binDir);
  if (onPath)
    say('start it in a project folder: cd /path/to/project && circle');
  else if (process.env.CIRCLE_NO_PATH === '1')
    say(`add ${binDir} to PATH, or run ${binDir}/circle`);
  else {
    // One marked line in the shell's startup file, which circle uninstall takes out again.
    const rc = join(
      process.env.HOME || process.env.USERPROFILE || '',
      (process.env.SHELL || '').includes('bash') ? '.bashrc' : '.zshrc',
    );
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
}
