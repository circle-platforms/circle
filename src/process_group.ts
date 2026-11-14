// Signals a POSIX process group, as Circle stops what it started, and ends a
// process tree on any platform (taskkill on Windows).
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Whether a process in the group can still run: one not exited, not a zombie. */
export async function groupHasLiveMember(pgid: number): Promise<boolean> {
  const { stdout } = await run('/bin/ps', ['-A', '-o', 'pgid=,stat=']);
  return stdout.split('\n').some((row) => {
    const [group, state] = row.trim().split(/\s+/);
    return Number(group) === pgid && !!state && !state.startsWith('Z');
  });
}

/**
 * Sends `signal` to every process in the group. False when the group has
 * stopped: no process has its id (ESRCH), or, as macOS answers with EPERM,
 * its members have all exited and are not yet reaped. A refusal while a live
 * member remains still throws.
 */
export async function signalProcessGroup(
  pgid: number,
  signal: NodeJS.Signals,
): Promise<boolean> {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM' && !(await groupHasLiveMember(pgid))) return false;
    throw error;
  }
}

/**
 * Ends a process together with what it started. On POSIX that is the process group it leads, so it must have been
 * spawned with `detached: true`. On Windows it is its process tree, always forced. A process that is already gone is
 * not an error.
 */
export function killProcessTree(
  child: ChildProcess,
  force: boolean,
): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32')
    return new Promise((done) =>
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => done()),
    );
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      /* Already gone. */
    }
  }
  return Promise.resolve();
}

/**
 * Asks a process tree to end, then forces it after `graceMs`. Returns a function that cancels the forced kill, for
 * when the process ended in time.
 */
export function stopProcessTree(
  child: ChildProcess,
  graceMs = 500,
): () => void {
  void killProcessTree(child, false);
  const escalation = setTimeout(
    () => void killProcessTree(child, true),
    graceMs,
  );
  return () => clearTimeout(escalation);
}
