import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, saveSettings, trustFolder } from '../src/settings.js';
import { backgroundMcpConnection } from '../src/mcp_loader.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import { sha256, syncObjectId } from '../src/knowledge/canonical.js';
import {
  prepareKnowledgeShare,
  syncMapping,
} from '../src/knowledge/sharing.js';
import { AuthorizedServer } from './fixtures/knowledge-sync/authorized-server.js';
import { scratch, cleanup } from './helpers.js';
const signal = new AbortController().signal;
async function world(
  t: Parameters<typeof scratch>[0],
  decision: 'approve' | 'reject' | 'always' = 'approve',
) {
  const home = scratch(t),
    workspace = scratch(t),
    server = new AuthorizedServer(scratch(t));
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
    userHome: scratch(t),
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
    return syncObjectId(value);
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
  await assert.rejects(w.prepare(), /knowledge-share-unverified/);
  assert.equal(w.server.shareCalls.length, 0);
});
