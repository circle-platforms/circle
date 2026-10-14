import { setTimeout as delay } from 'node:timers/promises';

// Playwright's waitForFunction treats an async predicate's Promise as truthy.
// Poll the IPC result here so both the state and its predicate are awaited.
export async function waitBrowserState(
  page,
  id,
  predicate,
  { timeoutMs = 10000, intervalMs = 25 } = {},
) {
  let state;
  let timer;
  const controller = new AbortController();
  const poll = async () => {
    for (;;) {
      state = await page.evaluate(
        (id) => window.circleDesktop.browserState(id),
        id,
      );
      controller.signal.throwIfAborted();
      if (await predicate(state)) return state;
      await delay(intervalMs, undefined, { signal: controller.signal });
    }
  };
  try {
    return await Promise.race([
      poll(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                `browser state for ${id} timed out after ${timeoutMs}ms; last state: ${JSON.stringify(state)}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
