import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  DEFAULT_REPO,
  INSTALL_SCHEMA,
  activeVersion,
  assetName,
  validateRelease,
} from './install_layout.js';
import { VERSION, validVersion, compareVersions } from './version.js';

// The release page of the repository this installation updates from
const releaseNotesUrl = (repo: string, version: string): string =>
  `https://github.com/${repo}/releases/tag/v${version}`;
// A path as the shell that runs the removal hint reads it, whatever it holds
const quotedPath = (path: string): string =>
  process.platform === 'win32'
    ? `'${path.replaceAll("'", "''")}'`
    : `'${path.replaceAll("'", "'\\''")}'`;

// ── the daily reminder ── remembers the last answer in update-check.json.
const CACHE_FILE = 'update-check.json';
const CHECK_INTERVAL_S = 24 * 60 * 60;
export function updateCheckEnabled(settings: {
  update_check?: unknown;
}): boolean {
  const off = (process.env.CIRCLE_NO_UPDATE_CHECK || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(off)) return false;
  return settings.update_check !== false;
}
// The newest published release, from where github.com/<repo>/releases/latest redirects.
// `releases` is that page's folder, which a check of the desktop update points elsewhere.
export async function latestRelease(
  repo = process.env.CIRCLE_REPO || DEFAULT_REPO,
  request: typeof fetch = fetch,
  releases = `https://github.com/${repo}/releases`,
): Promise<string> {
  const response = await request(`${releases}/latest`, {
    method: 'HEAD',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${repo} has not published a release yet`);
  return releaseTag(response.url, repo);
}
// The version in a release's address, .../releases/tag/v<version>.
export function releaseTag(url: string, repo = DEFAULT_REPO): string {
  const tag = /\/releases\/tag\/v?([^/?#]+)$/.exec(url)?.[1];
  if (!tag || !validVersion(tag))
    throw new Error(`${repo} has not published a release yet`);
  return tag;
}
// The newest version if it is newer than `current`. Asks the network at most once a day and
// remembers the answer, also when the check failed. Never throws.
export async function availableUpdate(
  home: string,
  current = VERSION,
  latest: () => Promise<string> = () => latestRelease(),
  now = Date.now() / 1000,
): Promise<string | undefined> {
  const path = join(home, CACHE_FILE);
  let cache: { checked_at?: unknown; latest?: unknown } = {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value && typeof value === 'object') cache = value;
  } catch {
    cache = {};
  }
  let known = typeof cache.latest === 'string' ? cache.latest : '';
  const checked = Number(cache.checked_at);
  if (
    !Number.isFinite(checked) ||
    now - checked >= CHECK_INTERVAL_S ||
    checked > now
  ) {
    try {
      known = await latest();
    } catch {
      // Offline or rate limited: try again tomorrow.
    }
    rememberLatest(home, known, now);
  }
  return known && validVersion(known) && compareVersions(known, current) > 0
    ? known
    : undefined;
}
// Writes what a check found, so that the daily check does not ask again today.
export function rememberLatest(
  home: string,
  latest: string,
  now = Date.now() / 1000,
): void {
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, CACHE_FILE),
      JSON.stringify({ checked_at: now, latest }) + '\n',
    );
  } catch {
    // A read-only data folder only means asking again next start.
  }
}
export const updateNotice = (latest: string, current = VERSION): string =>
  `Circle ${latest} is available (you have ${current}) · run \`circle update\``;

// Where `circle update` says what it is doing: the terminal, or a test.
export interface UpdateOutput {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
}
const megabytes = (bytes: number): string => (bytes / 1e6).toFixed(1);
// Downloads `url` to `path`. On a terminal one line shows how far it has got and redraws
// itself; elsewhere one line says what is downloading. Stops when no data has come for
// `idleMs`, or when `signal` aborts. `progress` hears the bytes so far and the size (0 when
// the answer gives none).
export async function downloadFile(
  url: string,
  path: string,
  {
    request = fetch,
    out = process.stdout,
    signal,
    idleMs = 60_000,
    progress,
  }: {
    request?: typeof fetch;
    out?: UpdateOutput;
    signal?: AbortSignal;
    idleMs?: number;
    progress?: (done: number, total: number) => void;
  } = {},
): Promise<void> {
  const label = basename(path);
  const idle = new AbortController();
  const timer = setTimeout(
    () =>
      idle.abort(
        new Error(`download stalled: no data for ${idleMs / 1000} seconds`),
      ),
    idleMs,
  );
  const stops = signal ? [idle.signal, signal] : [idle.signal];
  // `total` is unknown until the answer comes, and 0 when the answer gives no size.
  let width = 0,
    total: number | undefined,
    done = 0,
    shown = 0,
    started = Date.now();
  const draw = (last: boolean): void => {
    const now = Date.now();
    if (!last && now - shown < 100) return;
    shown = now;
    const seconds = (now - started) / 1000;
    const numbers =
      total === undefined
        ? ''
        : [
            ...(total
              ? [
                  `${Math.floor((done * 100) / total)}%`,
                  `${megabytes(done)}/${megabytes(total)} MB`,
                ]
              : [`${megabytes(done)} MB`]),
            ...(seconds >= 1 ? [`${megabytes(done / seconds)} MB/s`] : []),
          ].join('  ');
    // A line that wraps would leave every redraw on a row of its own: on a narrow terminal
    // the name gives way to the numbers.
    const room = (out.columns || 80) - 1 - (numbers ? numbers.length + 2 : 0);
    const line = [`downloading ${label}`.slice(0, Math.max(0, room)), numbers]
      .filter(Boolean)
      .join('  ');
    out.write('\r' + line.padEnd(width) + (last ? '\n' : ''));
    width = last ? 0 : line.length;
  };
  try {
    // GitHub takes a moment to send the file elsewhere: say what is coming meanwhile.
    if (out.isTTY) draw(false);
    const response = await request(url, { signal: AbortSignal.any(stops) });
    if (!response.ok || !response.body)
      throw new Error(`download failed: HTTP ${response.status} for ${url}`);
    total = Number(response.headers.get('content-length')) || 0;
    started = Date.now();
    shown = 0;
    if (out.isTTY) draw(false);
    else
      out.write(
        `downloading ${label}${total ? ` (${megabytes(total)} MB)` : ''}\n`,
      );
    const file = await open(path, 'w');
    try {
      for await (const chunk of response.body) {
        await file.write(chunk);
        done += chunk.length;
        timer.refresh();
        progress?.(done, total);
        if (out.isTTY) draw(false);
      }
    } finally {
      await file.close();
    }
    if (out.isTTY) draw(true);
  } catch (error) {
    if (width) out.write('\n');
    throw idle.signal.aborted
      ? idle.signal.reason
      : signal?.aborted
        ? signal.reason
        : error;
  } finally {
    clearTimeout(timer);
  }
}

export async function updateInstalled(
  args: string[],
  request: typeof fetch = fetch,
  {
    root = resolve(import.meta.dirname, '../..'),
    out = process.stdout,
  }: { root?: string; out?: UpdateOutput } = {},
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    out.write(
      [
        'usage: circle update [version] [--check]',
        '',
        'Download a Circle release and install it over this installation.',
        '  circle update           the latest release',
        '  circle update 1.2.3     that version',
        '  circle update --check   print the installed and available versions',
        '',
      ].join('\n'),
    );
    return 0;
  }
  const check = args.includes('--check');
  // The version comes alone or after `--version`.
  const versions = args.flatMap((arg, index) =>
    arg === '--check' || arg === '--version'
      ? []
      : args[index - 1] === '--version' || !arg.startsWith('-')
        ? [arg]
        : ['-'],
  );
  if (versions.length > 1 || versions[0] === '-' || args.at(-1) === '--version')
    throw new Error('usage: circle update [version] [--check]');
  const prefix = process.env.CIRCLE_INSTALL_PREFIX;
  if (!prefix)
    throw new Error('circle update requires an installer-managed installation');
  const installed = activeVersion(prefix);
  root = realpathSync(root);
  if (
    !installed ||
    installed !== VERSION ||
    realpathSync(join(prefix, 'versions', installed)) !== root
  )
    throw new Error('this program is not the active installed version');
  validateRelease(root);
  const metadata = JSON.parse(
    readFileSync(join(prefix, 'installation.json'), 'utf8'),
  ) as { schema: string; repo: string; binDir: string; prefix: string };
  if (
    metadata.schema !== INSTALL_SCHEMA ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(metadata.repo) ||
    resolve(metadata.prefix) !== resolve(prefix) ||
    typeof metadata.binDir !== 'string'
  )
    throw new Error('invalid installation receipt');
  let target: string | undefined = versions[0]?.replace(/^v/, '');
  if (!target) {
    let response: Response;
    try {
      response = await request(
        `https://api.github.com/repos/${metadata.repo}/releases/latest`,
        {
          signal: AbortSignal.timeout(30_000),
          headers: { Accept: 'application/vnd.github+json' },
        },
      );
    } catch (error) {
      throw releaseLookupError(
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!response.ok) throw releaseLookupError(response.status);
    const data = (await response.json()) as { tag_name?: string };
    target = data.tag_name?.replace(/^v/, '');
  }
  if (!target || !validVersion(target))
    throw new Error('release has an invalid semantic version');
  if (compareVersions(target, installed) <= 0 && !versions[0]) {
    out.write(`circle ${installed} is up to date\n`);
    return 0;
  }
  if (check) {
    out.write(`Installed ${installed}; available ${target}\n`);
    return 0;
  }
  const command = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const script = join(
    root,
    'app',
    process.platform === 'win32' ? 'install.ps1' : 'install.sh',
  );
  const childArgs =
    process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
      : [script];
  out.write(`updating circle ${installed} to ${target}\n`);
  // The download is here rather than in the installer so that it shows how far it has got on
  // every system; the installer then checks the file as it checks one it downloaded itself.
  const folder = mkdtempSync(join(tmpdir(), 'circle-update-'));
  const stop = new AbortController();
  const cancel = (): void => stop.abort(new Error('update cancelled'));
  process.once('SIGINT', cancel);
  try {
    const asset = assetName(target);
    const base = `https://github.com/${metadata.repo}/releases/download/v${target}/`;
    await downloadFile(base + asset, join(folder, asset), {
      request,
      out,
      signal: stop.signal,
    });
    await downloadFile(
      base + asset + '.sha256',
      join(folder, asset + '.sha256'),
      {
        request,
        out: { write: () => true },
        signal: stop.signal,
      },
    );
    const code = await new Promise<number>((resolveResult, reject) => {
      const child = spawn(command, childArgs, {
        stdio: 'inherit',
        env: {
          ...process.env,
          CIRCLE_VERSION: target,
          CIRCLE_PREFIX: prefix,
          CIRCLE_BIN_DIR: metadata.binDir,
          CIRCLE_REPO: metadata.repo,
          CIRCLE_ASSET_DIR: folder,
          // This updater prints the complete release list after the child exits.
          // Older updaters omit this, so the new installer reports the target.
          CIRCLE_UPDATE_REPORT: '1',
        },
      });
      child.once('error', reject);
      child.once('exit', (code) => resolveResult(code ?? 1));
    });
    if (code === 0)
      await reportInstalled(
        out,
        prefix,
        installed,
        target,
        metadata.repo,
        request,
      );
    return code;
  } finally {
    process.off('SIGINT', cancel);
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  }
}

function releaseLookupError(status?: number, message?: string): Error {
  const head =
    status !== undefined
      ? `release lookup failed: HTTP ${status}`
      : `release lookup failed: ${message ?? ''}`;
  const hint =
    status === undefined || status === 403 || status === 429
      ? '\nGitHub may be rate limiting this machine, or the network blocked the request. Wait a moment and run circle update again.'
      : '';
  return new Error(head + hint);
}

/** Versions strictly after `from` and up to `to`, oldest first. `to` is always included. */
export async function versionsSince(
  repo: string,
  from: string,
  to: string,
  request: typeof fetch,
): Promise<string[]> {
  const keep = (version: string): boolean =>
    validVersion(version) &&
    compareVersions(version, from) > 0 &&
    compareVersions(version, to) <= 0;
  const found = new Set<string>();
  try {
    const response = await request(
      `https://api.github.com/repos/${repo}/releases?per_page=100`,
      {
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/vnd.github+json' },
      },
    );
    if (response.ok) {
      const data = (await response.json()) as { tag_name?: string }[];
      for (const item of Array.isArray(data) ? data : []) {
        const version = item.tag_name?.replace(/^v/, '') ?? '';
        if (keep(version)) found.add(version);
      }
    }
  } catch {
    /* The install already finished. The target's notes still print. */
  }
  if (keep(to)) found.add(to);
  return [...found].sort(compareVersions);
}

function directoryBytes(path: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += directoryBytes(full);
    else if (entry.isFile())
      try {
        total += statSync(full).size;
      } catch {
        /* A file that left while it was measured is not kept. */
      }
  }
  return total;
}

export async function reportInstalled(
  out: { write(text: string): unknown },
  prefix: string,
  from: string,
  to: string,
  repo: string,
  request?: typeof fetch,
): Promise<void> {
  // The downloaded installer can report an upgrade even when the running
  // updater predates this feature, without making another network request.
  const notes = request ? await versionsSince(repo, from, to, request) : [to];
  out.write("What's new:\n");
  for (const version of notes)
    out.write(`  ${version}  ${releaseNotesUrl(repo, version)}\n`);
  const dir = join(prefix, 'versions');
  let bytes = 0;
  let example = '';
  try {
    for (const name of readdirSync(dir)) {
      if (name === to || name.startsWith('.')) continue;
      const full = join(dir, name);
      const size = directoryBytes(full);
      if (!size) continue;
      bytes += size;
      if (!example) example = name;
    }
  } catch {
    return;
  }
  if (!bytes || !example) return;
  const size = (bytes / (1024 * 1024)).toFixed(1);
  const command =
    process.platform === 'win32'
      ? `Remove-Item -Recurse -Force ${quotedPath(join(dir, example))}`
      : `rm -rf ${quotedPath(join(dir, example))}`;
  out.write(
    `Older versions kept so a session can finish use ${size} MB under ${dir}.\n`,
  );
  out.write(`Remove one when nothing is running from it: ${command}\n`);
}
