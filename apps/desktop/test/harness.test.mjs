import test from 'node:test';
import assert from 'node:assert/strict';
import { assertViewport, setViewport } from './helpers/viewport.mjs';

test('native viewport checks preserve the requested maximum at each display scale', () => {
  const target = { width: 800, height: 650 };
  for (const scale of [1, 1.25, 1.5, 2]) {
    assertViewport(target, target, scale);
    assertViewport({ width: 799, height: 649 }, target, scale);
    assert.throws(() =>
      assertViewport({ width: 801, height: 650 }, target, scale),
    );
    assert.throws(() =>
      assertViewport({ width: 800, height: 651 }, target, scale),
    );
    assert.throws(() =>
      assertViewport({ width: 798, height: 650 }, target, scale),
    );
  }
});

test('native viewport sizing compensates for measured DPI rounding', async () => {
  const requested = [];
  let actual;
  const app = {
    evaluate: async (_callback, input) => {
      requested.push(input.requested);
      actual = {
        width: input.requested.width + 1,
        height: input.requested.height + 1,
      };
      return { scaleFactor: 1.25, room: { width: 4000, height: 4000 } };
    },
  };
  const page = {
    waitForFunction: async (_callback, input) => {
      assert.ok(
        Math.abs(actual.width - input.expected.width) <= input.rounding,
      );
      assert.ok(
        Math.abs(actual.height - input.expected.height) <= input.rounding,
      );
      return { dispose: async () => {} };
    },
    evaluate: async () => actual,
  };
  const viewport = await setViewport(app, page, { width: 800, height: 650 });
  assert.deepEqual(requested, [
    { width: 800, height: 650 },
    { width: 799, height: 649 },
  ]);
  assert.deepEqual(viewport.actual, { width: 800, height: 650 });
  assert.equal(viewport.scaleFactor, 1.25);
  assert.equal(viewport.attempts, 2);
});

test('native viewport sizing asks a short display for the height it has', async () => {
  const requested = [];
  let actual;
  const app = {
    evaluate: async (_callback, input) => {
      requested.push(input.requested);
      actual = { width: input.requested.width, height: 677 };
      return { scaleFactor: 1, room: { width: 1024, height: 677 } };
    },
  };
  const page = {
    waitForFunction: async (_callback, input) => {
      assert.deepEqual(input.expected, { width: 1024, height: 677 });
      return { dispose: async () => {} };
    },
    evaluate: async () => actual,
  };
  const viewport = await setViewport(app, page, { width: 1024, height: 768 });
  assert.deepEqual(requested, [{ width: 1024, height: 768 }]);
  assert.deepEqual(viewport.target, { width: 1024, height: 677 });
  assert.deepEqual(viewport.actual, { width: 1024, height: 677 });
  assert.equal(viewport.attempts, 1);
});

test('native viewport sizing corrects DPI rounding after fitting to the work area', async () => {
  const sizes = [];
  let actual = { width: 1280, height: 800 };
  const window = {
    show() {},
    getBounds: () => ({ x: 0, y: 0, width: 1293, height: 835 }),
    getSize: () => [actual.width + 13, actual.height + 35],
    getContentSize: () => [actual.width, actual.height],
    setContentSize(width, height) {
      sizes.push({ width, height });
      actual = { width: width + 1, height: height + 1 };
    },
  };
  const app = {
    evaluate: async (callback, input) =>
      callback(
        {
          BrowserWindow: { getAllWindows: () => [window] },
          screen: {
            getDisplayMatching: () => ({
              scaleFactor: 2,
              workAreaSize: { width: 1440, height: 852 },
            }),
          },
        },
        input,
      ),
  };
  const page = {
    waitForFunction: async (_callback, input) => {
      assert.ok(
        Math.abs(actual.width - input.expected.width) <= input.rounding,
      );
      assert.ok(
        Math.abs(actual.height - input.expected.height) <= input.rounding,
      );
      return { dispose: async () => {} };
    },
    evaluate: async () => actual,
  };
  const viewport = await setViewport(
    app,
    page,
    { width: 1400, height: 900 },
    { show: true },
  );
  assert.deepEqual(sizes, [
    { width: 1400, height: 817 },
    { width: 1399, height: 816 },
  ]);
  assert.deepEqual(viewport.target, { width: 1400, height: 817 });
  assert.deepEqual(viewport.actual, viewport.target);
  assert.equal(viewport.attempts, 2);
  assertViewport(viewport.actual, viewport.target, 2);
});

test('native viewport sizing rejects a window that is substantially too small', async () => {
  const app = {
    evaluate: async () => ({
      scaleFactor: 1.25,
      room: { width: 4000, height: 4000 },
    }),
  };
  const page = {
    waitForFunction: async () => ({ dispose: async () => {} }),
    evaluate: async () => ({ width: 780, height: 650 }),
  };
  await assert.rejects(
    setViewport(app, page, { width: 800, height: 650 }),
    /requested at most 800, got 780/,
  );
});
