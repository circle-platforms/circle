import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, saveSettings, trustFolder } from '../src/settings.js';
import { backgroundMcpConnection } from '../src/mcp_loader.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import { sha256, computeObjectDigest } from '../src/knowledge/canonical.js';
import {
  prepareKnowledgeShare,
  syncMapping,
  KnowledgeShareRefused,
} from '../src/knowledge/sharing.js';
import {
  AuthorizedServer,
  unsignedUploadRefusal,
} from './fixtures/knowledge-sync/authorized-server.js';
import { scratch, cleanup } from './helpers.js';
const signal = new AbortController().signal;
async function world(
  t: Parameters<typeof scratch>[0],
  decision: 'approve' | 'reject' | 'always' = 'approve',
  renamedTools = false,
) {
  const root = scratch(t, 'circle-share-'),
    home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    userHome = join(root, 'user');
  for (const path of [home, workspace, userHome]) mkdirSync(path);
  const server = new AuthorizedServer(join(root, 'peer'));
  server.renamedTools = renamedTools;
  await server.start();
  cleanup(t, () => server.close());
  const connection = {
    name: 'selected',
    url: server.origin + '/mcp',
    transport: 'streamable_http' as const,
    headers: { authorization: 'Bearer ' + server.token },
  };
  const settings = trustFolder(defaultSettings(), workspace);
  settings.mcp_servers = [connection];
  settings.knowledge_sync = {
    server: 'selected',
    binding: backgroundMcpConnection(home, connection, () => ({})).binding,
  };
  saveSettings(settings, home);
  const replies: ConstructorParameters<typeof ScriptedModel>[0] = [],
    model = new ScriptedModel(replies);
  let asked = 0;
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings,
    model,
    headless: true,
    integrations: true,
    bundledExtensions: false,
    approve: async () => {
      asked++;
      return decision;
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  const service = new KnowledgeService(home),
    objects: any[] = [],
    directory = randomUUID();
  const add = (kind: string, body: unknown) => {
    const value = { schema: 'personal-sync-object@1', kind, body };
    objects.push(value);
    return computeObjectDigest(value);
  };
  add('directory_revision', {
    item_id: directory,
    parents: [],
    parent_directory: null,
    name: '',
  });
  const raw = Buffer.from('合成事实\n'),
    bytes = add('bytes', { bytes_base64: raw.toString('base64') }),
    source = add('source_revision', {
      item_id: randomUUID(),
      parents: [],
      directory_id: directory,
      name: '合成原文.txt',
      media_type: 'text/plain',
      size: raw.length,
      raw_sha256: sha256(raw),
      chunks: [bytes],
    }),
    quote = add('bytes', {
      bytes_base64: Buffer.from('合成事实').toString('base64'),
    });
  const item = randomUUID(),
    object = add('entry_revision', {
      item_id: item,
      parents: [],
      directory_id: directory,
      content: {
        kind: 'observation',
        statement: '合成事实支持本机副本保留',
        data: {},
        applicability: null,
      },
      grounds: [
        { source, quotation: quote, parser: 'text@1', selector: 'l/1' },
      ],
    });
  const snapshot = service
    .prepare({ expected_head: null, objects })
    .commit(signal);
  await runtime.knowledge.synchronize();
  const prepare = () =>
    prepareKnowledgeShare({
      service,
      connection: runtime.knowledge,
      binding: () => settings.knowledge_sync.binding,
      snapshot: service.withStore((s) => s.head!),
      object,
      teamPath: '/',
      signal,
    });
  return {
    home,
    server,
    runtime,
    service,
    settings,
    replies,
    model,
    item,
    object,
    snapshot,
    prepare,
    asked: () => asked,
  };
}
for (const decision of ['approve', 'reject', 'always'] as const)
  test(
    'knowledge sharing in auto mode requires the person: ' + decision,
    async (t) => {
      const w = await world(t, decision);
      w.runtime.setMode('auto');
      const snapshot = w.service.withStore((s) => s.head!);
      w.replies.push(
        {
          message: {
            id: 'proposal',
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'share',
                name: 'knowledge_share',
                args: { snapshot, object: w.object },
              },
            ],
          },
        },
        { message: { id: 'done', role: 'assistant', content: 'done' } },
      );
      await w.runtime.harness.run('share knowledge with the team');
      assert.equal(w.asked(), 1);
      assert.equal(w.server.shareCalls.length, decision === 'approve' ? 1 : 0);
      const result = w.model.requests[1]!.messages.find(
        (m) => m.role === 'tool',
      )!;
      assert.equal(result.status, decision === 'approve' ? 'success' : 'error');
    },
  );
test('version-3 receipt pages rebuild an exact share mapping without guessing a reference', async (t) => {
  const w = await world(t);
  w.service.withStore((s) => s.syncWrite('projection', null));
  const mapping = syncMapping(
    w.service,
    w.settings.knowledge_sync.binding,
    w.item,
    w.object,
  );
  assert.match(mapping.reference, /^tree:/);
  const prepared = await w.prepare();
  assert.equal(w.server.shareCalls.length, 0);
  const result = await prepared.run();
  assert.equal(result.shared, true);
  assert.match(result.reference!, /^tree:/);
});
test('a local edit or a failed native qualification cannot dispatch a prepared team share', async (t) => {
  const w = await world(t),
    prepared = await w.prepare();
  w.service
    .prepareMemory({
      expected_head: w.service.withStore((s) => s.head),
      title: 'concurrent',
      markdown: 'new',
    })
    .commit(signal);
  await assert.rejects(prepared.run(), /knowledge-changed/);
  assert.equal(w.server.shareCalls.length, 0);
  await w.runtime.knowledge.synchronize();
  w.server.knowledgeEntries.forEach((e) => (e.status = 'unverified'));
  await assert.rejects(
    (await w.prepare()).run(),
    /knowledge-remote-unavailable/,
  );
  assert.equal(w.server.shareCalls.length, 1);
});

test('an unsigned-upload refusal crosses the real MCP and desktop boundary verbatim without retry or local mutation', async (t) => {
  const w = await world(t);
  const { DesktopKnowledge } = await import(
    new URL('../apps/desktop/src/knowledge-service.ts', import.meta.url).href
  );
  const desktop = new DesktopKnowledge();
  const row = (
    await desktop.execute(w.runtime, { op: 'list', section: 'knowledge' })
  ).rows.find((r: any) => r.kind === 'entry');
  const before = w.service.withStore((s) => s.head);
  const prepare = () =>
    desktop.execute(w.runtime, {
      op: 'prepare',
      action: 'share',
      id: row.id,
      token: row.token,
    });
  const preview = await prepare();
  w.server.shareRefusal = {
    ...unsignedUploadRefusal,
    message:
      '  ' + unsignedUploadRefusal.message + '\n<服务器原文> & unchanged  ',
    fix: unsignedUploadRefusal.fix + '\n保留  两个空格',
  };
  const refusal = await desktop.execute(w.runtime, {
    op: 'confirm',
    ticket: preview.ticket,
    confirmed: true,
  });
  assert.deepEqual(refusal, { shareRefusal: w.server.shareRefusal });
  assert.equal(w.server.shareCalls.length, 1);
  assert.equal(
    w.service.withStore((s) => s.head),
    before,
  );
  assert.notEqual(w.runtime.knowledge.status().condition, 'offline');
  await assert.rejects(
    desktop.execute(w.runtime, {
      op: 'confirm',
      ticket: preview.ticket,
      confirmed: true,
    }),
    /knowledge-preview-expired/,
  );
  w.server.shareRefusal = undefined;
  const next = await prepare();
  assert.equal(w.server.shareCalls.length, 1);
  assert.deepEqual(
    await desktop.execute(w.runtime, {
      op: 'confirm',
      ticket: next.ticket,
      confirmed: true,
    }),
    {
      shared: true,
      reference:
        'tree:' + sha256('team') + '/@' + w.server.knowledgeEntries[0].entry,
    },
  );
  assert.equal(w.server.shareCalls.length, 2);
});

test('every refusal the server explains shows its text as it came, with credential checks intact', async (t) => {
  const w = await world(t);
  w.server.shareRefusal = { ...unsignedUploadRefusal };
  await assert.rejects((await w.prepare()).run(), (error: unknown) => {
    assert.ok(error instanceof KnowledgeShareRefused);
    assert.deepEqual(error.refusal, unsignedUploadRefusal);
    assert.equal(
      error.message,
      `refused: ${unsignedUploadRefusal.message} ${unsignedUploadRefusal.fix}`,
    );
    return true;
  });
  // Any code, including one this client does not know, is shown with the server's words.
  for (const code of ['SOURCE_RETRYABLE', 'SHARE_SOMETHING_NEWER']) {
    w.server.shareRefusal = { ...unsignedUploadRefusal, code };
    await assert.rejects((await w.prepare()).run(), (error: unknown) => {
      assert.ok(error instanceof KnowledgeShareRefused);
      assert.equal(error.refusal.code, code);
      assert.equal(error.refusal.message, unsignedUploadRefusal.message);
      return true;
    });
  }
  // An oversized fix is not shown; the explanation still is.
  w.server.shareRefusal = { ...unsignedUploadRefusal, fix: 'x'.repeat(8001) };
  await assert.rejects((await w.prepare()).run(), (error: unknown) => {
    assert.ok(error instanceof KnowledgeShareRefused);
    assert.equal(error.refusal.fix, '');
    assert.equal(error.message, `refused: ${unsignedUploadRefusal.message}`);
    return true;
  });
  // No explanation at all: the generic failure, never invented text.
  w.server.shareRefusal = { ...unsignedUploadRefusal, message: '' };
  await assert.rejects(
    (await w.prepare()).run(),
    /knowledge-remote-unavailable/,
  );
  w.server.shareRefusal = {
    ...unsignedUploadRefusal,
    message: 'Password=Syn9theticRejectedValue',
  };
  await assert.rejects((await w.prepare()).run(), (error: unknown) => {
    assert.match(String(error), /credential rejected/);
    assert.doesNotMatch(String(error), /Syn9thetic/);
    return true;
  });
});

test('a server that declares its share tools in a discovery document is used as declared', async (t) => {
  const w = await world(t, 'approve', true);
  assert.equal(w.runtime.knowledge.status().discovery, 'document');
  const prepared = await w.prepare();
  const result = await prepared.run();
  assert.equal(result.shared, true);
  // The declared tool carried the entry; the earlier names and the pre-read were not used.
  assert.deepEqual(
    w.server.toolNames.filter((name) => name !== 'team_preferences'),
    ['team_share'],
  );
  assert.equal(w.server.shareCalls.length, 1);
  assert.ok(w.server.shareCalls[0].share_entry.entry);
});
test('without a discovery document the fixed shapes are used and status says so', async (t) => {
  const w = await world(t);
  assert.equal(w.runtime.knowledge.status().discovery, 'fallback');
  await (await w.prepare()).run();
  assert.ok(w.server.toolNames.includes('get_nodes'));
  assert.ok(w.server.toolNames.includes('upload_file'));
});
