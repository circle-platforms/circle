import { waitDesktopReady } from './desktop-readiness.mjs';

// Resolves once the page has run two animation frames, which is what Playwright's
// stability check needs before it clicks. A window can be shown, laid out and enabled
// while it runs no frames at all: on a fresh Linux runner the first launch waits for
// the GPU process, which can take seconds to start (#124). DOM geometry and native
// visibility do not show that; a frame does.
export async function waitAnimationFrames(page, { label, timeoutMs }) {
  const since = Date.now();
  const result = await waitDesktopReady(
    () =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                resolve({ visibility: document.visibilityState }),
              ),
            ),
          ),
      ),
    () => true,
    { label, timeoutMs, stableMs: 0 },
  );
  return { ...result, waitedMs: Date.now() - since };
}
