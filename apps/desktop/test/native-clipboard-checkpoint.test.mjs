import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  readFile,
  stat,
  chmod,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeClipboardCheckpoint,
  readClipboardCheckpoint,
  removeClipboardCheckpoint,
} from './helpers/native-clipboard-checkpoint.mjs';
import { fileSymlinkRefusal } from './helpers/symlink-support.mjs';
import {
  preserveNativeClipboard,
  restoreNativeClipboard,
  nativeClipboardCheckpointMetadata,
} from './helpers/native-clipboard.mjs';
const payload = [
  [
    {
      type: 'text/plain',
      readType: 'text/plain',
      kind: 'bytes',
      mime: 'text/plain',
      bytes: [0, 1, 255],
    },
    {
      type: 'electron application/bookmark',
      readType: 'electron application/bookmark',
      kind: 'bookmark',
      value: { title: 'synthetic', url: 'https://example.invalid' },
    },
  ],
];
test('private checkpoint has exact formats, bytes, bounded data and owner-only permissions', async () => {
  const record = await writeClipboardCheckpoint(payload);
  try {
    assert.deepEqual(await readClipboardCheckpoint(record), payload);
    if (process.platform !== 'win32') {
      assert.equal((await stat(record.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(record.file)).mode & 0o777, 0o600);
    }
    const data = JSON.parse(await readFile(record.file, 'utf8'));
    data.payload[0][0].bytes[0] = 5;
    await writeFile(record.file, JSON.stringify(data));
    await assert.rejects(readClipboardCheckpoint(record), /integrity/);
  } finally {
    await removeClipboardCheckpoint(record);
  }
});
test('symlink, unsafe permissions and unsupported/oversized data fail closed', async (t) => {
  const record = await writeClipboardCheckpoint(payload);
  const original = record.file + '.original';
  try {
    if (process.platform !== 'win32') {
      await chmod(record.file, 0o644);
      await assert.rejects(readClipboardCheckpoint(record), /permissions/);
      await chmod(record.file, 0o600);
    }
    await t.test(
      'a symlinked checkpoint is unsafe',
      { skip: await fileSymlinkRefusal() },
      async () => {
        await writeFile(original, 'not a checkpoint', { mode: 0o600 });
        await rm(record.file);
        await symlink(original, record.file);
        await assert.rejects(readClipboardCheckpoint(record), /unsafe/);
      },
    );
    await assert.rejects(
      writeClipboardCheckpoint([
        [{ type: 'x', readType: 'x', kind: 'unknown' }],
      ]),
      /unsupported/,
    );
  } finally {
    await removeClipboardCheckpoint(record);
  }
});
test('real EISDIR before durable commit rejects capture and caller never overwrites clipboard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'circle-eisdir-'));
  let mutations = 0;
  class ClipboardItem {
    constructor(data) {
      this.data = data;
      this.types = Object.keys(data);
    }
    getType(type) {
      return this.data[type];
    }
  }
  const original = new ClipboardItem({
    'text/plain': new Blob(['synthetic original']),
  });
  const app = {
    evaluate: async (callback, arg) =>
      callback(
        {
          ClipboardItem,
          clipboard: {
            read: async () => [original],
            write: async () => {
              mutations++;
            },
          },
        },
        arg,
      ),
  };
  try {
    await assert.rejects(
      async () => {
        await preserveNativeClipboard(app, {
          checkpointWriter: () =>
            writeFile(directory, 'cannot commit checkpoint'),
        });
        mutations++;
      },
      (e) => e.code === 'EISDIR',
    );
    assert.equal(mutations, 0);
    assert.equal(globalThis.__circleJourneyClipboard?.size ?? 0, 0);
  } finally {
    await rm(directory, { recursive: true });
  }
});
test('restore readback mismatch keeps both durable file and main checkpoint for retry', async () => {
  let current;
  let mismatch = false;
  class ClipboardItem {
    constructor(data) {
      this.data = data;
      this.types = Object.keys(data);
    }
    getType(type) {
      return this.data[type];
    }
  }
  current = [
    new ClipboardItem({ 'text/plain': new Blob(['synthetic original']) }),
  ];
  const app = {
    evaluate: async (callback, arg) =>
      callback(
        {
          ClipboardItem,
          clipboard: {
            read: async () => (mismatch ? [] : current),
            write: async (items) => {
              current = items;
            },
          },
        },
        arg,
      ),
  };
  const key = await preserveNativeClipboard(app);
  const record = nativeClipboardCheckpointMetadata(key);
  mismatch = true;
  await assert.rejects(restoreNativeClipboard(app, key), /count/);
  await stat(record.file);
  assert(globalThis.__circleJourneyClipboard.has(key));
  mismatch = false;
  await restoreNativeClipboard(app, key);
  await assert.rejects(stat(record.file), (e) => e.code === 'ENOENT');
});

test('oversized native Blob is rejected before bytes are read or clipboard overwritten', async () => {
  let reads = 0,
    mutations = 0;
  class ClipboardItem {
    constructor(data) {
      this.data = data;
      this.types = Object.keys(data);
    }
    getType(type) {
      return this.data[type];
    }
  }
  const clipboard = {
    read: async () => [
      {
        types: ['image/png'],
        getType: async () => ({
          size: 17 * 1024 * 1024,
          type: 'image/png',
          arrayBuffer: async () => {
            reads++;
            throw Error('must not load oversized payload');
          },
        }),
      },
    ],
    write: async () => {
      mutations++;
    },
  };
  const app = {
    evaluate: async (callback, arg) =>
      callback({ ClipboardItem, clipboard }, arg),
  };
  await assert.rejects(preserveNativeClipboard(app), /byte limit/);
  assert.equal(reads, 0);
  assert.equal(mutations, 0);
});

test('a new live main missing the old key routes only a validated durable checkpoint to recovery', async () => {
  class ClipboardItem {
    constructor(data) {
      this.data = data;
      this.types = Object.keys(data);
    }
    getType(type) {
      return this.data[type];
    }
  }
  const original = new ClipboardItem({
    'text/plain': new Blob(['synthetic prior owner']),
  });
  const old = {
    evaluate: async (callback, arg) =>
      callback(
        { ClipboardItem, clipboard: { read: async () => [original] } },
        arg,
      ),
  };
  const key = await preserveNativeClipboard(old);
  const metadata = nativeClipboardCheckpointMetadata(key);
  const newOwner = {
    evaluate: async () => {
      throw Error('native clipboard checkpoint is unavailable');
    },
  };
  let calls = 0;
  const result = await restoreNativeClipboard(newOwner, key, {
    recover: async (record) => {
      calls++;
      assert.deepEqual(
        await readClipboardCheckpoint(record),
        await readClipboardCheckpoint(metadata),
      );
      return { identityVerified: true };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.method, 'isolated stock Electron');
  await assert.rejects(stat(metadata.file), (e) => e.code === 'ENOENT');
  await assert.rejects(
    restoreNativeClipboard(newOwner, 'missing', {
      recover: async () => {
        calls++;
      },
    }),
    /unavailable/,
  );
  assert.equal(calls, 1);
  globalThis.__circleJourneyClipboard?.delete(key);
  if (!globalThis.__circleJourneyClipboard?.size)
    delete globalThis.__circleJourneyClipboard;
});
