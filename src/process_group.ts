// Signals a POSIX process group, as Circle stops what it started. Callers on
// Windows end process trees with taskkill instead.
import { execFile } from 'node:child_process';
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
