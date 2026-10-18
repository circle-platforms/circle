import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  rename,
  symlink,
  realpath,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceGrants } from '../src/files.ts';

test('real ten thousand files paginate beyond old 2k and depth12 limits without reading bodies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let group = 0; group < 20; group++) {
    const folder = join(root, 'folder-' + group);
    await mkdir(folder);
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        writeFile(join(folder, `file-${index}.ts`), 'export const fixture=1;'),
      ),
    );
  }
  const deep = join(root, ...Array.from({ length: 16 }, (_, i) => 'd' + i));
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, 'deep.txt'), 'deep');
  await writeFile(join(root, '.env'), 'never list credentials');
  const grants = new WorkspaceGrants();
  let page = await grants.open(root);
  const files = [...page.files];
  let pages = 1;
  assert.equal(page.files.length, 2000);
  assert.equal(page.complete, false);
  assert.equal(page.truncated, false);
  while (page.nextCursor) {
    page = await grants.nextPage(page.nextCursor);
    assert.ok(page.files.length <= 2000);
    files.push(...page.files);
    pages++;
  }
  assert.equal(pages, 6);
  assert.equal(files.length, 10001);
  assert.equal(new Set(files.map((f) => f.path)).size, 10001);
  assert.equal(page.complete, true);
  assert.equal(page.truncated, false);
  assert.ok(files.some((f) => f.path.endsWith('deep.txt')));
  assert.ok(!files.some((f) => f.path === '.env'));
  const last = files.find((f) => f.path.endsWith('deep.txt'))!;
  assert.equal((await grants.read(page.id, last.id)).content, 'deep');
  const refreshed = await grants.open(root);
  const previous = new Map(files.map((file) => [file.path, file.id]));
  assert.equal(refreshed.id, page.id);
  assert.ok(
    refreshed.files.every((file) => previous.get(file.path) === file.id),
    'refresh preserves granted document identity',
  );
  if (refreshed.nextCursor) await grants.cancel(refreshed.nextCursor);
});

test('listing cursors reject replay, cancellation, replaced roots and stale owners', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-discovery-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selected = join(root, 'selected');
  await mkdir(selected);
  await Promise.all(
    Array.from({ length: 2001 }, (_, i) =>
      writeFile(join(selected, `${i}.txt`), 'fixture'),
    ),
  );
  const grants = new WorkspaceGrants();
  let active = true;
  const check = () => {
    if (!active) throw Error('owner changed');
  };
  const page = await grants.open(selected, check);
  active = false;
  await assert.rejects(grants.nextPage(page.nextCursor!), /owner changed/);
  await assert.rejects(grants.nextPage(page.nextCursor!), /expired/);
  active = true;
  const cancelled = await grants.open(selected);
  await grants.cancel(cancelled.nextCursor!);
  await assert.rejects(grants.nextPage(cancelled.nextCursor!), /expired/);
  const replaced = await grants.open(selected);
  await rename(selected, join(root, 'old'));
  await mkdir(selected);
  await assert.rejects(grants.nextPage(replaced.nextCursor!), /root changed/);
  await assert.rejects(
    grants.read(replaced.id, replaced.files[0]!.id),
    /root changed/,
  );
});

test('discovery excludes directory links and explicitly discloses unreadable or bounded subtrees', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-discovery-exclusions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selected = join(root, 'selected'),
    outside = join(root, 'outside');
  await mkdir(selected);
  await mkdir(outside);
  await writeFile(join(outside, 'foreign.txt'), 'outside');
  await symlink(
    outside,
    join(selected, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await mkdir(join(selected, 'node_modules'));
  await writeFile(join(selected, 'node_modules', 'skip.txt'), 'ignored');
  await writeFile(join(selected, 'allowed.txt'), 'allowed');
  const page = await new WorkspaceGrants().open(selected);
  assert.deepEqual(
    page.files.map((f) => f.path),
    ['allowed.txt'],
  );
  assert.equal(page.complete, true);
});

test('LiveRuntime consumes real discovery pages and reports the loaded whole catalog', async (t) => {
  const { LiveRuntime } = await import('../../workbench/src/model/live.ts');
  const { createFixtures } =
    await import('../../workbench/src/preview/fixtures.ts');
  const root = await mkdtemp(join(tmpdir(), 'circle-discovery-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 2105 }, (_, i) =>
      writeFile(join(root, `${i}.ts`), 'fixture'),
    ),
  );
  const grants = new WorkspaceGrants();
  const snapshot = createFixtures();
  const session = snapshot.sessions.find(
    (s) => s.id === snapshot.activeSessionId,
  )!;
  const wid = session.workspaceId;
  snapshot.runtime = { connected: true, configured: true };
  let pages = 0;
  const host = {
    onRuntime: () => () => {},
    listWorkspace: async (_id: string, cursor?: string) => {
      pages++;
      return cursor ? grants.nextPage(cursor) : grants.open(root);
    },
  } as unknown as import('../src/contracts.ts').DesktopBridge;
  const runtime = new LiveRuntime(host, { seq: 1, connected: true, snapshot });
  t.after(() => runtime.dispose());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error('catalog completion event missing')),
      10000,
    );
    const stop = runtime.subscribe(() => {
      if (runtime.getSnapshot().fileListings?.[wid]?.complete) {
        clearTimeout(timer);
        stop();
        resolve();
      }
    });
  });
  assert.equal(pages, 2);
  assert.equal(
    runtime.getSnapshot().files.filter((f) => f.workspaceId === wid).length,
    2105,
  );
  assert.deepEqual(runtime.getSnapshot().fileListings?.[wid], {
    loaded: 2105,
    complete: true,
    truncated: false,
  });
});

test('late discovery page cannot append after same-workspace session switch', async () => {
  const { LiveRuntime } = await import('../../workbench/src/model/live.ts');
  const { createFixtures } =
    await import('../../workbench/src/preview/fixtures.ts');
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const first = snapshot.sessions.find(
    (s) => s.id === snapshot.activeSessionId,
  )!;
  const other = { ...structuredClone(first), id: 'other-discovery-session' };
  snapshot.sessions.push(other);
  let resolveFirst!: (
    page: import('../src/contracts.ts').NativeWorkspace,
  ) => void;
  const blocked = new Promise<import('../src/contracts.ts').NativeWorkspace>(
    (resolve) => (resolveFirst = resolve),
  );
  let update!: (
    value: import('../src/runtime-protocol.ts').RuntimeUpdate,
  ) => void;
  let count = 0;
  const host = {
    onRuntime: (cb: typeof update) => {
      update = cb;
      return () => {};
    },
    listWorkspace: async () =>
      ++count === 1
        ? blocked
        : {
            id: 'new-grant',
            name: 'new',
            path: '/fixture',
            files: [],
            truncated: false,
            complete: true,
          },
  } as unknown as import('../src/contracts.ts').DesktopBridge;
  const runtime = new LiveRuntime(host, { seq: 1, connected: true, snapshot });
  try {
    update({
      seq: 2,
      connected: true,
      snapshot: { ...structuredClone(snapshot), activeSessionId: other.id },
    });
    await new Promise((resolve) => setImmediate(resolve));
    resolveFirst({
      id: 'old-grant',
      name: 'old',
      path: '/fixture',
      files: [{ id: 'late', path: 'late-secret.txt', language: 'text' }],
      truncated: false,
      complete: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(count, 2);
    assert.equal(
      runtime.getSnapshot().files.some((f) => f.path === 'late-secret.txt'),
      false,
    );
    assert.equal(
      runtime.getSnapshot().fileListings?.[other.workspaceId]?.loaded,
      0,
    );
  } finally {
    runtime.dispose();
  }
});

test('discovery budgets disclose omitted entries and cancellation never becomes successful completion', async (t) => {
  const { discoverWorkspace } = await import('../src/workspace-discovery.ts');
  const root = await mkdtemp(join(tmpdir(), 'circle-discovery-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'one.txt'), 'one');
  await writeFile(join(root, 'two.txt'), 'two');
  const state = { truncated: false };
  const paths = [];
  for await (const path of discoverWorkspace(
    await realpath(root),
    state,
    () => {},
    {
      files: 1,
      entries: 100,
      depth: 20,
    },
  ))
    paths.push(path);
  assert.equal(paths.length, 1);
  assert.equal(state.truncated, true);
  let active = true;
  const iterator = discoverWorkspace(
    await realpath(root),
    { truncated: false },
    () => {
      if (!active) throw Error('cancelled owner');
    },
  );
  await iterator.next();
  active = false;
  await assert.rejects(iterator.next(), /cancelled owner/);
});

test('paged refresh keeps the already loaded late document until its refreshed page arrives', async () => {
  const { LiveRuntime } = await import('../../workbench/src/model/live.ts');
  const { createFixtures } =
    await import('../../workbench/src/preview/fixtures.ts');
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const sid = snapshot.activeSessionId;
  let receive!: (
    value: import('../src/runtime-protocol.ts').RuntimeUpdate,
  ) => void;
  let count = 0,
    resolveLast!: (page: import('../src/contracts.ts').NativeWorkspace) => void,
    reached!: () => void;
  const requested = new Promise<void>((resolve) => (reached = resolve));
  const pending = new Promise<import('../src/contracts.ts').NativeWorkspace>(
    (resolve) => (resolveLast = resolve),
  );
  const base = {
    id: 'grant',
    name: 'files',
    path: '/fixture',
    truncated: false,
  };
  const host = {
    onRuntime: (listener: typeof receive) => {
      receive = listener;
      return () => {};
    },
    listWorkspace: async () => {
      if (++count === 1)
        return {
          ...base,
          files: [{ id: 'late', path: 'z.txt', language: 'text' }],
        };
      if (count === 2)
        return {
          ...base,
          files: [{ id: 'early', path: 'a.txt', language: 'text' }],
          nextCursor: 'next',
        };
      reached();
      return pending;
    },
  } as unknown as import('../src/contracts.ts').DesktopBridge;
  const runtime = new LiveRuntime(host, { seq: 1, connected: true, snapshot });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const late = runtime.getSnapshot().files.find((f) => f.path === 'z.txt')!;
    assert.ok(late);
    receive({
      seq: 2,
      connected: true,
      snapshot: structuredClone(snapshot),
      event: { kind: 'run_end', sessionId: sid, payload: {} },
    });
    await requested;
    assert.equal(
      runtime.getSnapshot().files.find((f) => f.path === 'z.txt'),
      late,
      'existing document remains mounted while refresh is incomplete',
    );
    resolveLast({
      ...base,
      files: [{ id: 'new-late', path: 'z.txt', language: 'text' }],
      complete: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.getSnapshot().files.length, 2);
  } finally {
    runtime.dispose();
  }
});
