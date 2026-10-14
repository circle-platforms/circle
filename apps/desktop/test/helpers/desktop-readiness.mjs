import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

async function bounded(label, timeoutMs, operation) {
  const controller = new AbortController();
  const evidence = { last: undefined, reads: 0, captures: 0, rejected: [] };
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal, evidence),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = Error(
            `${label} timed out after ${timeoutMs}ms; last state: ${JSON.stringify(evidence.last)}`,
          );
          error.readiness = evidence;
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error && typeof error === 'object' && Object.isExtensible(error))
      error.readiness ??= evidence;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function stable(read, ready, signal, evidence, stableMs, intervalMs) {
  let key;
  let since;
  for (;;) {
    signal.throwIfAborted();
    const sample = await read();
    signal.throwIfAborted();
    evidence.last = sample;
    evidence.reads++;
    const next = JSON.stringify(sample);
    const matches = await ready(sample);
    signal.throwIfAborted();
    if (!matches) {
      key = undefined;
      since = undefined;
    } else {
      if (key !== next) {
        key = next;
        since = Date.now();
      }
      if (Date.now() - since >= stableMs) return sample;
    }
    await delay(intervalMs, undefined, { signal });
  }
}

export function waitDesktopReady(
  read,
  ready,
  {
    label = 'desktop readiness',
    timeoutMs = 10000,
    stableMs = 100,
    intervalMs = 25,
  } = {},
) {
  return bounded(label, timeoutMs, async (signal, evidence) => {
    const sample = await stable(
      read,
      ready,
      signal,
      evidence,
      stableMs,
      intervalMs,
    );
    return { sample, ...evidence };
  });
}

export function browserCaptureReady(sample, expected) {
  const { state, renderer, native } = sample;
  const child = native?.child;
  if (
    !native?.visible ||
    native.minimized ||
    !child?.visible ||
    state?.url !== expected.url ||
    state.title !== expected.title ||
    state.loading ||
    child.url !== expected.url ||
    child.title !== expected.title ||
    child.loading ||
    child.viewport?.readyState !== 'complete' ||
    !renderer?.rect
  )
    return false;
  const bounds = child.bounds;
  if (
    !bounds ||
    !native.content ||
    bounds.width < 1 ||
    bounds.height < 1 ||
    renderer.rect.width < 1 ||
    renderer.rect.height < 1 ||
    renderer.width !== native.content.width ||
    renderer.height !== native.content.height ||
    child.viewport.width !== bounds.width ||
    child.viewport.height !== bounds.height
  )
    return false;
  return ['x', 'y', 'width', 'height'].every(
    (key) => Math.round(renderer.rect[key]) === bounds[key],
  );
}

const staleCapture = (error) => {
  const sentence = String(error?.message ?? error)
    .split('\n')[0]
    .replace(/^page\.evaluate:\s*/, '')
    .replace(/^Error:\s*/, '')
    .replace(
      /^Error invoking remote method 'circle:browser-capture':\s*(?:Error:\s*)?/,
      '',
    );
  return (
    sentence ===
    'the page changed during capture; take a new browser_screenshot'
  );
};

// A read-only capture may be requested again only after the production freshness
// check rejected it. The readiness wait and every request share the original bound.
export function freshBrowserCapture(
  read,
  capture,
  expected,
  { timeoutMs = 10000, stableMs = 100, intervalMs = 25 } = {},
) {
  return bounded(
    'fresh browser capture',
    timeoutMs,
    async (signal, evidence) => {
      for (;;) {
        const before = await stable(
          read,
          (sample) => browserCaptureReady(sample, expected),
          signal,
          evidence,
          stableMs,
          intervalMs,
        );
        signal.throwIfAborted();
        evidence.captures++;
        let result;
        try {
          result = await capture();
        } catch (error) {
          signal.throwIfAborted();
          if (!staleCapture(error)) throw error;
          evidence.rejected.push(error.message);
          continue;
        }
        signal.throwIfAborted();
        assert.equal(result.url, expected.url);
        assert.equal(result.title, expected.title);
        assert.equal(result.loading, false);
        const after = await read();
        signal.throwIfAborted();
        evidence.last = after;
        assert.ok(
          browserCaptureReady(after, expected),
          'browser readiness changed after capture',
        );
        assert.deepEqual(
          after,
          before,
          'browser viewport changed after capture',
        );
        return { capture: result, ...evidence };
      }
    },
  );
}
