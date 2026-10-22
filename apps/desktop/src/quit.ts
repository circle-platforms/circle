/**
 * The bounded close behind before-quit. `close` has `limit` to finish and the quit happens
 * either way: a stalled close cannot keep the application — and the update's installer,
 * which waits for this process — waiting forever. A failure or the limit comes back to be
 * reported; the application is on its way out, so nothing is shown in a dialog.
 */
export async function closeForQuit(
  close: () => Promise<unknown>,
  limit: number,
): Promise<Error | undefined> {
  const result = await Promise.race([
    close().then(
      () => 'closed' as const,
      (error: unknown) =>
        error instanceof Error ? error : Error(String(error)),
    ),
    new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), limit).unref(),
    ),
  ]);
  if (result === 'closed') return undefined;
  if (result === 'timeout') return Error('closing did not finish in time');
  return result;
}
