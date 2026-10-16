// The processes that run a program from an installation's version folders. `circle uninstall`
// asks before it removes them: removing a folder would break a running session, and Windows
// refuses outright.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  readWindowsQueryMarkers,
  readWindowsProcessRecords,
  windowsProcessQuery,
  WindowsProcessQueryObservation,
} from './windows_process_query.js';

export type Run = (
  command: string,
  args: string[],
  timeout?: number,
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'> &
  Partial<Pick<SpawnSyncReturns<string>, 'pid' | 'signal'>>;

const runCommand: Run = (command, args, timeout = 120_000) =>
  spawnSync(command, args, { encoding: 'utf8', timeout });

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};
export const inside = (path: string, folder: string): boolean => {
  const rest = relative(resolve(folder), resolve(path));
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
};

// Why a program cannot be opened for writing, or undefined when it can. Windows answers EBUSY
// for a program that is running.
const openError = (path: string): string | undefined => {
  try {
    closeSync(openSync(path, 'r+'));
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'EIO';
  }
};
const LIST_TIMEOUT = 30_000;

// The processes running a program from `folders`, this one left out. Throws on Windows when a
// program in them is in use and no process could be named for it.
export function runningFrom(
  folders: string[],
  platform: NodeJS.Platform,
  run: Run = runCommand,
  opened: (path: string) => string | undefined = openError,
  report: (summary: string) => void = (summary) => {
    process.stderr.write(`[circle-install] ${summary}\n`);
  },
): number[] {
  const pids = new Set<number>();
  if (platform === 'linux') {
    for (const name of safeList('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const program = real(join('/proc', name, 'exe'));
      if (program && folders.some((folder) => inside(program, folder)))
        pids.add(Number(name));
    }
  } else if (platform === 'win32') {
    // Windows will not open a running program for writing. Query processes only when
    // a program is held or a folder could not be inspected.
    const programs: string[] = [];
    let unread = false;
    for (const folder of folders)
      try {
        for (const name of readdirSync(folder, {
          encoding: 'utf8',
          recursive: true,
        }))
          if (name.toLowerCase().endsWith('.exe'))
            programs.push(join(folder, name));
      } catch {
        unread = true;
      }
    const held = programs.flatMap((path) => {
      const code = opened(path);
      return code ? [{ path, code }] : [];
    });
    if (held.length || unread) {
      const names = [
        ...new Set(
          programs.map((path) => basename(path).replace(/\.exe$/i, '')),
        ),
      ];
      // A bounded owned Node worker queries the native process APIs directly.
      const query = windowsProcessQuery(names, unread);
      const queryStarted = performance.now();
      const result = run(process.execPath, query.args, LIST_TIMEOUT);
      const queryElapsedMs = performance.now() - queryStarted;
      const markers = readWindowsQueryMarkers(result.stderr || '', query.nonce);
      const records = readWindowsProcessRecords(result.stdout || '');
      const outputProblem =
        records.invalidRecords > 0 || records.incompleteRecords > 0;
      for (const { pid, path } of records.entries)
        if (
          folders.some((folder) =>
            inside(real(path) ?? path, real(folder) ?? folder),
          )
        )
          pids.add(pid);
      // The query helper runs this program's own node, which may be inside the folders (circle
      // uninstall), and so may list itself: it is never a running program of theirs.
      if (typeof result.pid === 'number') pids.delete(result.pid);
      // A program in use that no listed process runs: removing it would fail halfway.
      const busy = held
        .filter((entry) => entry.code === 'EBUSY')
        .map((entry) => entry.path);
      if (
        !pids.size &&
        (busy.length ||
          (unread && (result.error || result.status !== 0 || outputProblem)))
      ) {
        const timedOut =
          (result.error as NodeJS.ErrnoException | undefined)?.code ===
          'ETIMEDOUT';
        const reason = timedOut
          ? `no answer in ${LIST_TIMEOUT / 1000} s`
          : result.error
            ? result.error.message
            : result.status !== 0
              ? markers.cleaned.trim() || `exit status ${result.status}`
              : outputProblem
                ? `unknown process output: invalid ${records.invalidRecords}, incomplete ${records.incompleteRecords}`
                : undefined;
        const files = busy.length
          ? `${busy.join(', ')} ${busy.length > 1 ? 'are' : 'is'} in use`
          : 'The existing installation could not be inspected';
        const observation = new WindowsProcessQueryObservation(
          markers,
          queryElapsedMs,
          result,
          records,
        );
        const error = new Error(
          reason
            ? `${files}, and the running programs could not be listed (${reason})`
            : `${files} by another program`,
          { cause: observation },
        );
        try {
          report(observation.message);
        } catch {
          // A diagnostic sink cannot replace the original failure.
        }
        throw error;
      }
    }
  } else {
    for (const folder of folders) {
      const result = run(systemTool('lsof'), ['-t', '+D', folder]);
      for (const line of (result.stdout || '').split('\n'))
        if (/^\d+$/.test(line.trim())) pids.add(Number(line.trim()));
    }
  }
  pids.delete(process.pid);
  return [...pids].sort((a, b) => a - b);
}
// System tools by their fixed location: the program may run with a PATH that lacks them.
const systemTool = (name: string): string =>
  ['/usr/sbin', '/usr/bin', '/bin', '/sbin']
    .map((folder) => join(folder, name))
    .find((path) => existsSync(path)) || name;
const safeList = (folder: string): string[] => {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
};
