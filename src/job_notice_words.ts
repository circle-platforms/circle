/**
 * The words for a finished job's notice that waits for the person. They are in a file of their own, with no imports,
 * so that a front end that translates the line can test against the sentence the runtime really writes.
 */

/** Why a notice waits for the person's next message instead of starting a turn. */
export type JobHold =
  /** Finished jobs have started `most` turns in a row. */
  | { why: 'limit'; most: number }
  /** The person stopped a turn or went back in the conversation, or a turn that kept failing was given up. */
  | { why: 'stopped' };

/** The limit of turns in a row that jobs may start, in words: `20 turns in a row started by jobs`, `1 turn started by jobs`. */
export function turnsStartedByJobs(most: number): string {
  return `${most} ${most === 1 ? 'turn' : 'turns in a row'} started by jobs`;
}

/** The line a conversation shows for a notice that waits, in English: `j21 done · … · 7m 38s · waits for your message after 20 turns in a row started by jobs`. */
export function waitingSentence(line: string, hold: JobHold): string {
  const why =
    hold.why === 'limit' ? ` after ${turnsStartedByJobs(hold.most)}` : '';
  return `${line} · waits for your message${why}`;
}
