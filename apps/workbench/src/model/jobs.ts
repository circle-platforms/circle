import type { Job } from './types';

const GOING = new Set<Job['state']>(['running', 'waiting', 'stopping']);

/**
 * The commands Circle runs in the background for one conversation, the ones still going
 * first. Subagents and watches have their own places; the terminals the person opens
 * are not jobs.
 */
export function sessionJobs(
  sessionId: string,
  jobs: readonly Job[],
): { running: Job[]; ended: Job[] } {
  const own = jobs.filter(
    (job) => job.sessionId === sessionId && job.kind === 'command',
  );
  return {
    running: own.filter((job) => GOING.has(job.state)),
    // A long job that ends now comes first, however early it started.
    ended: own
      .filter((job) => !GOING.has(job.state))
      .reverse()
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
  };
}
