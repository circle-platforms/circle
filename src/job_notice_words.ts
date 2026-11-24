export type JobHold = { why: 'limit'; most: number } | { why: 'stopped' };

export function turnsStartedByJobs(most: number): string {
  return `${most} ${most === 1 ? 'turn' : 'turns in a row'} started by jobs`;
}

export function waitingSentence(line: string, hold: JobHold): string {
  const why =
    hold.why === 'limit' ? ` after ${turnsStartedByJobs(hold.most)}` : '';
  return `${line} · waits for your message${why}`;
}
