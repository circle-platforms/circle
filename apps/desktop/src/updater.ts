// Keeps the desktop application up to date. A check asks GitHub for the newest release; the
// update downloads this system's package into the data folder, checks its checksum, its
// signature and its version, and a restart hands it to a small installer that waits for the
// application to quit, puts the new copy where the running one is and starts it. A copy that
// cannot replace itself (Linux, a folder it may not write, a copy macOS runs from a translocated
// path) offers the release page instead.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, createReadStream, readFileSync } from 'node:fs';
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
/** Windows' own tar, which reads .zip; a GNU tar earlier on PATH (Git Bash) reads C:\ as a host. */
export const systemTar = (platform = process.platform): string =>
  platform === 'win32'
    ? win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

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
  /** A macOS .app bundle, a folder unpacked from a .zip, or a folder an .msi installed. */
  kind: 'bundle' | 'folder' | 'msi';
  /** What the update replaces: the bundle, or the folder that holds the executable. */
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
  if (platform === 'win32' && arch === 'x64') {
    const folder = win32.dirname(executable);
    // The installer package puts Circle in Program Files\Circle; another folder is a .zip
    const msi =
      !!programFiles &&
      folder.toLowerCase() === win32.join(programFiles, 'Circle').toLowerCase();
    return {
      kind: msi ? 'msi' : 'folder',
      target: folder,
      executable,
      asset: asset('windows', msi ? 'msi' : 'zip'),
    };
  }
  // Linux: Chromium's sandbox helper must belong to root, which an update cannot keep
  return undefined;
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
// The installer for Windows, given a JSON plan: runs the .msi, which replaces the installed
// copy, or swaps folders as the macOS one swaps bundles. Windows keeps a folder busy for a
// while after the last process in it has ended, so the first rename is tried again.
export const WINDOWS_INSTALLER = String.raw`param([string]$Plan)
$ErrorActionPreference = 'Stop'
$p = Get-Content -Raw -LiteralPath $Plan | ConvertFrom-Json
function Write-Log([string]$Text) { Add-Content -LiteralPath $p.log -Value "$(Get-Date -Format o) $Text" }
try {
  Write-Log "installing $($p.staged) over $($p.target)"
  Wait-Process -Id $p.pid -ErrorAction SilentlyContinue
  Write-Log 'Circle has quit'
  if ($p.kind -eq 'msi') {
    $msi = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(
      '/i', ('"{0}"' -f $p.staged), '/passive', '/norestart', '/l*v', ('"{0}.msi"' -f $p.log))
    if ($msi.ExitCode -ne 0) { throw "msiexec exited with $($msi.ExitCode)" }
  } else {
    $parent = Split-Path -Parent $p.target
    $name = Split-Path -Leaf $p.target
    $next = Join-Path $parent ".$name.update"
    $old = Join-Path $parent ".$name.old"
    foreach ($path in $next, $old) {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    try { Move-Item -LiteralPath $p.staged -Destination $next }
    catch {
      if (Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Recurse -Force }
      Copy-Item -LiteralPath $p.staged -Destination $next -Recurse
    }
    Write-Log 'the new copy is beside the old one'
    for ($try = 1; ; $try++) {
      try { Rename-Item -LiteralPath $p.target -NewName ".$name.old"; break }
      catch { if ($try -ge 150) { throw }; Start-Sleep -Milliseconds 200 }
    }
    try { Rename-Item -LiteralPath $next -NewName $name }
    catch { Rename-Item -LiteralPath $old -NewName $name; throw }
    Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Log 'installed'
} catch {
  Write-Log "failed: $_"
}
Write-Log "starting $($p.executable)"
if ($p.args.Count) { Start-Process -FilePath $p.executable -ArgumentList $p.args } else { Start-Process -FilePath $p.executable }
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
  /** Starts the installer, detached; it outlives the application. */
  launch: (command: string, args: string[]) => void;
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
  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private set(state: UpdateState): UpdateState {
    this.current = state;
    for (const listener of this.listeners) listener(state);
    return state;
  }
  private page(version: string) {
    return `${this.releases}/tag/v${version}`;
  }
  /** Whether the running copy may be replaced: its folder is writable and macOS runs it in place. */
  private canReplace(): Promise<boolean> {
    const found = this.options.installation;
    this.replaceable ??= (async () => {
      if (!found) return false;
      if (found.kind === 'msi') return true;
      if (found.target.includes('/AppTranslocation/')) return false;
      const parent = (
        this.options.platform === 'win32' ? win32 : posix
      ).dirname(found.target);
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
          if (name !== 'install.log') await this.remove(join(folder, name));
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
      const staged = await this.unpack(found, file, directory);
      if (found.kind !== 'msi') {
        const asar =
          found.kind === 'bundle'
            ? join(staged, 'Contents/Resources/app.asar')
            : join(staged, 'resources/app.asar');
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
  ): Promise<string> {
    if (found.kind === 'msi') return file;
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
    const unpacked = join(directory, 'unpacked');
    await mkdir(unpacked);
    await run(systemTar(), ['-xf', file, '-C', unpacked]);
    const entries = await readdir(unpacked);
    const name = win32.basename(found.executable);
    if (entries.length !== 1)
      throw Error(`${win32.basename(file)} does not hold one folder`);
    const top = join(unpacked, entries[0]);
    await access(join(top, name));
    return top;
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
          kind: found.kind,
          staged: ready.staged,
          target: found.target,
          executable: found.executable,
          args,
          log,
        }),
      );
      await writeFile(script, WINDOWS_INSTALLER);
      launch('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        script,
        plan,
      ]);
    } else {
      const script = join(folder, 'install.sh');
      await writeFile(script, POSIX_INSTALLER);
      launch('/bin/sh', [
        script,
        pid,
        ready.staged,
        found.target,
        found.executable,
        log,
        ...args,
      ]);
    }
    this.set({ phase: 'installing', version: ready.version });
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
