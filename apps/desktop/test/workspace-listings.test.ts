import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceGrants } from '../src/files.ts';
import { WorkspaceListings } from '../src/workspace-listings.ts';

test('main and pop-out discover the same real workspace independently', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-window-listings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 2001 }, (_, i) =>
      writeFile(join(root, `${i}.txt`), `file ${i}`),
    ),
  );
  const grants = new WorkspaceGrants();
  const listings = new WorkspaceListings(grants);
  const main = {},
    popout = {};
  const list = (from: object, cursor?: string) =>
    listings.list(from, 'session', 'workspace', root, cursor, () => {});
  const [first, other] = await Promise.all([list(main), list(popout)]);
  assert.equal(first.files.length, 2000);
  assert.equal(other.files.length, 2000);
  assert.notEqual(first.nextCursor, other.nextCursor);
  await assert.rejects(list(main, other.nextCursor), /not owned/);
  const last = await list(main, first.nextCursor);
  assert.equal(last.files.length, 1);
  assert.equal(last.complete, true);
  const file = last.files[0]!;
  assert.equal(
    (await grants.read(last.id, file.id)).content,
    `file ${file.path.slice(0, -4)}`,
  );
  await listings.close(popout);
  await assert.rejects(grants.nextPage(other.nextCursor!), /expired/);
  await assert.rejects(list(popout, other.nextCursor), /not owned/);
});

test('same-window refresh revokes an in-flight listing without affecting another window', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const grants = {
    async open(path: string, check = () => {}) {
      if (++calls === 1) {
        entered();
        await blocked;
      }
      check();
      return { id: path, name: path, path, files: [], truncated: false };
    },
    async nextPage() {
      throw Error('unexpected pagination');
    },
    async cancel() {},
  };
  const listings = new WorkspaceListings(grants);
  const main = {},
    popout = {};
  const list = (from: object) =>
    listings.list(from, 'session', 'workspace', 'path', undefined, () => {});
  const old = list(main);
  const rejected = assert.rejects(old, /superseded/);
  await started;
  await Promise.all([list(main), list(popout)]);
  release();
  await rejected;
});

test('session or trust changes still revoke in-flight discovery', async () => {
  let active = true;
  const check = () => {
    if (!active) throw Error('file listing owner changed');
  };
  const grants = {
    async open(path: string, assertActive = () => {}) {
      active = false;
      assertActive();
      return { id: path, name: path, path, files: [], truncated: false };
    },
    async nextPage() {
      throw Error('unexpected pagination');
    },
    async cancel() {},
  };
  await assert.rejects(
    new WorkspaceListings(grants).list({}, 's', 'w', 'path', undefined, check),
    /owner changed/,
  );
});

test('closing a window while a page returns cancels its new continuation', async () => {
  const from = {};
  const cancelled: string[] = [];
  const grants = {
    async open(path: string) {
      await listings.close(from);
      return {
        id: path,
        name: path,
        path,
        files: [],
        truncated: false,
        nextCursor: 'closing-window-cursor',
      };
    },
    async nextPage() {
      throw Error('unexpected pagination');
    },
    async cancel(cursor: string) {
      cancelled.push(cursor);
    },
  };
  const listings = new WorkspaceListings(grants);
  await assert.rejects(
    listings.list(from, 's', 'w', 'path', undefined, () => {}),
    /superseded/,
  );
  assert.deepEqual(cancelled, ['closing-window-cursor']);
});
