import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeSyncObject } from '../src/knowledge/canonical.js';
import { KnowledgeStore } from '../src/knowledge/store.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import { KnowledgeSync, syncedBefore } from '../src/knowledge/sync.js';
import { SyncHttp } from '../src/knowledge/sync-http.js';
import { mergeSnapshots } from '../src/knowledge/merge.js';
import { FakeSyncServer } from './fixtures/knowledge-sync/fake-server.js';
import { scratch, cleanup } from './helpers.js';

const signal = new AbortController().signal;
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const envelope = (kind: string, body: unknown) => ({
  schema: 'personal-sync-object@1',
  kind,
  body,
});
async function world(t: TestContext) {
  const root = scratch(t, 'circle-sync-');
  const server = new FakeSyncServer(join(root, 'peer'));
  await server.listen();
  cleanup(t, () => server.close());
  const homes = [join(root, 'a'), join(root, 'b')];
  let now = server.now;
  const clients = homes.map(
    (home) =>
      new KnowledgeSync(
        home,
        new SyncHttp(server.origin, async () => server.token),
        { binding: 'synthetic-account', now: () => now },
      ),
  );
  cleanup(t, async () => {
    for (const c of clients) await c.close();
  });
  const advance = (n = 16000) => {
    now += n;
    server.now = now;
  };
  const memory = (
    which: number,
    title: string,
    item_id?: string,
    markdown = title,
  ) => {
    const service = new KnowledgeService(homes[which]!);
    return service.withStore((store) =>
      service
        .prepareMemory({
          expected_head: store.head,
          title,
          markdown,
          ...(item_id ? { item_id } : {}),
        })
        .commit(signal),
    );
  };
  const rows = (which: number) =>
    new KnowledgeService(homes[which]!).withStore((s) => s.items());
  return { server, homes, clients, advance, memory, rows };
}

test('two HTTP clients exchange exact objects, offline changes, conflicts and explicit resolution', async (t) => {
  const w = await world(t);
  w.memory(0, '共同原文');
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  const item = w.rows(0).find((i) => i.kind === 'memory_revision')!.item_id;
  w.memory(0, '客户端甲修改', item);
  w.memory(1, '客户端乙修改', item);
  w.advance();
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  assert.equal(w.clients[1]!.status.condition, 'conflicted');
  assert.equal(w.rows(1).find((i) => i.item_id === item)!.heads.length, 2);
  const before = w.rows(1).find((i) => i.item_id === item)!.heads;
  w.memory(1, '本人选定', item);
  w.advance();
  await w.clients[1]!.runOnce();
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'synced');
  const local = new KnowledgeStore(w.homes[0]!);
  cleanup(t, () => local.close());
  const head = w.rows(0).find((i) => i.item_id === item)!.heads[0]!;
  const object = local.read(head);
  assert.equal(object.kind, 'memory_revision');
  assert.deepEqual('parents' in object.body ? object.body.parents : [], before);
  assert.deepEqual(local.readBytes(head), w.server.store.readBytes(head));
  assert.ok(
    w.server.calls.every(
      (c) => c.headers.authorization === 'Bearer synthetic-sync-token',
    ),
  );
  assert.ok(w.server.calls.every((c) => !c.headers.cookie));
});

test('an account has synced on this device once a sync of it finished, whatever account is selected later', async (t) => {
  const w = await world(t);
  const home = w.homes[0]!;
  assert.equal(syncedBefore(home, 'synthetic-account'), false);
  w.memory(0, '首次同步');
  assert.equal(syncedBefore(home, 'synthetic-account'), false);
  await w.clients[0]!.runOnce();
  assert.ok(w.clients[0]!.status.lastSyncedAt);
  // Another account takes over the journal; this one's record stays
  const store = new KnowledgeStore(home);
  try {
    store.syncWrite('active', { binding: 'other-account', base: null });
  } finally {
    store.close();
  }
  assert.equal(syncedBefore(home, 'synthetic-account'), true);
  assert.equal(syncedBefore(home, 'other-account'), false);
});

test('a device that synced before the record existed counts by its current journal', (t) => {
  const home = scratch(t, 'circle-sync-before-');
  // A device without a knowledge store has synced nothing, and nothing is created to answer
  assert.equal(syncedBefore(home, 'earlier-account'), false);
  assert.equal(existsSync(join(home, 'knowledge')), false);
  const store = new KnowledgeStore(home);
  try {
    store.syncWrite('active', {
      binding: 'earlier-account',
      lastSyncedAt: '2026-11-01T00:00:00.000Z',
    });
  } finally {
    store.close();
  }
  assert.equal(syncedBefore(home, 'earlier-account'), true);
  assert.equal(syncedBefore(home, 'another-account'), false);
});

test('a sync the person asks for during the back-off after a failure is tried at once, unless the server set the wait (#522)', async (t) => {
  const w = await world(t);
  const client = w.clients[0]!;
  w.memory(0, '退避');
  await client.runOnce();
  const asked = () => w.server.calls.filter((c) => c.route === 'state').length;
  // The service is away: Circle backs off, and its own loop waits that out
  w.server.errorNext = {
    route: 'state',
    status: 503,
    code: 'SOURCE_RETRYABLE',
  };
  await assert.rejects(client.runOnce(true));
  assert.equal(client.status.condition, 'offline');
  const before = asked();
  await client.runOnce();
  assert.equal(asked(), before);
  // Asked for: sent now (a sync asks for the state more than once)
  await client.runOnce(true);
  assert.ok(asked() > before);
  assert.equal(client.status.condition, 'synced');
  // The server asks for a minute: an asked-for sync waits too, and is sent once the minute is over
  w.server.errorNext = {
    route: 'state',
    status: 429,
    code: 'SYNC_RATE_LIMITED',
    retry: 60,
  };
  await assert.rejects(client.runOnce(true));
  const limited = asked();
  await client.runOnce(true);
  assert.equal(asked(), limited);
  w.advance(61000);
  await client.runOnce(true);
  assert.ok(asked() > limited);
  assert.equal(client.status.condition, 'synced');
});

test('a sync the person asks for after an answer Circle could not use tries again (#522)', async (t) => {
  const w = await world(t);
  const client = w.clients[0]!;
  w.memory(0, '无效');
  await client.runOnce();
  const asked = () => w.server.calls.filter((c) => c.route === 'state').length;
  w.server.errorNext = {
    route: 'state',
    status: 422,
    code: 'SUBMISSION_SCHEMA_VIOLATION',
  };
  await assert.rejects(client.runOnce(true));
  assert.equal(client.status.condition, 'invalid');
  // Paused: neither its own loop nor a plain retry sends anything
  const before = asked();
  await client.runOnce(true);
  assert.equal(asked(), before);
  await client.retryInvalid();
  await client.runOnce(true);
  assert.ok(asked() > before);
  assert.equal(client.status.condition, 'synced');
});

test('different stable identities merge as a union and repeated idle polls reuse the snapshot', async (t) => {
  const w = await world(t);
  w.memory(0, '基础');
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  w.memory(0, '仅甲');
  w.memory(1, '仅乙');
  w.advance();
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  w.advance();
  await w.clients[0]!.runOnce();
  assert.equal(w.rows(0).filter((i) => i.kind === 'memory_revision').length, 3);
  const head = w.server.store.head;
  w.advance();
  await w.clients[0]!.runOnce();
  assert.equal(w.server.store.head, head);
});

for (const route of ['upload', 'commit'] as const)
  test(`a lost ${route} reply resumes from its durable receipt after reopening`, async (t) => {
    const w = await world(t);
    w.memory(0, '合成');
    w.server.dropNext = route;
    await assert.rejects(w.clients[0]!.runOnce());
    const count = w.server.calls.filter((c) => c.route === route).length;
    await w.clients[0]!.close();
    w.advance();
    const client = new KnowledgeSync(
      w.homes[0]!,
      new SyncHttp(w.server.origin, async () => w.server.token),
      { binding: 'synthetic-account', now: () => w.server.now },
    );
    cleanup(t, () => client.close());
    await client.runOnce();
    assert.equal(client.status.condition, 'synced');
    assert.ok(w.server.calls.some((c) => c.route === 'operation'));
    if (route === 'commit')
      assert.equal(
        w.server.calls.filter((c) => c.route === 'commit').length,
        count + 1,
      ); // Recovery is queried, then an idle confirmation may commit with a fresh operation.
    const operations = w.server.calls
      .filter((c) => c.route === route)
      .map((c) => c.body.operation_id);
    assert.equal(new Set(operations).size, operations.length);
  });

test('an unacknowledged request replays exactly when the receipt does not exist', async (t) => {
  const w = await world(t);
  w.memory(0, '合成');
  w.server.errorNext = {
    route: 'upload',
    status: 503,
    code: 'SOURCE_RETRYABLE',
  };
  await assert.rejects(w.clients[0]!.runOnce());
  const first = w.server.calls.find((c) => c.route === 'upload')!.body;
  w.advance();
  await w.clients[0]!.runOnce();
  const second = w.server.calls.filter((c) => c.route === 'upload')[1]!.body;
  assert.deepEqual(second, first);
  assert.equal(w.clients[0]!.status.condition, 'synced');
});

test('CAS competition downloads and merges the new peer state instead of rebasing a stale request', async (t) => {
  const w = await world(t);
  w.memory(0, '基础');
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  w.memory(0, '甲');
  w.memory(1, '乙');
  w.advance();
  let raced = false;
  w.server.onRequest = async (route) => {
    if (route === 'commit' && !raced) {
      raced = true;
      await w.clients[1]!.runOnce();
    }
  };
  await assert.rejects(w.clients[0]!.runOnce(), /SYNC_VERSION_CONFLICT/);
  w.server.onRequest = null;
  w.advance();
  await w.clients[0]!.runOnce();
  assert.equal(w.rows(0).filter((i) => i.kind === 'memory_revision').length, 3);
  const requests = w.server.calls
    .filter((c) => c.route === 'commit')
    .map((c) => c.body);
  assert.notEqual(requests.at(-1).snapshot, requests[1].snapshot);
});

test('frozen inventory pagination and small batches download complete canonical graphs', async (t) => {
  const w = await world(t);
  w.server.limits.page_items = 2;
  w.server.limits.batch_objects = 2;
  w.server.limits.batch_bytes = 3000;
  for (let i = 0; i < 4; i++) w.memory(0, `合成 ${i}`);
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  assert.equal(w.rows(1).filter((i) => i.kind === 'memory_revision').length, 4);
  assert.ok(w.server.calls.filter((c) => c.route === 'inventory').length > 2);
  assert.ok(
    w.server.calls
      .filter((c) => c.route === 'upload')
      .every((c) => c.body.objects.length <= 2),
  );
  assert.ok(
    w.server.calls
      .filter((c) => c.route === 'upload')
      .every(
        (c) =>
          c.body.objects.reduce(
            (n: number, o: any) =>
              n + Buffer.from(o.bytes_base64, 'base64').length,
            0,
          ) <= 3000,
      ),
  );
});

test('hash damage never publishes a downloaded partial graph', async (t) => {
  const w = await world(t);
  w.memory(0, '真实持久效果');
  await w.clients[0]!.runOnce();
  w.server.damageDownload = true;
  await assert.rejects(w.clients[1]!.runOnce());
  assert.deepEqual(w.rows(1), []);
  assert.equal(
    new KnowledgeService(w.homes[1]!).withStore((s) => s.head),
    null,
  );
});

test('429 backs off until the server minimum, and capacity never counts as a success', async (t) => {
  const w = await world(t);
  w.memory(0, '合成');
  w.server.errorNext = {
    route: 'upload',
    status: 429,
    code: 'SYNC_RATE_LIMITED',
    retry: 60,
  };
  await assert.rejects(w.clients[0]!.runOnce());
  const count = w.server.calls.length;
  w.advance(30000);
  await w.clients[0]!.runOnce();
  assert.equal(w.server.calls.length, count);
  w.advance(30000);
  w.server.errorNext = {
    route: 'upload',
    status: 422,
    code: 'SPACE_CAPACITY_EXCEEDED',
  };
  await assert.rejects(w.clients[0]!.runOnce());
  assert.equal(w.clients[0]!.status.condition, 'capacity');
  assert.equal(w.clients[0]!.status.lastSyncedAt, null);
});

for (const change of ['local', 'epoch'] as const)
  test(`${change} stops old operations and requires explicit reinitialization`, async (t) => {
    const w = await world(t);
    w.memory(0, '保留本机');
    w.server.dropNext = 'upload';
    await assert.rejects(w.clients[0]!.runOnce());
    const before = new KnowledgeService(w.homes[0]!).withStore((s) => s.head);
    if (change === 'local') w.server.mode = 'local';
    else w.server.epoch = crypto.randomUUID();
    w.advance();
    await w.clients[0]!.runOnce();
    const writes = w.server.calls.filter((c) =>
      ['upload', 'commit'].includes(c.route),
    ).length;
    w.server.mode = 'hub';
    w.advance();
    await w.clients[0]!.runOnce();
    assert.equal(
      w.server.calls.filter((c) => ['upload', 'commit'].includes(c.route))
        .length,
      writes,
    );
    assert.equal(
      new KnowledgeService(w.homes[0]!).withStore((s) => s.head),
      before,
    );
    await w.clients[0]!.confirmBinding();
    await w.clients[0]!.runOnce();
    assert.equal(w.clients[0]!.status.condition, 'synced');
  });

test('a different host binding cannot send the old account queue', async (t) => {
  const w = await world(t);
  w.memory(0, '合成');
  await w.clients[0]!.runOnce();
  const count = w.server.calls.length;
  const other = new KnowledgeSync(
    w.homes[0]!,
    new SyncHttp(w.server.origin, async () => w.server.token),
    { binding: 'different-account', now: () => w.server.now },
  );
  cleanup(t, () => other.close());
  await other.runOnce();
  assert.equal(w.server.calls.length, count);
  assert.equal(other.status.condition, 'paused');
});

test('401 pauses without an automatic login loop or timestamp promotion', async (t) => {
  const w = await world(t);
  w.memory(0, '合成');
  w.server.token = 'different-synthetic-token';
  // Hold the original credential rather than consulting the mutable test peer.
  const client = new KnowledgeSync(
    scratch(t, 'circle-sync-401-'),
    new SyncHttp(w.server.origin, async () => 'synthetic-sync-token'),
    { binding: 'account', now: () => w.server.now },
  );
  cleanup(t, () => client.close());
  await assert.rejects(client.runOnce());
  const count = w.server.calls.length;
  w.advance();
  await client.runOnce();
  assert.equal(w.server.calls.length, count);
  assert.equal(client.status.lastSyncedAt, null);
});

test('the pinned merge vectors retain all non-ancestor heads without semantic merging', (t) => {
  const store = new KnowledgeStore(scratch(t, 'circle-merge-vector-'));
  cleanup(t, () => store.close());
  const data = JSON.parse(
    readFileSync(
      new URL('./fixtures/knowledge-sync/v1/scenarios.json', import.meta.url),
      'utf8',
    ),
  );
  const memory = data.objects.slice(0, 5);
  assert.deepEqual(
    store.putBatch(
      memory.map((x: { canonical: string; id: string }) =>
        decodeSyncObject(Buffer.from(x.canonical), x.id),
      ),
    ),
    memory.map((x: { id: string }) => x.id),
  );
  const root = store.put(
    envelope('directory_revision', {
      item_id: '22222222-2222-4222-8222-222222222222',
      parents: [],
      name: '',
      parent_directory: null,
    }),
  );
  const snapshot = (heads: string[]) => {
    const byId = new Map<string, string[]>();
    for (const h of heads) {
      const o: any = store.read(h);
      byId.set(o.body.item_id, [...(byId.get(o.body.item_id) ?? []), h]);
    }
    const page = store.put(
      envelope('inventory_page', {
        items: [
          {
            kind: 'directory_revision',
            item_id: '22222222-2222-4222-8222-222222222222',
            heads: [root],
          },
          ...[...byId].map(([item_id, heads]) => ({
            kind: 'memory_revision',
            item_id,
            heads: heads.sort(),
          })),
        ],
      }),
    );
    return store.put(envelope('snapshot', { parents: [], pages: [page] }));
  };
  for (const m of data.merges) {
    const merged = mergeSnapshots(
      store,
      snapshot(m.left),
      snapshot(m.right),
      snapshot(m.base),
    );
    assert.deepEqual(
      store
        .graph(merged)
        .items.filter((i) => i.kind === 'memory_revision')
        .flatMap((i) => i.heads)
        .sort(),
      m.expected_heads,
    );
  }
});

test('mode changes use an exact person preview, preserve local bytes and recover a lost purge receipt', async (t) => {
  const w = await world(t);
  w.memory(0, '保留副本');
  await w.clients[0]!.runOnce();
  const before = new KnowledgeService(w.homes[0]!).withStore((s) => s.head);
  const declined = await w.clients[0]!.changeMode(
    'local',
    async (impact) => {
      assert.equal(impact.personal_bytes, 123);
      assert.equal(impact.pending_shares, null);
      return false;
    },
    signal,
  );
  assert.equal(declined, false);
  assert.equal(w.server.calls.filter((c) => c.route === 'mode').length, 0);
  w.server.dropNext = 'mode';
  await assert.rejects(
    w.clients[0]!.changeMode('local', async () => true, signal),
  );
  assert.equal(w.server.mode, 'local');
  w.advance();
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'local');
  assert.equal(
    new KnowledgeService(w.homes[0]!).withStore((s) => s.head),
    before,
  );
  await w.clients[0]!.changeMode('hub', async () => true, signal);
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'synced');
});

test('a changed mode preview needs fresh approval rather than substituting the current state', async (t) => {
  const w = await world(t);
  await assert.rejects(
    w.clients[0]!.changeMode(
      'local',
      async () => {
        w.server.revision++;
        return true;
      },
      signal,
    ),
    /version changed/,
  );
  assert.equal(w.server.calls.filter((c) => c.route === 'mode').length, 0);
});

test('a local edit during a remote commit is retained as a pending descendant', async (t) => {
  const w = await world(t);
  w.memory(0, '开始');
  let edited = false;
  w.server.onRequest = (route) => {
    if (route === 'commit' && !edited) {
      edited = true;
      w.memory(0, '提交期间的新记忆');
    }
  };
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'pending');
  assert.equal(w.rows(0).filter((i) => i.kind === 'memory_revision').length, 2);
  w.server.onRequest = null;
  w.advance();
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'synced');
});

test('an expired resumable session restarts without discarding accepted local revisions', async (t) => {
  const w = await world(t);
  w.memory(0, '离线保留');
  w.server.dropNext = 'upload';
  await assert.rejects(w.clients[0]!.runOnce());
  w.advance(86400001);
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'synced');
  assert.equal(w.server.calls.filter((c) => c.route === 'session').length, 2);
});

test('an explicit abort is a real HTTP operation and keeps the local head intact', async (t) => {
  const w = await world(t);
  w.memory(0, '保留');
  w.server.dropNext = 'upload';
  await assert.rejects(w.clients[0]!.runOnce());
  const before = new KnowledgeService(w.homes[0]!).withStore((s) => s.head);
  await w.clients[0]!.abortTransfer();
  assert.ok(w.server.calls.some((c) => c.route === 'abort'));
  assert.equal(
    new KnowledgeService(w.homes[0]!).withStore((s) => s.head),
    before,
  );
});

test('ownership loss while HTTP is in flight fences all following requests and local publication', async (t) => {
  const w = await world(t);
  w.memory(0, '保留');
  const observer = new KnowledgeStore(w.homes[0]!);
  cleanup(t, () => observer.close());
  w.server.onRequest = (route) => {
    if (route === 'upload') {
      w.advance(31000);
      assert.equal(
        observer.acquireSyncLease('successor', w.server.now, 30000),
        true,
      );
    }
  };
  await assert.rejects(w.clients[0]!.runOnce(), /lease lost/);
  assert.equal(w.server.calls.filter((c) => c.route === 'commit').length, 0);
  assert.equal(w.clients[0]!.status.lastSyncedAt, null);
  observer.releaseSyncLease('successor');
  w.server.onRequest = null;
  w.advance();
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'synced');
});

test('cancellation keeps the uncertain operation for later receipt recovery', async (t) => {
  const w = await world(t);
  w.memory(0, '中断');
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  w.server.onRequest = async (route) => {
    if (route === 'upload') {
      entered();
      await gate;
    }
  };
  const run = w.clients[0]!.runOnce();
  await reached;
  const canceled = w.clients[0]!.cancel();
  release();
  await assert.rejects(run, /canceled/);
  await canceled;
  assert.equal(w.clients[0]!.status.lastSyncedAt, null);
  w.server.onRequest = null;
  w.advance();
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'synced');
});

test('HTTP redirects never send the bearer to another origin', async (t) => {
  const w = await world(t);
  const { createServer } = await import('node:http');
  let reached = 0;
  const receiver = createServer((req, res) => {
    reached++;
    res.end('{}');
  });
  receiver.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => receiver.once('listening', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => receiver.close(() => resolve())),
  );
  const port = (receiver.address() as { port: number }).port;
  const redirect = createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/` });
    res.end();
  });
  redirect.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => redirect.once('listening', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => redirect.close(() => resolve())),
  );
  const transport = new SyncHttp(
    `http://127.0.0.1:${(redirect.address() as { port: number }).port}`,
    async () => 'synthetic-sync-token',
  );
  await assert.rejects(transport.request('state', { signal }));
  assert.equal(reached, 0);
});

test('same-name directory moves keep both identities and suppress their dependent search projections', async (t) => {
  const w = await world(t);
  w.memory(0, '基础');
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  const root = w.rows(0).find((i) => i.kind === 'directory_revision')!.item_id;
  const folder = (which: number, id: string) => {
    const service = new KnowledgeService(w.homes[which]!);
    return service.withStore((s) =>
      service
        .prepare({
          expected_head: s.head,
          objects: [
            envelope('directory_revision', {
              item_id: id,
              parents: [],
              parent_directory: root,
              name: '同名',
            }),
          ],
        })
        .commit(signal),
    );
  };
  folder(0, uuid(70));
  folder(1, uuid(71));
  w.advance();
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  assert.equal(w.clients[1]!.status.condition, 'conflicted');
  new KnowledgeService(w.homes[1]!).withStore((s) => {
    const g = s.graph(s.head!);
    assert.equal(g.paths.get(uuid(70)), null);
    assert.equal(g.paths.get(uuid(71)), null);
    assert.equal(g.conflicts.filter((c) => c.structural).length, 2);
  });
  const service = new KnowledgeService(w.homes[1]!);
  service.withStore((s) => {
    const row = s.items().find((i) => i.item_id === uuid(71))!;
    service
      .prepare({
        expected_head: s.head,
        objects: [
          envelope('directory_revision', {
            item_id: uuid(71),
            parents: row.heads,
            parent_directory: root,
            name: '另一个目录',
          }),
        ],
      })
      .commit(signal);
  });
  w.advance();
  await w.clients[1]!.runOnce();
  assert.equal(w.clients[1]!.status.condition, 'synced');
});

test('deletion versus edit retains competing heads, while deleting a directory does not delete a concurrent child', async (t) => {
  const w = await world(t);
  w.memory(0, '基础');
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  const item = w.rows(0).find((i) => i.kind === 'memory_revision')!.item_id;
  const service = new KnowledgeService(w.homes[0]!);
  service.withStore((s) =>
    service
      .prepareMemory({ expected_head: s.head, item_id: item, delete: true })
      .commit(signal),
  );
  w.memory(1, '乙编辑', item);
  w.advance();
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  assert.equal(w.rows(1).find((i) => i.item_id === item)!.heads.length, 2);
  assert.equal(w.clients[1]!.status.condition, 'conflicted');
});

test('operation idempotency refuses the same key with changed payload', async (t) => {
  const w = await world(t);
  w.memory(0, '合成');
  await w.clients[0]!.runOnce();
  const call = w.server.calls.find((c) => c.route === 'upload')!,
    session = call.url.split('/')[5]!;
  const transport = new SyncHttp(w.server.origin, async () => w.server.token);
  const exact = await transport.request('upload', {
    id: session,
    body: call.body,
    signal,
  });
  assert.ok(exact);
  const changed = { ...call.body, objects: [call.body.objects[0]] };
  if (changed.objects.length === call.body.objects.length)
    changed.objects[0] = { ...changed.objects[0], bytes_base64: 'e30=' };
  await assert.rejects(
    transport.request('upload', { id: session, body: changed, signal }),
    /IDEMPOTENCY_MISMATCH/,
  );
});

test('local edits change an observed synced status back to pending', async (t) => {
  const w = await world(t);
  w.memory(0, '初始');
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'synced');
  w.memory(0, '新增');
  assert.equal(w.clients[0]!.status.condition, 'pending');
});

test('a deleted directory and concurrent added child are preserved as structural conflicts', async (t) => {
  const w = await world(t);
  w.memory(0, '基础');
  const root = w.rows(0).find((i) => i.kind === 'directory_revision')!.item_id;
  const service = new KnowledgeService(w.homes[0]!);
  service.withStore((s) =>
    service
      .prepare({
        expected_head: s.head,
        objects: [
          envelope('directory_revision', {
            item_id: uuid(80),
            parents: [],
            parent_directory: root,
            name: '目录',
          }),
        ],
      })
      .commit(signal),
  );
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  service.withStore((s) => {
    const row = s.items().find((i) => i.item_id === uuid(80))!;
    service
      .prepare({
        expected_head: s.head,
        objects: [
          envelope('deletion', {
            item_id: uuid(80),
            parents: row.heads,
            target_kind: 'directory_revision',
          }),
        ],
      })
      .commit(signal);
  });
  const peer = new KnowledgeService(w.homes[1]!);
  peer.withStore((s) =>
    peer
      .prepareMemory({
        expected_head: s.head,
        directory_id: uuid(80),
        title: '新子项',
        markdown: '保留',
      })
      .commit(signal),
  );
  w.advance();
  await w.clients[0]!.runOnce();
  await w.clients[1]!.runOnce();
  peer.withStore((s) => {
    const g = s.graph(s.head!);
    assert.equal(g.items.filter((i) => i.kind === 'memory_revision').length, 2);
    assert.ok(g.conflicts.some((c) => c.item_id === uuid(80) && c.structural));
    const child = g.items.find(
      (i) =>
        i.kind === 'memory_revision' &&
        s.read(i.heads[0]!).kind === 'memory_revision' &&
        (s.read(i.heads[0]!) as any).body.title === '新子项',
    )!;
    assert.ok(g.conflicts.some((c) => c.item_id === child.item_id));
  });
  assert.equal(w.clients[1]!.status.condition, 'conflicted');
});

test('two drivers in one home cannot dispatch concurrent sync requests', async (t) => {
  const w = await world(t);
  w.memory(0, '单持有者');
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  w.server.onRequest = async (route) => {
    if (route === 'upload') {
      entered();
      await gate;
    }
  };
  const run = w.clients[0]!.runOnce();
  await reached;
  const other = new KnowledgeSync(
    w.homes[0]!,
    new SyncHttp(w.server.origin, async () => w.server.token),
    { binding: 'synthetic-account', now: () => w.server.now },
  );
  cleanup(t, () => other.close());
  const count = w.server.calls.length;
  await assert.rejects(other.runOnce(), /another process/);
  assert.equal(w.server.calls.length, count);
  release();
  await run;
});

test('a lost enable-sync receipt is recoverable even from a previously paused local mode', async (t) => {
  const w = await world(t);
  w.memory(0, '保留');
  await w.clients[0]!.runOnce();
  await w.clients[0]!.changeMode('local', async () => true, signal);
  assert.equal(w.clients[0]!.status.condition, 'local');
  w.server.dropNext = 'mode';
  await assert.rejects(
    w.clients[0]!.changeMode('hub', async () => true, signal),
  );
  w.advance();
  await w.clients[0]!.runOnce();
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'synced');
});

test('background start dispatches actual effects, cancellation stops scheduling, and observers cannot break receipt publication', async (t) => {
  const w = await world(t);
  w.memory(0, '后台');
  let synced!: () => void;
  const completed = new Promise<void>((resolve) => (synced = resolve));
  const client = new KnowledgeSync(
    w.homes[0]!,
    new SyncHttp(w.server.origin, async () => w.server.token),
    {
      binding: 'synthetic-account',
      now: () => w.server.now,
      onStatus: (status) => {
        if (status.condition === 'synced') synced();
        throw Error('synthetic observer fault');
      },
    },
  );
  cleanup(t, () => client.close());
  client.start();
  await completed;
  await client.cancel();
  assert.equal(client.status.condition, 'synced');
  const count = w.server.calls.length;
  client.notify();
  await Promise.resolve();
  assert.equal(w.server.calls.length, count);
});

test('all commit-result pages are validated and durably retained before advancing the baseline', async (t) => {
  const w = await world(t);
  w.server.resultPageSize = 1;
  w.memory(0, '甲');
  w.memory(0, '乙');
  await w.clients[0]!.runOnce();
  const operation = w.server.calls.find((c) => c.route === 'commit')!.body
    .operation_id;
  new KnowledgeService(w.homes[0]!).withStore((s) => {
    let count = 0;
    for (let i = 0; i < 10; i++) {
      const page = s.syncRead<any>(
        `result:${w.server.epoch}:${operation}:${i}`,
      );
      if (!page) break;
      count += page.projections?.length ?? 0;
    }
    assert.equal(count, 3);
  });
  assert.equal(w.clients[0]!.status.condition, 'synced');
});

test('download restart retains accepted object bytes while keeping the projection atomic', async (t) => {
  const w = await world(t);
  w.memory(0, '甲');
  w.memory(0, '乙');
  await w.clients[0]!.runOnce();
  w.server.limits.batch_objects = 1;
  let downloads = 0;
  w.server.onRequest = (route) => {
    if (route === 'download' && ++downloads === 2)
      w.server.errorNext = {
        route: 'download',
        status: 503,
        code: 'SOURCE_RETRYABLE',
      };
  };
  await assert.rejects(w.clients[1]!.runOnce());
  const first = w.server.calls.find((c) => c.route === 'download')!.body
    .objects[0];
  new KnowledgeService(w.homes[1]!).withStore((s) => {
    assert.equal(s.has(first), true);
    assert.equal(s.head, null);
  });
  const before = w.server.calls.filter(
    (c) => c.route === 'download' && c.body.objects.includes(first),
  ).length;
  w.server.onRequest = null;
  w.advance();
  await w.clients[1]!.runOnce();
  assert.equal(
    w.server.calls.filter(
      (c) => c.route === 'download' && c.body.objects.includes(first),
    ).length,
    before,
  );
  assert.equal(w.clients[1]!.status.condition, 'synced');
});

test('401 during an explicitly approved mode change pauses its pending operation without background replay', async (t) => {
  const w = await world(t);
  w.memory(0, '本机保留');
  await w.clients[0]!.runOnce();
  await w.clients[0]!.changeMode('local', async () => true, signal);
  w.server.errorNext = {
    route: 'mode',
    status: 401,
    code: 'SOURCE_UNAVAILABLE',
  };
  await assert.rejects(
    w.clients[0]!.changeMode('hub', async () => true, signal),
  );
  assert.equal(w.clients[0]!.status.condition, 'login-required');
  const count = w.server.calls.length;
  w.advance();
  await w.clients[0]!.runOnce();
  assert.equal(w.server.calls.length, count);
});
