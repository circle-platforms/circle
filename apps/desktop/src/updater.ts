// Keeps the desktop application up to date. A check asks GitHub for the newest release; the
// update downloads this system's package into the data folder and checks it, and a restart hands
// it to a small installer that waits for the application to quit, puts the new version in place
// and starts it: on macOS the .dmg's bundle replaces the running one, on Windows the .msi
// replaces the installed copy, and on Linux the unpacked folder replaces the running one when
// that folder can be written. A setuid chrome-sandbox cannot be kept, so that Linux update
// does not start Circle again until the helper belongs to root. Any other copy (Windows
// outside the .msi's folder, a bundle macOS runs from a translocated path or that may not be
// written, a Linux folder that may not be written) offers the release page instead.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, createReadStream, readFileSync, statSync } from 'node:fs';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_REPO } from '../../../src/install_layout.js';
import {
  availableUpdate,
  downloadFile,
  latestRelease,
  rememberLatest,
} from '../../../src/update.js';
import { compareVersions, validVersion } from '../../../src/version.js';
import type { UpdateAction, UpdateState } from './contracts';

const run = promisify(execFile);

/** Where releases are published; CIRCLE_DESKTOP_RELEASES points a check at a local copy. */
export function releasesUrl(
  value = process.env.CIRCLE_DESKTOP_RELEASES,
): string {
  const fallback = `https://github.com/${DEFAULT_REPO}/releases`;
  if (!value) return fallback;
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw Error('CIRCLE_DESKTOP_RELEASES must be an https address');
  return url.href.replace(/\/+$/, '');
}

/** How this copy of the application is installed, and so how an update replaces it. */
export interface Installation {
  /** A macOS .app bundle, the folder the Windows .msi installed, or a Linux folder. */
  kind: 'bundle' | 'msi' | 'linux';
  /** What the update replaces: the bundle, or the installed folder. */
  target: string;
  /** What starts the application again afterwards. */
  executable: string;
  /** The release file for a version: circle-desktop-<version>-<os>-<arch>.<ext>. */
  asset: (version: string) => string;
}
export function installation(
  platform: string,
  arch: string,
  executable: string,
  programFiles?: string,
): Installation | undefined {
  const asset = (os: string, ext: string) => (version: string) =>
    `circle-desktop-${version}-${os}-${arch}.${ext}`;
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    const bundle = /^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(
      executable,
    )?.[1];
    return bundle
      ? {
          kind: 'bundle',
          target: bundle,
          executable,
          asset: asset('darwin', 'dmg'),
        }
      : undefined;
  }
  // Windows: the copy the .msi put in Program Files\Circle; the .msi is all that is released
  if (platform === 'win32' && arch === 'x64' && programFiles) {
    const folder = win32.dirname(executable);
    if (
      folder.toLowerCase() !== win32.join(programFiles, 'Circle').toLowerCase()
    )
      return undefined;
    return {
      kind: 'msi',
      target: folder,
      executable,
      asset: asset('windows', 'msi'),
    };
  }
  // Linux: the unpacked folder next to the binary. A writable copy is replaced in
  // place. chrome-sandbox loses setuid in the swap, so that case does not restart.
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    const folder = posix.dirname(executable);
    if (!folder || folder === '/' || folder === '.') return undefined;
    return {
      kind: 'linux',
      target: folder,
      executable,
      asset: asset('linux', 'tar.gz'),
    };
  }
  return undefined;
}

/** Whether the running copy's sandbox helper is setuid. The new files will not be. */
export function sandboxIsSetuid(folder: string): boolean {
  try {
    return (statSync(join(folder, 'chrome-sandbox')).mode & 0o4000) !== 0;
  } catch {
    return false;
  }
}

/** The hash a .sha256 file gives for `name`: "<hex>  <name>". */
export function checksumFor(text: string, name: string): string {
  for (const line of text.split('\n')) {
    const [hash, file] = line.trim().split(/\s+\*?/);
    if (hash && /^[0-9a-f]{64}$/i.test(hash) && (!file || file.endsWith(name)))
      return hash.toLowerCase();
  }
  throw Error(`${name}.sha256 holds no checksum`);
}
async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// The installer for macOS: waits for the application to quit, moves the new bundle beside the
// old one (copies it when the two are on different disks), swaps the two by renaming and starts
// the application. When the new copy cannot be put in place the old one stays, and the
// application starts as it was. Each step goes to the log, which the next start reads.
export const POSIX_INSTALLER = `#!/bin/sh
pid=$1 staged=$2 target=$3 executable=$4 log=$5
shift 5
exec >>"$log" 2>&1
echo "$(date) installing $staged over $target"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
echo "Circle has quit"
parent=$(dirname "$target")
name=$(basename "$target")
next="$parent/.$name.update"
old="$parent/.$name.old"
rm -rf "$next" "$old"
if command -v ditto >/dev/null 2>&1; then copy() { ditto "$1" "$2"; }; else copy() { cp -a "$1" "$2"; }; fi
if mv "$staged" "$next" 2>/dev/null || { rm -rf "$next"; copy "$staged" "$next"; }; then
  if mv "$target" "$old"; then
    if mv "$next" "$target"; then
      rm -rf "$old"
      if command -v xattr >/dev/null 2>&1; then xattr -dr com.apple.quarantine "$target" 2>/dev/null; fi
      echo installed
    else
      mv "$old" "$target"
      rm -rf "$next"
      echo "failed: the new copy could not be moved into place"
    fi
  else
    rm -rf "$next"
    echo "failed: the old copy could not be moved aside"
  fi
else
  rm -rf "$next"
  echo "failed: the new copy could not be written beside the old one"
fi
echo "starting $executable"
"$executable" "$@" >/dev/null 2>&1 &
`;
// Linux: the same swap as a bundle, then either start Circle or stop. A setuid
// chrome-sandbox on the copy that just quit will not be setuid on the new files,
// and Ubuntu 24.04 and later then refuse to start. The log names the two commands.
export const LINUX_INSTALLER = `#!/bin/sh
pid=$1 staged=$2 target=$3 executable=$4 log=$5 sandbox=$6
shift 6
exec >>"$log" 2>&1
echo "$(date) installing $staged over $target"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
echo "Circle has quit"
parent=$(dirname "$target")
name=$(basename "$target")
next="$parent/.$name.update"
old="$parent/.$name.old"
rm -rf "$next" "$old"
installed=0
if mv "$staged" "$next" 2>/dev/null; then
  if mv "$target" "$old"; then
    if mv "$next" "$target"; then
      rm -rf "$old"
      echo installed
      installed=1
    else
      mv "$old" "$target"
      rm -rf "$next"
      echo "failed: the new copy could not be moved into place"
    fi
  else
    rm -rf "$next"
    echo "failed: the old copy could not be moved aside"
  fi
else
  rm -rf "$next"
  echo "failed: the new copy could not be written beside the old one"
fi
if [ "$installed" != 1 ]; then
  exit 0
fi
if [ "$sandbox" = 1 ]; then
  echo "chrome-sandbox must belong to root again or Circle will not start"
  echo "sudo chown root:root \\"$target/chrome-sandbox\\""
  echo "sudo chmod 4755 \\"$target/chrome-sandbox\\""
  echo "then start \\"$executable\\""
else
  echo "starting $executable"
  "$executable" "$@" >/dev/null 2>&1 &
fi
`;
// The installer for Windows, given a JSON plan: waits for Circle and its other processes to end,
// runs the .msi, which replaces the installed copy, and starts Circle again.
// Circle starts it with -Start and waits: it starts itself again with Start-Process, hidden
// and apart from Circle's processes, with its own console and its output in <plan>.out and
// <plan>.err, and returns. A copy started straight from Circle did not outlive it.
export const WINDOWS_INSTALLER = String.raw`param([string]$Plan, [switch]$Start)
$ErrorActionPreference = 'Stop'
if ($Start) {
  Start-Process powershell.exe -WindowStyle Hidden -RedirectStandardOutput "$Plan.out" -RedirectStandardError "$Plan.err" -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    ('"{0}"' -f $MyInvocation.MyCommand.Path), ('"{0}"' -f $Plan))
  exit 0
}
$p = Get-Content -Raw -Encoding UTF8 -LiteralPath $Plan | ConvertFrom-Json
function Write-Log([string]$Text) { Add-Content -LiteralPath $p.log -Value "$(Get-Date -Format o) $Text" }
function Quote-Argument([string]$Value) {
  # Windows argv parsing consumes pairs of backslashes before quotes, including the
  # closing quote. Start-Process joins its array, so build one quoted command line.
  $quoted = [regex]::Replace($Value, '(\\*)"', {
    param($match)
    ('\' * (2 * $match.Groups[1].Value.Length + 1)) + '"'
  })
  $quoted = [regex]::Replace($quoted, '(\\+)$', '$1$1')
  '"' + $quoted + '"'
}
try {
  Write-Log "installing $($p.staged) over $($p.target)"
  $until = (Get-Date).AddSeconds(120)
  while ((Get-Process -Id $p.pid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $until) {
    Start-Sleep -Milliseconds 200
  }
  # Circle's other processes end soon after it; the files they hold cannot be replaced
  $inside = $p.target.TrimEnd('\') + '\'
  $until = (Get-Date).AddSeconds(60)
  do {
    $left = @(Get-Process | Where-Object {
      $_.Path -and $_.Path.StartsWith($inside, [StringComparison]::OrdinalIgnoreCase) })
    if ($left.Count) { Start-Sleep -Milliseconds 200 }
  } while ($left.Count -and (Get-Date) -lt $until)
  if ($left.Count) { Write-Log "still running: $(($left | ForEach-Object { '{0} {1}' -f $_.Name, $_.Id }) -join ', ')" }
  Write-Log 'Circle has quit'
  # Restart Manager would close or restart other programs; Circle has ended by now
  $msi = Start-Process $p.msiexec -Wait -PassThru -ArgumentList @(
    '/i', ('"{0}"' -f $p.staged), '/passive', '/norestart', 'MSIRESTARTMANAGERCONTROL=Disable',
    '/l*v', ('"{0}.msi"' -f $p.log))
  Write-Log "msiexec exited with $($msi.ExitCode)"
  # 3010 and 1641: installed, and Windows wants a restart for files it could not replace
  if (@(0, 3010, 1641) -notcontains $msi.ExitCode) { throw "msiexec exited with $($msi.ExitCode)" }
  Write-Log 'installed'
} catch {
  Write-Log "failed: $_"
}
Write-Log "starting $($p.executable)"
# In its own folder, as the Start menu and Explorer start it
$folder = Split-Path -Parent $p.executable
if ($p.args.Count) {
  $arguments = @($p.args | ForEach-Object { Quote-Argument $_ }) -join ' '
  Start-Process -FilePath $p.executable -WorkingDirectory $folder -ArgumentList $arguments
} else { Start-Process -FilePath $p.executable -WorkingDirectory $folder }
`;

export interface UpdaterOptions {
  /** The running version. */
  version: string;
  /** The runtime's data folder, whose update-check.json the daily check shares. */
  home: string;
  /** Where downloads, the installer and its log go. */
  folder: string;
  /** Undefined when this copy cannot replace itself. */
  installation?: Installation;
  platform?: string;
  releases?: string;
  /** Downloads; the release check also uses it unless `latest` is given. */
  request?: typeof fetch;
  /** The newest released version, asked of the network. */
  latest?: (releases: string) => Promise<string>;
  /**
   * Starts the installer, which outlives the application. It settles once the installer is on
   * its way; a rejection keeps the application running.
   */
  launch: (command: string, args: string[]) => void | Promise<void>;
  quit: () => void;
  /** The package.json inside an app.asar; Electron's fs reads into the archive. */
  readPackage?: (asar: string) => { name?: unknown; version?: unknown };
  /**
   * Deletes a file or folder. Electron's fs sees an app.asar as a folder and cannot delete a
   * downloaded application; the main process passes one built on original-fs.
   */
  remove?: (path: string) => Promise<void>;
  /** The arguments the new version starts with: the ones this one had. */
  args?: string[];
  pid?: number;
  /** Windows Installer, msiexec.exe; a test gives a stand-in. */
  msiexec?: string;
}
interface Ready {
  version: string;
  staged: string;
}
const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class Updater {
  private current: UpdateState = { phase: 'idle' };
  private listeners = new Set<(state: UpdateState) => void>();
  private ready?: Ready;
  private replaceable?: Promise<boolean>;
  private readonly releases: string;
  private readonly request: typeof fetch;
  private readonly remove: (path: string) => Promise<void>;
  constructor(private options: UpdaterOptions) {
    this.releases = options.releases ?? releasesUrl();
    this.request = options.request ?? fetch;
    this.remove =
      options.remove ?? ((path) => rm(path, { recursive: true, force: true }));
  }
  get state(): UpdateState {
    return this.current;
  }
  /**
   * Removes what an installed update left. On Windows the installer that started this copy can
   * still hold its output files for a moment while it exits; what stays locked is removed at the
   * next update, and the update is reported either way.
   */
  private async clear(path: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.remove(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== 'EBUSY' && code !== 'EPERM') || attempt === 12) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private linuxGuide(): { folder: string; sandbox: boolean } | undefined {
    const found = this.options.installation;
    if (found?.kind !== 'linux') return undefined;
    return { folder: found.target, sandbox: sandboxIsSetuid(found.target) };
  }
  private set(state: UpdateState): UpdateState {
    const linux = this.linuxGuide();
    const next: UpdateState =
      linux &&
      (state.phase === 'available' ||
        state.phase === 'ready' ||
        state.phase === 'installing' ||
        state.phase === 'failed')
        ? { ...state, linux }
        : state;
    this.current = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }
  private page(version: string) {
    return `${this.releases}/tag/v${version}`;
  }
  /**
   * Whether the running copy may be replaced: the .msi asks for permission itself; a bundle must
   * be writable, in a writable folder, and not run by macOS from a translocated copy.
   */
  private canReplace(): Promise<boolean> {
    const found = this.options.installation;
    this.replaceable ??= (async () => {
      if (!found) return false;
      if (found.kind === 'msi') return true;
      if (found.target.includes('/AppTranslocation/')) return false;
      const parent = posix.dirname(found.target);
      try {
        await access(found.target, constants.W_OK);
        await access(parent, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })();
    return this.replaceable;
  }

  /** What the last start left: an update that went in or did not, or one ready to install. */
  async start(): Promise<UpdateState> {
    const { folder, version } = this.options;
    const pending = readJson(join(folder, 'pending.json'));
    if (pending) {
      const wanted = String(pending.version);
      if (wanted === version) {
        // The installer's log stays until the next update, for when something looks wrong
        for (const name of await readdir(folder))
          if (name !== 'install.log') await this.clear(join(folder, name));
        return this.set({ phase: 'current', updated: version });
      }
      let detail = '';
      try {
        detail =
          readFileSync(join(folder, 'install.log'), 'utf8')
            .split('\n')
            .findLast((line) => / failed: |^failed: /.test(line))
            ?.replace(/^(?:\S+ )?failed: /, '') ?? '';
      } catch {
        /* no log: the installer did not run */
      }
      await this.remove(join(folder, 'pending.json'));
      await this.remove(join(folder, 'ready.json'));
      return this.set({
        phase: 'failed',
        version: wanted,
        error: `Circle ${wanted} was not installed${detail ? `: ${detail}` : ''}`,
        page: this.page(wanted),
      });
    }
    const ready = readJson(join(folder, 'ready.json'));
    if (
      ready &&
      typeof ready.version === 'string' &&
      typeof ready.staged === 'string' &&
      validVersion(ready.version) &&
      compareVersions(ready.version, version) > 0 &&
      (await this.canReplace())
    ) {
      try {
        await access(ready.staged);
        this.ready = { version: ready.version, staged: ready.staged };
        return this.set({ phase: 'ready', version: ready.version });
      } catch {
        /* the download is gone: check again */
      }
    }
    if (ready) await this.remove(folder);
    return this.current;
  }

  /**
   * Asks for the newest release. `force` asks the network now; without it the daily check's
   * answer is used, and a failure says nothing.
   */
  async check(force = true): Promise<UpdateState> {
    const phase = this.current.phase;
    if (['checking', 'downloading', 'ready', 'installing'].includes(phase))
      return this.current;
    const ask = () =>
      this.options.latest
        ? this.options.latest(this.releases)
        : latestRelease(DEFAULT_REPO, this.request, this.releases);
    if (force) this.set({ phase: 'checking' });
    try {
      let latest: string | undefined;
      if (force) {
        latest = await ask();
        rememberLatest(this.options.home, latest);
      } else
        latest = await availableUpdate(
          this.options.home,
          this.options.version,
          ask,
        );
      if (
        !latest ||
        !validVersion(latest) ||
        compareVersions(latest, this.options.version) <= 0
      )
        return this.set(force ? { phase: 'current' } : this.current);
      return this.set({
        phase: 'available',
        version: latest,
        ...((await this.canReplace()) ? {} : { page: this.page(latest) }),
      });
    } catch (error) {
      return this.set(
        force ? { phase: 'failed', error: message(error) } : this.current,
      );
    }
  }

  /** Downloads and checks the available version, ready to install on restart. */
  async download(): Promise<UpdateState> {
    const state = this.current;
    const found = this.options.installation;
    const version =
      state.phase === 'available' || (state.phase === 'failed' && !state.page)
        ? state.version
        : undefined;
    if (!version || !found || !(await this.canReplace())) return state;
    const { folder } = this.options;
    const directory = join(folder, version);
    const asset = found.asset(version);
    const file = join(directory, asset);
    const base = `${this.releases}/download/v${version}/`;
    try {
      await this.remove(folder);
      await mkdir(directory, { recursive: true });
      this.set({ phase: 'downloading', version, received: 0, total: 0 });
      let shown = 0;
      await downloadFile(base + asset, file, {
        request: this.request,
        out: { write: () => true },
        progress: (received, total) => {
          const now = Date.now();
          if (now - shown < 150 && received !== total) return;
          shown = now;
          this.set({ phase: 'downloading', version, received, total });
        },
      });
      await downloadFile(base + asset + '.sha256', file + '.sha256', {
        request: this.request,
        out: { write: () => true },
      });
      const expected = checksumFor(
        readFileSync(file + '.sha256', 'utf8'),
        asset,
      );
      if ((await sha256(file)) !== expected)
        throw Error(`${asset} does not match its checksum`);
      const staged = await this.unpack(found, file, directory, version);
      if (found.kind === 'bundle') {
        const asar = join(staged, 'Contents/Resources/app.asar');
        const manifest = (
          this.options.readPackage ??
          ((path) =>
            JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')))
        )(asar);
        if (manifest.name !== 'circle' || manifest.version !== version)
          throw Error(`${asset} does not hold Circle ${version}`);
      }
      this.ready = { version, staged };
      await writeFile(
        join(folder, 'ready.json'),
        JSON.stringify(this.ready) + '\n',
      );
      return this.set({ phase: 'ready', version });
    } catch (error) {
      await this.remove(folder).catch(() => {});
      return this.set({ phase: 'failed', version, error: message(error) });
    }
  }
  private async unpack(
    found: Installation,
    file: string,
    directory: string,
    version: string,
  ): Promise<string> {
    if (found.kind === 'bundle') {
      const mount = join(directory, 'mount');
      const app = join(directory, 'Circle.app');
      await mkdir(mount);
      await run('hdiutil', [
        'attach',
        '-nobrowse',
        '-readonly',
        '-noautoopen',
        '-mountpoint',
        mount,
        file,
      ]);
      try {
        await run('ditto', [join(mount, 'Circle.app'), app]);
      } finally {
        await run('hdiutil', ['detach', mount]).catch(() =>
          run('hdiutil', ['detach', '-force', mount]),
        );
      }
      await run('codesign', ['--verify', '--deep', '--strict', app]);
      return app;
    }
    if (found.kind === 'linux') {
      const asset = found.asset(version);
      const listed = String(
        (await run('tar', ['-tzf', file], { encoding: 'utf8' })).stdout,
      );
      const names = listed
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean);
      if (!names.length) throw Error(`${asset} is empty`);
      for (const name of names)
        if (
          name.startsWith('/') ||
          /^[A-Za-z]:[\\/]/.test(name) ||
          name.split(/[/\\]/).includes('..')
        )
          throw Error(`${asset} holds a path that leaves the archive`);
      const tops = new Set(
        names.map((name) => name.split(/[/\\]/)[0]).filter(Boolean),
      );
      if (tops.size !== 1) throw Error(`${asset} must hold one folder`);
      const staged = join(directory, 'app');
      await mkdir(staged);
      await run('tar', ['-xzf', file, '-C', staged]);
      const root = join(staged, [...tops][0]!);
      let marked = '';
      try {
        marked = readFileSync(join(root, 'CIRCLE_VERSION'), 'utf8').trim();
      } catch {
        marked = '';
      }
      if (marked !== version)
        throw Error(`${asset} does not hold Circle ${version}`);
      return root;
    }
    return file;
  }

  /** Hands the downloaded version to the installer and quits; it starts the new one. */
  async install(): Promise<UpdateState> {
    const found = this.options.installation;
    const ready = this.ready;
    if (this.current.phase !== 'ready' || !ready || !found) return this.current;
    const { folder, launch } = this.options;
    const log = join(folder, 'install.log');
    const pid = String(this.options.pid ?? process.pid);
    const args = this.options.args ?? [];
    let command: [string, string[]];
    await writeFile(
      join(folder, 'pending.json'),
      JSON.stringify({ version: ready.version, from: this.options.version }) +
        '\n',
    );
    if ((this.options.platform ?? process.platform) === 'win32') {
      const plan = join(folder, 'install.json');
      const script = join(folder, 'install.ps1');
      await writeFile(
        plan,
        JSON.stringify({
          pid: Number(pid),
          msiexec: this.options.msiexec ?? 'msiexec.exe',
          staged: ready.staged,
          target: found.target,
          executable: found.executable,
          args,
          log,
        }),
      );
      await writeFile(script, WINDOWS_INSTALLER);
      command = [
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          script,
          plan,
          '-Start',
        ],
      ];
    } else if (found.kind === 'linux') {
      const script = join(folder, 'install.sh');
      await writeFile(script, LINUX_INSTALLER);
      command = [
        '/bin/sh',
        [
          script,
          pid,
          ready.staged,
          found.target,
          found.executable,
          log,
          this.linuxGuide()?.sandbox ? '1' : '0',
          ...args,
        ],
      ];
    } else {
      const script = join(folder, 'install.sh');
      await writeFile(script, POSIX_INSTALLER);
      command = [
        '/bin/sh',
        [
          script,
          pid,
          ready.staged,
          found.target,
          found.executable,
          log,
          ...args,
        ],
      ];
    }
    this.set({ phase: 'installing', version: ready.version });
    try {
      await launch(...command);
    } catch (error) {
      await this.remove(join(folder, 'pending.json')).catch(() => {});
      return this.set({
        phase: 'failed',
        version: ready.version,
        error: `the installer did not start: ${message(error)}`,
      });
    }
    this.options.quit();
    return this.current;
  }

  command(action: UpdateAction): Promise<UpdateState> {
    switch (action) {
      case 'check':
        return this.check(true);
      case 'download':
        return this.download();
      case 'install':
        return this.install();
      default:
        throw Error('invalid update action');
    }
  }
}
