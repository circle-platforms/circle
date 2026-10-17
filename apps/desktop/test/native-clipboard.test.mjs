import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  preserveNativeClipboard,
  restoreNativeClipboard,
} from './helpers/native-clipboard.mjs';

// Simulate Electron's canonical read API after raw macOS HTML restoration.
const canonicalRead = (items) =>
  items.map((item) => ({
    types: item.types.map((type) =>
      type === 'electron application/osclipboard;format="public.html"'
        ? 'text/html'
        : type,
    ),
    getType: (type) =>
      item.getType(
        type === 'text/html' &&
          item.types.includes(
            'electron application/osclipboard;format="public.html"',
          )
          ? 'electron application/osclipboard;format="public.html"'
          : type,
      ),
  }));

test('empty native clipboard read items restore by clearing without constructing an empty ClipboardItem', async () => {
  let constructions = 0;
  let clears = 0;
  let current = [
    { types: [], getType: () => assert.fail('empty item has no data') },
  ];
  class ClipboardItem {
    constructor(data) {
      constructions++;
      if (!Object.keys(data).length)
        throw TypeError('at least one MIME type is required');
    }
  }
  const clipboard = {
    read: async () => canonicalRead(current),
    write: async () => assert.fail('empty checkpoints must not write items'),
    clear: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      current = [];
      clears++;
    },
  };
  const app = {
    evaluate: async (callback, arg) =>
      callback({ clipboard, ClipboardItem }, arg),
  };
  const key = await preserveNativeClipboard(app);
  assert.equal(constructions, 0);
  assert.equal(clears, 0, 'snapshot must not change the clipboard');
  current = [{ types: ['text/plain'] }];
  await restoreNativeClipboard(app, key);
  assert.equal(clears, 1);
  assert.deepEqual(current, []);
  assert.equal(globalThis.__circleJourneyClipboard, undefined);
});

test('empty native items do not discard any typed payload in a mixed checkpoint', async () => {
  const blob = new Blob(['exact private original'], { type: 'text/plain' });
  const bookmark = {
    title: 'private original',
    url: 'https://example.invalid',
  };
  const empty = {
    types: [],
    getType: () => assert.fail('empty item has no data'),
  };
  let current = [
    empty,
    {
      types: ['text/plain', 'electron application/bookmark'],
      getType: async (type) => (type === 'text/plain' ? blob : bookmark),
    },
    empty,
  ];
  class ClipboardItem {
    constructor(data) {
      this.types = Object.keys(data);
      assert.ok(this.types.length, 'Electron rejects empty MIME maps');
      this.data = data;
    }
    async getType(type) {
      return this.data[type];
    }
  }
  const clipboard = {
    read: async () => canonicalRead(current),
    write: async (items) => {
      current = items;
    },
    clear: async () => assert.fail('typed checkpoint must not clear'),
  };
  const app = {
    evaluate: async (callback, arg) =>
      callback({ clipboard, ClipboardItem }, arg),
  };
  const key = await preserveNativeClipboard(app);
  assert.equal(
    current.length,
    3,
    'snapshot must not mutate the original items',
  );
  current = [];
  await restoreNativeClipboard(app, key);
  assert.equal(current.length, 1);
  assert.deepEqual(current[0].types, [
    'text/plain',
    'electron application/bookmark',
  ]);
  assert.equal(
    await (await current[0].getType('text/plain')).text(),
    await blob.text(),
  );
  assert.equal(
    await current[0].getType('electron application/bookmark'),
    bookmark,
  );
  assert.equal(globalThis.__circleJourneyClipboard, undefined);
});

for (const failureMode of ['read', 'getType', 'construction']) {
  test(`clipboard ${failureMode} failure makes no mutation and retains earlier recovery checkpoints`, async () => {
    const blob = new Blob(['original'], { type: 'text/plain' });
    let fail = false;
    let current = [
      {
        types: ['text/plain'],
        getType: async () => {
          if (fail && failureMode === 'getType')
            throw Error('controlled native clipboard failure');
          return blob;
        },
      },
    ];
    let writes = 0;
    class ClipboardItem {
      constructor(data) {
        if (fail && failureMode === 'construction')
          throw Error('controlled native clipboard failure');
        this.data = data;
        this.types = Object.keys(data);
      }
      async getType(type) {
        return this.data[type];
      }
    }
    const clipboard = {
      read: async () => {
        if (fail && failureMode === 'read')
          throw Error('controlled native clipboard failure');
        return canonicalRead(current);
      },
      write: async (items) => {
        current = items;
        writes++;
      },
      clear: async () => assert.fail('typed checkpoint must not clear'),
    };
    const app = {
      evaluate: async (callback, arg) =>
        callback({ clipboard, ClipboardItem }, arg),
    };
    const first = await preserveNativeClipboard(app);
    fail = true;
    await assert.rejects(
      () => preserveNativeClipboard(app),
      /controlled native clipboard failure/,
    );
    assert.equal(writes, 0);
    assert.deepEqual([...globalThis.__circleJourneyClipboard.keys()], [first]);
    fail = false;
    await restoreNativeClipboard(app, first);
    assert.equal(writes, 1);
    assert.equal(
      await (await current[0].getType('text/plain')).text(),
      'original',
    );
    assert.equal(globalThis.__circleJourneyClipboard, undefined);
  });
}

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
    read: async () => canonicalRead(current),
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
