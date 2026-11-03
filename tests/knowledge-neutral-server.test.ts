// Circle against a knowledge-sync v1 server written only from the specification: the
// server lives at a base its discovery document names, adds members Circle does not know,
// explains its refusals and asks for the account holder's confirmation before a purge.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { join } from 'node:path';
import { KnowledgeService } from '../src/knowledge/service.js';
import { KnowledgeSync } from '../src/knowledge/sync.js';
import { SyncHttp, SyncHttpError } from '../src/knowledge/sync-http.js';
import { discoverServer } from '../src/server_resolution.js';
import {
  NeutralSyncServer,
  NEUTRAL_BASE,
} from './fixtures/knowledge-sync/neutral-server.js';
import { scratch, cleanup } from './helpers.js';

const signal = new AbortController().signal;
async function world(t: TestContext) {
  const root = scratch(t, 'circle-neutral-');
  const server = new NeutralSyncServer();
  await server.listen();
  cleanup(t, () => server.close());
  const homes = [join(root, 'a'), join(root, 'b')];
  let now = Date.now();
  const entry = server.origin + '/mcp';
  const clients = homes.map(
    (home) =>
      new KnowledgeSync(
        home,
        new SyncHttp(
          entry,
          async () => server.token,
          fetch,
          (s) => discoverServer(entry, { signal: s }),
        ),
        { binding: 'synthetic-neutral-account', now: () => now },
      ),
  );
  cleanup(t, async () => {
    for (const c of clients) await c.close();
  });
  const memory = (which: number, title: string, item_id?: string) => {
    const service = new KnowledgeService(homes[which]!);
    return service.withStore((store) =>
      service
        .prepareMemory({
          expected_head: store.head,
          title,
          markdown: title,
          ...(item_id ? { item_id } : {}),
        })
        .commit(signal),
    );
  };
  const titles = (which: number) =>
    new KnowledgeService(homes[which]!).withStore((s) =>
      s
        .items()
        .filter((i) => i.kind === 'memory_revision')
        .map((i) => (s.read(i.heads[0]!) as any).body.title as string)
        .sort(),
    );
  const advance = (ms = 20000) => {
    now += ms;
  };
  return { server, homes, clients, memory, titles, advance };
}

test('two clients sync through a spec-only server at the base its discovery document names', async (t) => {
  const w = await world(t);
  w.memory(0, '甲的记忆');
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'synced');
  await w.clients[1]!.runOnce();
  assert.deepEqual(w.titles(1), ['甲的记忆']);
  w.memory(1, '乙的记忆');
  w.advance();
  await w.clients[1]!.runOnce();
  w.advance();
  await w.clients[0]!.runOnce();
  assert.deepEqual(w.titles(0), ['乙的记忆', '甲的记忆']);
  // Discovery was read from the origin; every sync route went to the declared base.
  assert.equal(w.server.paths[0], '/.well-known/knowledge-sync');
  const sync = w.server.paths.filter(
    (p) => p !== '/.well-known/knowledge-sync',
  );
  assert.ok(sync.length > 10);
  assert.ok(sync.every((p) => p.startsWith(NEUTRAL_BASE + '/')));
  assert.equal(
    w.server.paths.filter((p) => p.startsWith('/api/sync/')).length,
    0,
  );
  // Answers carried members Circle does not know; none was refused.
  assert.equal(w.clients[0]!.status.detail, null);
});

test('an unknown error code is a generic failure that keeps the server detail and recovers', async (t) => {
  const w = await world(t);
  w.memory(0, '记忆');
  w.server.failNext = {
    route: '/clients',
    status: 422,
    body: {
      code: 'SYNC_SOMETHING_NEWER',
      detail: '合成的较新错误说明。',
      hint: { synthetic: true },
    },
  };
  await assert.rejects(w.clients[0]!.runOnce(), (error: unknown) => {
    assert.ok(error instanceof SyncHttpError);
    assert.equal(error.code, 'SYNC_SOMETHING_NEWER');
    assert.equal(error.unknownCode, true);
    assert.equal(error.detail, '合成的较新错误说明。');
    return true;
  });
  // Not paused as invalid: retried later, and the server's words are kept for the person.
  assert.equal(w.clients[0]!.status.condition, 'offline');
  assert.equal(w.clients[0]!.status.detail, '合成的较新错误说明。');
  w.advance(600000);
  await w.clients[0]!.runOnce();
  assert.equal(w.clients[0]!.status.condition, 'synced');
  assert.equal(w.clients[0]!.status.detail, null);
});

test('a purge waits for the account holder to confirm on the server, then the identical request completes', async (t) => {
  const w = await world(t);
  w.memory(0, '要清除的记忆');
  await w.clients[0]!.runOnce();
  await assert.rejects(
    w.clients[0]!.changeMode('local', async () => true, signal),
    (error: unknown) => {
      assert.ok(error instanceof SyncHttpError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'SYNC_PURGE_CONFIRMATION_REQUIRED');
      assert.equal(error.confirmation?.url, w.server.confirmationUrl);
      assert.match(error.detail ?? '', /本人确认/);
      return true;
    },
  );
  const waiting = w.clients[0]!.status;
  assert.equal(waiting.condition, 'paused');
  assert.equal(waiting.confirmation?.url, w.server.confirmationUrl);
  assert.equal(w.server.mode, 'hub');
  // Asking again before confirmation records nothing new and purges nothing.
  w.advance();
  await w.clients[0]!.runOnce().catch(() => {});
  assert.equal(w.server.mode, 'hub');
  const recorded = w.server.purge!;
  w.server.confirmPurge();
  w.advance();
  await w.clients[0]!.runOnce();
  const done = w.clients[0]!.status;
  assert.equal(done.condition, 'local');
  assert.equal(done.mode, 'local');
  assert.equal(done.confirmation, null);
  assert.equal(w.server.mode, 'local');
  // The local copy stays.
  assert.deepEqual(w.titles(0), ['要清除的记忆']);
  assert.ok(recorded.operation);
});

test('an expired purge request is dropped, never performed', async (t) => {
  const w = await world(t);
  w.memory(0, '记忆');
  await w.clients[0]!.runOnce();
  await assert.rejects(
    w.clients[0]!.changeMode('local', async () => true, signal),
  );
  assert.ok(w.clients[0]!.status.confirmation);
  w.advance(11 * 60 * 1000);
  assert.equal(w.clients[0]!.status.confirmation, null);
  await w.clients[0]!.runOnce().catch(() => {});
  w.advance();
  await w.clients[0]!.runOnce().catch(() => {});
  assert.equal(w.server.mode, 'hub');
  assert.notEqual(w.clients[0]!.status.condition, 'local');
});
