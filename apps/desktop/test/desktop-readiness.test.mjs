import test from 'node:test';
import assert from 'node:assert/strict';
import {
  waitDesktopReady,
  browserCaptureReady,
  freshBrowserCapture,
} from './helpers/desktop-readiness.mjs';

const expected = { url: 'http://fixture/', title: 'fixture' };
const ready = () => ({
  state: { ...expected, loading: false },
  renderer: {
    width: 800,
    height: 650,
    rect: { x: 300, y: 100, width: 500, height: 550 },
  },
  native: {
    visible: true,
    minimized: false,
    content: { width: 800, height: 650 },
    child: {
      ...expected,
      visible: true,
      loading: false,
      bounds: { x: 300, y: 100, width: 500, height: 550 },
      viewport: { width: 500, height: 550, readyState: 'complete' },
    },
  },
});
const capture = () => ({
  ...expected,
  loading: false,
  dataUrl: 'fresh capture',
});

test('native readiness awaits actual asynchronous shown state rather than renderer presence', async () => {
  const samples = [{ visible: false }, { visible: true }];
  let reads = 0;
  const result = await waitDesktopReady(
    async () => {
      await Promise.resolve();
      return samples[reads++];
    },
    async (state) => {
      await Promise.resolve();
      return state.visible;
    },
    { stableMs: 0, intervalMs: 0 },
  );
  assert.equal(reads, 2);
  assert.equal(result.sample, samples[1]);
});

test('capture readiness requires native/DOM viewport agreement even after URL, title and load are ready', () => {
  assert.equal(browserCaptureReady(ready(), expected), true);
  for (const change of [
    (s) => {
      s.native.visible = false;
    },
    (s) => {
      s.native.child.bounds.width = 501;
    },
    (s) => {
      s.native.child.viewport.width = 501;
    },
    (s) => {
      s.renderer.width = 799;
    },
    (s) => {
      s.state.loading = true;
    },
    (s) => {
      s.native.child.url = 'http://changed/';
    },
  ]) {
    const sample = ready();
    change(sample);
    assert.equal(browserCaptureReady(sample, expected), false);
  }
});

test('capture waits for real bounds synchronization and asks for a new frame only after the exact freshness refusal', async () => {
  const moving = ready();
  moving.native.child.viewport.width = 499;
  const settled = ready();
  let reads = 0;
  let requests = 0;
  const result = await freshBrowserCapture(
    async () => (++reads === 1 ? moving : settled),
    async () => {
      assert.ok(
        reads >= 2,
        'capture must not start before viewport synchronization',
      );
      if (++requests === 1)
        throw Error(
          "page.evaluate: Error: Error invoking remote method 'circle:browser-capture': Error: the page changed during capture; take a new browser_screenshot",
        );
      return capture();
    },
    expected,
    { stableMs: 0, intervalMs: 0 },
  );
  assert.equal(requests, 2);
  assert.equal(result.capture.dataUrl, 'fresh capture');
  assert.equal(result.rejected.length, 1);
});

test('capture preserves unrelated errors without repeating a request', async () => {
  for (const message of [
    'browser changed during capture',
    'capture compositor unavailable',
    'unexpected error: the page changed during capture; take a new browser_screenshot',
  ]) {
    const error = Error(message);
    let requests = 0;
    await assert.rejects(
      freshBrowserCapture(
        async () => ready(),
        async () => {
          requests++;
          throw error;
        },
        expected,
        { stableMs: 0 },
      ),
      (actual) => actual === error,
    );
    assert.equal(requests, 1);
  }
});

test('a matching but still resizing viewport must stay unchanged before capture', async () => {
  const first = ready();
  const resized = ready();
  resized.renderer.rect.width = 499;
  resized.native.child.bounds.width = 499;
  resized.native.child.viewport.width = 499;
  let reads = 0;
  let changedAt;
  let requests = 0;
  const result = await freshBrowserCapture(
    async () => {
      if (++reads === 1) return first;
      changedAt ??= Date.now();
      return resized;
    },
    async () => {
      requests++;
      assert.ok(reads >= 3);
      assert.ok(Date.now() - changedAt >= 100);
      return capture();
    },
    expected,
  );
  assert.equal(requests, 1);
  assert.equal(result.capture.dataUrl, 'fresh capture');
});

test('an unshown native window times out with its last actual visibility', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let read;
  const entered = new Promise((resolve) => {
    read = resolve;
  });
  const pending = waitDesktopReady(
    async () => {
      read();
      return { visible: false };
    },
    (state) => state.visible,
    { label: 'test native window shown', stableMs: 0 },
  );
  const rejected = assert.rejects(pending, (error) => {
    assert.match(error.message, /timed out after 10000ms/);
    assert.equal(error.readiness.last.visible, false);
    return true;
  });
  await entered;
  await Promise.resolve();
  t.mock.timers.tick(10000);
  await rejected;
});

test('a returned frame cannot hide a changed URL or layout', async () => {
  let reads = 0;
  let requests = 0;
  await assert.rejects(
    freshBrowserCapture(
      async () => {
        const sample = ready();
        if (++reads > 1) sample.state.url = 'http://changed/';
        return sample;
      },
      async () => {
        requests++;
        return capture();
      },
      expected,
      { stableMs: 0 },
    ),
    /readiness changed after capture/,
  );
  assert.equal(requests, 1);
});

test('a stalled IPC stays bounded and cannot initiate a late capture', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveRead;
  let started;
  let requests = 0;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const pending = freshBrowserCapture(
    () => {
      started();
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    },
    async () => {
      requests++;
      return capture();
    },
    expected,
  );
  const rejected = assert.rejects(pending, /timed out after 10000ms/);
  await entered;
  t.mock.timers.tick(10000);
  await rejected;
  resolveRead(ready());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests, 0);
});

test('a freshness refusal after the shared deadline never initiates another capture', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejectCapture;
  let started;
  let requests = 0;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const pending = freshBrowserCapture(
    async () => ready(),
    () => {
      requests++;
      started();
      return new Promise((_resolve, reject) => {
        rejectCapture = reject;
      });
    },
    expected,
    { stableMs: 0 },
  );
  const rejected = assert.rejects(pending, /timed out after 10000ms/);
  await entered;
  t.mock.timers.tick(10000);
  await rejected;
  rejectCapture(
    Error('the page changed during capture; take a new browser_screenshot'),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests, 1);
});
