import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { ensureHome } from './paths.js';

// A lease outlives a turn: queued work, approvals and background jobs still own history.
// proper-lockfile uses atomic mkdir and a heartbeat; no PID-based takeover is involved.
export const SESSION_LEASE_STALE_MS = 30000;
const STALE = SESSION_LEASE_STALE_MS;
const UPDATE = 5000;
/** What to say when another runtime holds the session. Names the copy command. */
export function occupiedSessionMessage(sessionId: string): string {
  return `this session is open in another terminal. Close it there to continue, or copy it with circle --fork ${sessionId}`;
}

export class SessionOccupiedError extends Error {
  constructor(readonly sessionId: string) {
    super(occupiedSessionMessage(sessionId));
    this.name = 'SessionOccupiedError';
  }
}
function leasePath(home: string, sessionId: string): string {
  const directory = join(realpathSync(ensureHome(home)), 'session-locks');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, createHash('sha256').update(sessionId).digest('hex'));
}
export interface SessionLease {
  assertActive(): void;
  release(): void;
}
export function acquireSessionLease(
  home: string,
  sessionId: string,
  onCompromised?: (error: Error) => void,
): SessionLease {
  let compromised: Error | undefined;
  let released = false;
  let unlock: () => void;
  try {
    unlock = lockfile.lockSync(leasePath(home, sessionId), {
      realpath: false,
      stale: STALE,
      update: UPDATE,
      onCompromised(error) {
        compromised = error;
        onCompromised?.(error);
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED')
      throw new SessionOccupiedError(sessionId);
    throw error;
  }
  return {
    assertActive() {
      if (compromised) throw compromised;
      if (released) throw new Error('session ownership has been released');
    },
    release() {
      if (released) return;
      released = true;
      // A compromised lease has already been removed from proper-lockfile's registry.
      if (!compromised) unlock();
    },
  };
}
export function sessionOccupied(home: string, sessionId: string): boolean {
  return lockfile.checkSync(leasePath(home, sessionId), {
    realpath: false,
    stale: STALE,
  });
}
/**
 * Removes session lock directories whose heartbeat is already stale. A live
 * lease is left in place. Empty locks left by a killed process otherwise keep
 * a session looking occupied until the stale window passes.
 */
export function sweepStaleSessionLocks(home: string): void {
  let directory: string;
  try {
    directory = join(realpathSync(ensureHome(home)), 'session-locks');
  } catch {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    const target = join(directory, name.slice(0, -'.lock'.length));
    try {
      if (lockfile.checkSync(target, { realpath: false, stale: STALE }))
        continue;
      rmSync(join(directory, name), { recursive: true, force: true });
    } catch {
      /* Held, or already removed. */
    }
  }
}
