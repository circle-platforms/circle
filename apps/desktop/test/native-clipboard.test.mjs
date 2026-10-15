import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
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
    original.map((item) =>
      item.types.map((type) =>
        process.platform === 'darwin' && type === 'text/html'
          ? 'electron application/osclipboard;format="public.html"'
          : type,
      ),
    ),
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
    await (
      await current[0].getType(
        process.platform === 'darwin'
          ? 'electron application/osclipboard;format="public.html"'
          : 'text/html',
      )
    ).text(),
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

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`clipboard snapshot maps only macOS HTML to its verified raw platform format (${platform})`, async () => {
    const blob = new Blob(['<meta charset="utf-8"><b>exact original</b>'], {
      type: 'text/html',
    });
    let written;
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
      read: async () => [{ types: ['text/html'], getType: async () => blob }],
      write: async (items) => {
        written = items;
      },
    };
    const context = vm.createContext({
      process: { platform },
      clipboard,
      ClipboardItem,
      Map,
      Error,
    });
    const app = {
      evaluate: async (callback, arg) => {
        context.arg = arg;
        return vm.runInContext(
          `(${callback})({clipboard,ClipboardItem},arg)`,
          context,
        );
      },
    };
    const key = await preserveNativeClipboard(app);
    await restoreNativeClipboard(app, key);
    const expected =
      platform === 'darwin'
        ? 'electron application/osclipboard;format="public.html"'
        : 'text/html';
    assert.deepEqual(written[0].types, [expected]);
    assert.equal(
      await (await written[0].getType(expected)).text(),
      await blob.text(),
    );
  });
}

test('failed restoration keeps the original checkpoint and owner alive until explicit retry', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { restoreNativeClipboardWithRecovery } =
    await import('./helpers/native-clipboard.mjs');
  const folder = await mkdtemp(join(tmpdir(), 'circle-clipboard-recovery-'));
  let fail = true,
    failures = 0,
    writes = 0;
  class ClipboardItem {
    constructor(data) {
      this.data = data;
      this.types = Object.keys(data);
    }
    async getType(type) {
      return this.data[type];
    }
  }
  const original = new ClipboardItem({
    'text/plain': new Blob(['private original']),
  });
  const clipboard = {
    read: async () => [original],
    write: async () => {
      writes++;
      if (fail) throw Error('controlled temporary clipboard failure');
    },
  };
  const app = {
    evaluate: async (callback, arg) =>
      callback({ clipboard, ClipboardItem }, arg),
  };
  const key = await preserveNativeClipboard(app);
  try {
    await restoreNativeClipboardWithRecovery(app, key, {
      retryPath: join(folder, 'retry-clipboard'),
      onFailure: async (error) => {
        failures++;
        assert.match(String(error), /controlled/);
        assert.ok(
          globalThis.__circleJourneyClipboard.has(key),
          'failure must retain the only original backup',
        );
        assert.equal(writes, 1);
        fail = false;
        await writeFile(join(folder, 'retry-clipboard'), 'explicit retry');
      },
    });
    assert.equal(failures, 1);
    assert.equal(writes, 2);
    assert.equal(globalThis.__circleJourneyClipboard, undefined);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
