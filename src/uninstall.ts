// `circle uninstall`: removes what the installer wrote — the launcher, the prefix with every
// version and the receipt, and the PATH change. The data folder stays unless `--purge` says
// otherwise, as installing and updating never touch it either.
//
// Every import here is static: on POSIX the removal unlinks this program's own files while it
// runs, and a dynamic import after that point would fail.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { UsageError } from './usage_error.js';
import { INSTALL_SCHEMA, validRepo } from './install_layout.js';
import {
  inside,
  runningCopies,
  surroundings,
  type InstallerCopy,
  type Run,
} from './legacy_install.js';
import { terminalPrompter, type LinePrompter } from './line_setup.js';
import { circleHome } from './paths.js';
import type { UpdateOutput } from './update.js';
import { compareVersions, VERSION } from './version.js';

export interface UninstallDeps {
  // The version folder of the running program, as in update.ts.
  root?: string;
  out?: UpdateOutput;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  // The data folder to show and to delete with --purge; defaults to circleHome().
  dataHome?: string;
  ask?: (question: string) => Promise<string | undefined>;
  run?: Run;
  spawnDetached?: (command: string, args: string[]) => void;
}

const runCommand: Run = (command, args) =>
  spawnSync(command, args, { encoding: 'utf8', timeout: 120_000 });
// The deferred removal on Windows runs apart from this process and outlives it.
const detach = (command: string, args: string[]): void => {
  spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
};
const powershell = (env: NodeJS.ProcessEnv): string =>
  join(
    env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
// A PowerShell single-quoted literal: only ' needs doubling, and nothing else is special.
const psLiteral = (text: string): string => text.replaceAll("'", "''");

// The script of the detached Windows helper: it waits up to 20 s for the processes that hold
// files open to end, then removes the files, the folder trees and, only when empty, the
// folders. Folder deletion goes through .NET so a folder that still has children stays
// without a confirmation prompt.
export function windowsDeferredRemoval(removal: {
  wait: number[];
  files: string[];
  trees: string[];
  emptyFolders: string[];
}): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$holders = @(${removal.wait.join(', ')})`,
    'foreach ($attempt in 1..100) { if (-not (Get-Process -Id $holders)) { break }; Start-Sleep -Milliseconds 200 }',
    ...removal.files.map(
      (file) => `Remove-Item -LiteralPath '${psLiteral(file)}' -Force`,
    ),
    ...removal.trees.map(
      (tree) => `Remove-Item -LiteralPath '${psLiteral(tree)}' -Recurse -Force`,
    ),
    ...removal.emptyFolders.map(
      (folder) =>
        `try { [System.IO.Directory]::Delete('${psLiteral(folder)}') } catch {}`,
    ),
  ].join('\n');
}

// The reverse of the block install_manager.ts appends to the shell startup file: the marker
// line plus the export naming this binDir. A block for another folder, or one edited by
// hand, stays as it is.
function stripRcBlock(text: string, binDir: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] === '# circle path') {
      // The line the installer wrote: export PATH="<binDir>:$PATH", with " escaped.
      const head = 'export PATH="';
      const tail = ':$PATH"';
      const next = lines[index + 1] ?? '';
      if (next.startsWith(head) && next.endsWith(tail)) {
        const named = next
          .slice(head.length, -tail.length)
          .replaceAll('\\"', '"');
        if (named === binDir) {
          index++;
          // The blank line the installer put before the marker goes with it.
          if (kept.at(-1) === '') kept.pop();
          continue;
        }
      }
    }
    kept.push(lines[index]!);
  }
  return kept.join('\n');
}

// Removes binDir from the user PATH the way install.ps1 added it: read the value unexpanded,
// write it back as ExpandString, and tell running programs the environment changed. Returns
// a warning when it could not; the files matter more than the PATH entry.
function removeWindowsPathEntry(
  binDir: string,
  env: NodeJS.ProcessEnv,
  run: Run,
): string | undefined {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$binDir = '${psLiteral(binDir)}'`,
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    'try {',
    "  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "  $entries = @($raw -split ';' | Where-Object { $_ -and [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ne $binDir.TrimEnd('\\') })",
    "  $value = $entries -join ';'",
    '  $changed = $value -ne $raw',
    "  if ($changed) { $key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString) }",
    '} finally { $key.Close() }',
    "if ($changed) { [Environment]::SetEnvironmentVariable('CIRCLE_PATH_TOUCH', $null, 'User') }",
  ].join('\n');
  const manual = `could not remove ${binDir} from your PATH`;
  const hint = 'Remove the entry yourself under Environment Variables.';
  try {
    const result = run(powershell(env), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    if (result.status !== 0)
      return `${manual}: ${
        (
          result.error?.message ||
          result.stderr ||
          result.stdout ||
          ''
        ).trim() || `exit ${result.status}`
      }. ${hint}`;
  } catch (error) {
    return `${manual}: ${error instanceof Error ? error.message : String(error)}. ${hint}`;
  }
  return undefined;
}

export async function uninstallInstalled(
  args: string[],
  deps: UninstallDeps = {},
): Promise<number> {
  const {
    env = process.env,
    platform = process.platform,
    out = process.stdout,
    run = runCommand,
    spawnDetached = detach,
  } = deps;
  if (args.includes('--help') || args.includes('-h')) {
    out.write(
      [
        'usage: circle uninstall [--purge] [--yes]',
        '',
        'Remove this Circle installation: the circle command, every installed',
        'version, the installation receipt, and the PATH lines the installer added.',
        'Sessions, settings and credentials stay in the data folder.',
        'circle uninstall --purge deletes that folder too.',
        '--yes skips the confirmation.',
        '',
      ].join('\n'),
    );
    return 0;
  }
  let purge = false;
  let yes = false;
  for (const arg of args)
    if (arg === '--purge') purge = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else throw new UsageError('usage: circle uninstall [--purge] [--yes]');
  const prefix = env.CIRCLE_INSTALL_PREFIX;
  if (!prefix)
    throw new Error(
      'circle uninstall requires an installer-managed installation',
    );
  let receipt: { schema: string; repo: string; binDir: string; prefix: string };
  try {
    receipt = JSON.parse(
      readFileSync(join(prefix, 'installation.json'), 'utf8'),
    );
  } catch {
    // Uninstall is also the way out of a broken installation, so a receipt that cannot be
    // read still has to say what is wrong.
    throw new Error('invalid installation receipt');
  }
  if (
    receipt.schema !== INSTALL_SCHEMA ||
    !validRepo(receipt.repo) ||
    resolve(receipt.prefix) !== resolve(prefix) ||
    typeof receipt.binDir !== 'string'
  )
    throw new Error('invalid installation receipt');
  const realPrefix = realpathSync(prefix);
  const root = realpathSync(deps.root ?? resolve(import.meta.dirname, '../..'));
  // Any kept version may uninstall the whole installation, not only the active one; unlike
  // update, a broken release is no reason to stop — that is when people uninstall.
  if (!inside(root, join(realPrefix, 'versions')))
    throw new Error('this program does not run from that installation');
  const where = surroundings(env, platform);
  const dataHome =
    deps.dataHome ?? circleHome(env.CIRCLE_HOME?.trim() || undefined);
  if (purge && resolve(dataHome) === resolve(homedir()))
    throw new Error('--purge would delete your home folder');
  let versions: string[] = [];
  try {
    versions = readdirSync(join(realPrefix, 'versions'));
  } catch {
    // A versions folder that is already gone is nothing to remove.
  }
  const copy: InstallerCopy = {
    kind: 'installer',
    prefix: realPrefix,
    versions: versions.map((name) => join(realPrefix, 'versions', name)),
    links: [],
    leftovers: [],
  };
  const pids = runningCopies([copy], where, run);
  if (pids.length)
    throw new Error(
      `circle is still running from this installation (process ${pids.join(', ')}). ` +
        'Close those sessions, then run circle uninstall again. Nothing was changed.',
    );
  const binDir = receipt.binDir;
  const launcher = join(binDir, platform === 'win32' ? 'circle.cmd' : 'circle');
  // The startup-file blocks that name this binDir, on both shells the installer may have
  // written: $SHELL can have changed since.
  const rcBlocks: string[] = [];
  if (platform !== 'win32' && where.home)
    for (const name of ['.bashrc', '.zshrc']) {
      const path = join(where.home, name);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      if (stripRcBlock(text, binDir) !== text) rcBlocks.push(path);
    }
  const pathNote =
    platform === 'win32'
      ? `the ${binDir} entry in your user PATH`
      : rcBlocks.length
        ? `the # circle path lines in ${rcBlocks.join(', ')}`
        : undefined;
  let prompter: LinePrompter | undefined;
  try {
    if (!yes) {
      if (!out.isTTY)
        throw new UsageError('circle uninstall needs --yes without a terminal');
      const named = versions
        .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
        .sort(compareVersions);
      out.write('this removes:\n');
      out.write(`  launcher  ${launcher}\n`);
      out.write(
        `  install   ${realPrefix}${
          named.length ? ` (versions ${named.join(', ')})` : ''
        }\n`,
      );
      if (pathNote) out.write(`  path      ${pathNote}\n`);
      if (purge) out.write(`  data      ${dataHome}\n`);
      else
        out.write(
          'this keeps:\n' +
            `  data      ${dataHome} (circle uninstall --purge deletes it too)\n`,
        );
      const ask =
        deps.ask ??
        ((question: string) => (prompter ??= terminalPrompter()).ask(question));
      const answer = await ask(`uninstall circle ${VERSION}? [y/N] `);
      // Anything but yes keeps the installation, silently as a declined prompt elsewhere.
      if (!/^y(es)?$/i.test((answer ?? '').trim())) return 1;
    }
    const warnings: string[] = [];
    let runningFolder: string | undefined;
    // An installer default puts the launcher folder inside the prefix (Windows: <prefix>\bin).
    const ownBin = inside(binDir, realPrefix) ? [binDir] : [];
    if (platform === 'win32') {
      // cmd.exe reads circle.cmd line by line while this program runs, so the launcher goes
      // with the deferred helper below, after the launcher's own process has ended.
      const warning = removeWindowsPathEntry(binDir, env, run);
      if (warning) warnings.push(warning);
      for (const name of versions) {
        const folder = join(realPrefix, 'versions', name);
        // The image of the running node.exe cannot be deleted while it runs: a helper that
        // waits for this process to end removes its folder afterwards.
        let mine = false;
        try {
          mine = realpathSync(folder) === root;
        } catch {
          mine = false;
        }
        if (mine) runningFolder = folder;
        else rmSync(folder, { recursive: true, force: true });
      }
    } else {
      rmSync(launcher, { force: true });
      for (const path of rcBlocks)
        writeFileSync(path, stripRcBlock(readFileSync(path, 'utf8'), binDir));
      // After this line the running program's own files are gone; nothing below may import
      // a module.
      rmSync(join(realPrefix, 'versions'), { recursive: true, force: true });
    }
    rmSync(join(realPrefix, 'current.ref'), { force: true });
    rmSync(join(realPrefix, 'installation.json'), { force: true });
    for (const folder of [join(realPrefix, 'versions'), ...ownBin, realPrefix])
      try {
        rmdirSync(folder);
      } catch {
        // Not empty, or already gone: on Windows the running version's folder and the
        // launcher are still there, and files of other programs in the prefix stay.
      }
    if (purge) rmSync(dataHome, { recursive: true, force: true });
    if (platform === 'win32') {
      const script = windowsDeferredRemoval({
        wait: [process.pid, process.ppid],
        files: [launcher],
        trees: runningFolder ? [runningFolder] : [],
        emptyFolders: [join(realPrefix, 'versions'), ...ownBin, realPrefix],
      });
      try {
        spawnDetached(powershell(env), [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          script,
        ]);
      } catch (error) {
        warnings.push(
          `could not schedule the removal of ${[launcher, ...(runningFolder ? [runningFolder] : [])].join(' and ')}: ${
            error instanceof Error ? error.message : String(error)
          }; delete ${runningFolder ? 'them' : 'it'} by hand after this session ends`,
        );
      }
    }
    out.write(`removed circle ${VERSION}\n`);
    if (purge) out.write(`removed the data folder ${dataHome}\n`);
    else
      out.write(
        `kept the data folder ${dataHome}; circle uninstall --purge removes it too\n`,
      );
    if (platform === 'win32')
      out.write('the last files go when this session ends\n');
    for (const warning of warnings) out.write(`warning: ${warning}\n`);
    return 0;
  } finally {
    prompter?.close();
  }
}
