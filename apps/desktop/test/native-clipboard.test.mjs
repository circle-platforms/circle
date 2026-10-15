import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preserveNativeClipboard,
  restoreNativeClipboard,
} from './helpers/native-clipboard.mjs';
test('native clipboard checkpoints retain every opaque ClipboardItem in main and await atomic restoration', async () => {
  const png = new Blob([new Uint8Array([0, 1, 2, 255])], { type: 'image/png' });
  const original = [
    {
      types: ['image/png', 'text/html'],
      getType: async (type) =>
        type === 'image/png' ? png : new Blob(['<b>original</b>'], { type }),
    },
    {
      types: ['electron application/bookmark'],
      getType: async () => ({
        title: 'private title',
        url: 'https://example.invalid/private',
      }),
    },
  ];
  let current = original;
  let restored = false;
  class ClipboardItem {
    constructor(data) {
      this.data = data;
      this.types = Object.keys(data);
    }
    async getType(type) {
      return this.data[type];
    }
  }
  const clipboard = {
    read: async () => current,
    write: async (items) => {
      assert.ok(
        items.every((item) => item instanceof ClipboardItem),
        'read-only system items must be materialized before write',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      current = items;
      restored = true;
    },
    clear: async () => {
      current = [];
    },
  };
  const app = {
    evaluate: async (callback, arg) =>
      callback({ clipboard, ClipboardItem }, arg),
  };
  const key = await preserveNativeClipboard(app);
  assert.equal(typeof key, 'string');
  assert.ok(!key.includes('original'));
  current = [{ types: ['text/plain'] }];
  await restoreNativeClipboard(app, key);
  assert.equal(restored, true);
  assert.notEqual(current, original);
  assert.deepEqual(
    current.map((item) => item.types),
    original.map((item) => item.types),
  );
  assert.deepEqual(
    [
      ...new Uint8Array(
        await (await current[0].getType('image/png')).arrayBuffer(),
      ),
    ],
    [0, 1, 2, 255],
  );
  assert.equal(
    await (await current[0].getType('text/html')).text(),
    '<b>original</b>',
  );
  assert.equal(globalThis.__circleJourneyClipboard, undefined);
  await assert.rejects(() => restoreNativeClipboard(app, key), /unavailable/);
  current = [];
  const empty = await preserveNativeClipboard(app);
  current = original;
  await restoreNativeClipboard(app, empty);
  assert.deepEqual(current, []);
});
