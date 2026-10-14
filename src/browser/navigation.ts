import { setTimeout as delay } from 'node:timers/promises';

export type NavigationOutcome = 'page' | 'download' | 'aborted';

/** Download navigation can finish before the browser delivers its download-start event. */
export async function waitForDownloadStart(
  outcome: NavigationOutcome,
  started: () => boolean,
  signal: AbortSignal,
  timeout = 3000,
): Promise<void> {
  if (outcome === 'page') return;
  const end = Date.now() + timeout;
  while (!started() && Date.now() < end)
    await delay(Math.min(50, Math.max(1, end - Date.now())), undefined, {
      signal,
    }).catch((error) => {
      signal.throwIfAborted();
      throw error;
    });
  signal.throwIfAborted();
  if (outcome === 'download' && !started())
    throw Error(
      'the address started a download, but its download event did not arrive; it was not approved to keep',
    );
}
