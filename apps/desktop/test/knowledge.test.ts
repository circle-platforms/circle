import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import { validateRuntimeCommand } from '../src/runtime-protocol.ts';
import { KnowledgeService } from '../../../src/knowledge/service.ts';
import { itemKey } from '../../../src/knowledge/graph.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { AuthorizedServer } from '../../../tests/fixtures/knowledge-sync/authorized-server.ts';
import { backgroundMcpConnection } from '../../../src/mcp_loader.ts';
const signal = new AbortController().signal;
async function world(t: TestContext, remote = false) {
  const root = mkdtempSync(join(tmpdir(), 'circle-knowledge-desktop-')),
    home = join(root, 'home'),
    workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const settings = trustFolder(defaultSettings(), workspace),
    server = remote ? new AuthorizedServer(join(root, 'peer')) : undefined;
  if (server) {
    await server.start();
    settings.mcp_servers = [
      {
        name: 'selected',
        url: server.origin + '/mcp',
        transport: 'streamable_http',
        headers: { authorization: 'Bearer ' + server.token },
      },
    ];
    settings.knowledge_sync = {
      server: 'selected',
      binding: backgroundMcpConnection(
        home,
        settings.mcp_servers[0] as any,
        () => ({}),
      ).binding,
    };
  }
  saveSettings(settings, home);
  const model = new ScriptedModel([
    {
      message: { id: 'answer', role: 'assistant', content: 'synthetic answer' },
    },
  ]);
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: () => {},
  });
  await controller.initialize();
  t.after(async () => {
    await controller.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (p: any) => {
    const result = await controller.dispatch({
      id: randomUUID(),
      name: 'knowledge',
      payload: p,
      sessionId: controller.snapshot().activeSessionId,
    });
    if (!result.ok) throw Error(result.error);
    return result.data as any;
  };
  return {
    root,
    home,
    workspace,
    controller,
    model,
    call,
    service: new KnowledgeService(home),
    server,
  };
}
const head = (w: Awaited<ReturnType<typeof world>>) =>
  w.service.withStore((s) => s.head);
const memory = (w: Awaited<ReturnType<typeof world>>, text: string) =>
  w.service
    .prepareMemory({
      expected_head: head(w),
      title: '合成偏好',
      markdown: text,
    })
    .commit(signal);

test('public knowledge IPC rejects paths, SQL, URLs, false confirmation and unknown operations', () => {
  const command = (payload: any) => ({
    id: randomUUID(),
    name: 'knowledge',
    payload,
  });
  for (const payload of [
    { op: 'read-anything', path: '/etc/passwd' },
    { op: 'list', home: '/private' },
    { op: 'list', url: 'https://example.test' },
    { op: 'list', sql: 'SELECT * FROM secrets' },
    { op: 'prepare-install', id: 'x', token: 'x', directory: '/tmp/anything' },
    { op: 'list', scope: 'all' },
  ])
    assert.throws(() => validateRuntimeCommand(command(payload)));
  assert.doesNotThrow(() =>
    validateRuntimeCommand(
      command({ op: 'list', section: 'memory', scope: 'personal' }),
    ),
  );
});

test('desktop previews write nothing, reject canceled/stale capabilities and publish only the person-confirmed memory', async (t) => {
  const w = await world(t),
    before = head(w);
  const preview = await w.call({
    op: 'prepare',
    action: 'create-memory',
    title: '偏好',
    text: '不写入拒绝的内容',
  });
  assert.equal(head(w), before);
  await w.call({ op: 'cancel', ticket: preview.ticket });
  await assert.rejects(
    w.call({ op: 'confirm', ticket: preview.ticket, confirmed: true }),
    /preview-expired/,
  );
  assert.equal(head(w), before);
  const stale = await w.call({
    op: 'prepare',
    action: 'create-memory',
    title: 'stale',
    text: 'STALE_BODY',
  });
  memory(w, 'CONCURRENT_BODY');
  await assert.rejects(
    w.call({ op: 'confirm', ticket: stale.ticket, confirmed: true }),
    /knowledge-changed/,
  );
  const accepted = await w.call({
    op: 'prepare',
    action: 'create-memory',
    title: 'approved',
    text: 'APPROVED_BODY',
  });
  await w.call({ op: 'confirm', ticket: accepted.ticket, confirmed: true });
  const list = await w.call({ op: 'list', section: 'memory' });
  assert.equal(list.rows.length, 2);
  const row = list.rows.find((r: any) => r.title === 'approved'),
    detail = await w.call({ op: 'detail', id: row.id, token: row.token });
  assert.equal(detail.text, 'APPROVED_BODY');
  const serialized = JSON.stringify({ list, detail, preview: accepted });
  assert.doesNotMatch(
    serialized,
    /snapshot|directory_id|[a-f0-9]{64}|\/Users\/|knowledge.sqlite|access_token|refresh_token/,
  );
});

test('desktop credential refusal never persists a body or exposes its content through the error', async (t) => {
  const w = await world(t),
    text = 'Password=Syn9theticRejectedValue';
  await assert.rejects(
    w.call({ op: 'prepare', action: 'create-memory', title: 'rejected', text }),
    (error) => {
      assert.equal(String(error), 'Error: knowledge-credential-rejected');
      assert.doesNotMatch(String(error), /Syn9thetic/);
      return true;
    },
  );
  assert.equal(head(w), null);
  assert.equal(
    w.service.withStore((s) => s.items().length),
    0,
  );
});

test('desktop edits preserve content and version reads are capabilities without object IDs', async (t) => {
  const w = await world(t);
  memory(w, 'FIRST');
  let list = await w.call({ op: 'list', section: 'memory' }),
    row = list.rows[0];
  const change = await w.call({
    op: 'prepare',
    action: 'edit',
    id: row.id,
    token: row.token,
    title: '改后的标题',
    text: 'SECOND\n\n保留  空格  ',
  });
  await w.call({ op: 'confirm', ticket: change.ticket, confirmed: true });
  list = await w.call({ op: 'list', section: 'memory' });
  row = list.rows[0];
  const detail = await w.call({ op: 'detail', id: row.id, token: row.token });
  assert.equal(detail.text, 'SECOND\n\n保留  空格  ');
  assert.equal(detail.history.length, 2);
  assert.equal(detail.history[0].current, true);
  const old = await w.call({ op: 'source', id: detail.history[1].token });
  assert.equal(old.text, 'FIRST');
});

test('the real sync mode precheck is shown before any mode write and changed impact cannot reuse its ticket', async (t) => {
  const w = await world(t, true);
  await w.call({ op: 'sync' });
  assert.equal((await w.call({ op: 'settings' })).sync.mode, 'hub');
  const before = w.server!.peer.calls.filter((c) => c.route === 'mode').length;
  const preview = await w.call({
    op: 'prepare',
    action: 'mode',
    mode: 'local',
  });
  assert.deepEqual(preview.impact, {
    bytes: 123,
    grants: 2,
    pending: null,
    teamCopies: 1,
  });
  assert.equal(
    w.server!.peer.calls.filter((c) => c.route === 'mode').length,
    before,
  );
  await w.call({ op: 'cancel', ticket: preview.ticket });
  assert.equal(w.server!.peer.mode, 'hub');
  const stale = await w.call({ op: 'prepare', action: 'mode', mode: 'local' });
  w.server!.peer.modeImpact.personal_bytes = 999;
  await assert.rejects(
    w.call({ op: 'confirm', ticket: stale.ticket, confirmed: true }),
    /knowledge-changed/,
  );
  assert.equal(w.server!.peer.mode, 'hub');
  const accepted = await w.call({
    op: 'prepare',
    action: 'mode',
    mode: 'local',
  });
  await w.call({ op: 'confirm', ticket: accepted.ticket, confirmed: true });
  assert.equal(w.server!.peer.mode, 'local');
  const status = (await w.call({ op: 'settings' })).sync;
  assert.equal(status.mode, 'local');
  assert.equal(status.condition, 'local');
});

test("a mode change the server holds for confirmation says so, and the sync status carries the server's words and its page", async (t) => {
  const w = await world(t, true);
  await w.call({ op: 'sync' });
  const prepared = await w.call({
    op: 'prepare',
    action: 'mode',
    mode: 'local',
  });
  const detail =
    '合成的说明：删除本人副本需要账户持有人确认。到确认页面确认后重试。';
  const url = w.server!.origin + '/console/sync?confirm=purge';
  w.server!.peer.errorNext = {
    route: 'mode',
    status: 403,
    code: 'SYNC_PURGE_CONFIRMATION_REQUIRED',
    detail,
    confirmation: {
      url,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
  };
  // Not "knowledge could not be opened": what the server answered, by its kind
  await assert.rejects(
    w.call({ op: 'confirm', ticket: prepared.ticket, confirmed: true }),
    (error: Error) => error.message === 'knowledge-sync-confirm',
  );
  const status = (await w.call({ op: 'settings' })).sync;
  assert.equal(status.detail, detail);
  assert.equal(status.confirmation?.url, url);
  assert.equal(w.server!.peer.mode, 'hub');
});
test("a sync the server does not take says by kind why, and the status carries the server's own words", async (t) => {
  const detail = '合成的说明：这个账户暂时不能同步。请联系管理员。';
  for (const [answer, kind] of [
    // Busy or away: try again later, as the status's retry does
    [{ status: 503, code: 'SOURCE_RETRYABLE' }, 'knowledge-sync-later'],
    // Refused, with its reason as it came
    [
      { status: 403, code: 'BOUNDARY_POLICY_DENIED', detail },
      'knowledge-sync-refused',
    ],
    // The credential no longer works: sign in again
    [{ status: 401, code: 'SOURCE_UNAVAILABLE' }, 'knowledge-sync-login'],
  ] as const) {
    const w = await world(t, true);
    await w.call({ op: 'sync' });
    w.server!.peer.errorNext = { route: 'state', ...answer };
    await assert.rejects(
      w.call({ op: 'sync' }),
      (error: Error) => error.message === kind,
    );
    const status = (await w.call({ op: 'settings' })).sync;
    assert.equal(status.detail, 'detail' in answer ? detail : null);
    if (answer.status === 401) assert.equal(status.condition, 'login-required');
  }
});

test('native file selection imports exact source bytes and never grants arbitrary renderer paths or private stores', async (t) => {
  const w = await world(t),
    file = join(w.workspace, 'original  source.txt'),
    raw = Buffer.from('\ufeff合成原文\r\n尾随  \r\n');
  writeFileSync(file, raw);
  const selected = { op: 'prepare-import', path: file };
  assert.throws(() =>
    validateRuntimeCommand({
      id: randomUUID(),
      name: 'knowledge',
      payload: selected,
    }),
  );
  const preview = await w.call(selected);
  assert.equal(head(w), null);
  assert.equal(preview.title, 'original  source.txt');
  assert.ok(!JSON.stringify(preview).includes(w.root));
  await w.call({ op: 'confirm', ticket: preview.ticket, confirmed: true });
  w.service.withStore((s) =>
    assert.deepEqual(
      s.sourceBytes(
        s.items().find((i) => i.kind === 'source_revision')!.heads[0]!,
      ),
      raw,
    ),
  );
  writeFileSync(join(w.home, 'private.txt'), 'private app data');
  await assert.rejects(
    w.call({ op: 'prepare-import', path: join(w.home, 'private.txt') }),
    /knowledge-unavailable/,
  );
});

test('workflow registration keeps only a manifest until an independently confirmed file installation', async (t) => {
  const w = await world(t),
    directory = join(w.root, 'selected-workflow');
  mkdirSync(directory);
  const { sha256 } = await import('../../../src/knowledge/canonical.ts');
  const contents = {
    'SKILL.md':
      '---\nname: synthetic-desktop-pack\ndescription: synthetic instructions\n---\nOnly synthetic input.\n',
    'workflow.json': '{}',
    'requirements.json': '{}',
    'checks.json': '{}',
    'slots.schema.json': '{}',
  };
  const manifest = {
    schema: 'pack@1',
    id: 'synthetic-desktop-pack',
    version: '1.0.0',
    kind: 'workflow',
    title: '合成工作流',
    description: '合成的本机检查流程',
    files: Object.entries(contents)
      .map(([path, text]) => ({
        path,
        size: Buffer.byteLength(text),
        sha256: sha256(text),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  // Contract order is UTF-16, independently of the host locale.
  manifest.files.sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const [name, text] of Object.entries(contents))
    writeFileSync(join(directory, name), text);
  writeFileSync(join(directory, 'pack.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'hooks.json'), 'DO_NOT_IMPORT');
  const register = await w.call({ op: 'prepare-register', directory });
  assert.equal(head(w), null);
  await w.call({ op: 'confirm', ticket: register.ticket, confirmed: true });
  let list = await w.call({ op: 'list', section: 'workflows' });
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].installed, false);
  const row = list.rows[0],
    install = await w.call({
      op: 'prepare-install',
      id: row.id,
      token: row.token,
      directory,
    });
  w.service.withStore((s) => assert.equal(s.packInstallations().length, 0));
  await w.call({ op: 'confirm', ticket: install.ticket, confirmed: true });
  list = await w.call({ op: 'list', section: 'workflows' });
  assert.equal(list.rows[0].availability, 'available');
  const { installedPersonalPacks } =
    await import('../../../src/knowledge/packs.ts');
  const installed = installedPersonalPacks(w.home);
  assert.equal(installed.length, 1);
  assert.throws(() =>
    readFileSync(join(installed[0]!.path, '..', 'hooks.json')),
  );
  assert.equal(
    readFileSync(join(directory, 'hooks.json'), 'utf8'),
    'DO_NOT_IMPORT',
  );
});

test('team and shared memory browsing stays read-only and does not add viewed shared text to the next model request', async (t) => {
  const w = await world(t, true);
  w.server!.documents = [
    {
      id: '1'.repeat(64),
      version: '2'.repeat(64),
      title: '团队偏好',
      path: '/',
      markdown: 'TEAM_BROWSE_ONLY',
    },
  ];
  w.server!.sharedDocuments = [
    {
      id: '3'.repeat(64),
      version: '4'.repeat(64),
      title: '共享偏好',
      path: '/',
      markdown: 'PRIVATE_SHARED_VIEW_ONLY',
      space: 'someone-else',
    },
  ];
  const shared = await w.call({
    op: 'list',
    section: 'memory',
    scope: 'shared',
  });
  assert.equal(shared.rows.length, 1);
  assert.equal(shared.rows[0].loaded, false);
  const detail = await w.call({
    op: 'detail',
    id: shared.rows[0].id,
    token: shared.rows[0].token,
  });
  assert.equal(detail.text, 'PRIVATE_SHARED_VIEW_ONLY');
  assert.equal(detail.share, 'unavailable');
  await assert.rejects(
    w.call({
      op: 'prepare',
      action: 'edit',
      id: detail.id,
      token: detail.token,
      text: 'NO_WRITE',
    }),
    /knowledge-changed/,
  );
  const reply = await w.controller.dispatch({
    id: randomUUID(),
    name: 'prompt',
    sessionId: w.controller.snapshot().activeSessionId,
    payload: { text: 'hello' },
  });
  assert.equal(reply.ok, true);
  const { until } = await import('../../../tests/helpers.ts');
  await until(() => w.model.requests.length === 1);
  assert.doesNotMatch(
    w.model.requests[0]!.system,
    /PRIVATE_SHARED_VIEW_ONLY|TEAM_BROWSE_ONLY/,
  );
});

test('personal memory sharing uses a confirmed projection, two-stage remote checks and a distinct team copy', async (t) => {
  const w = await world(t, true);
  memory(w, 'PERSONAL_TO_TEAM');
  await w.call({ op: 'sync' });
  const row = (await w.call({ op: 'list', section: 'memory' })).rows[0],
    detail = await w.call({ op: 'detail', id: row.id, token: row.token });
  assert.equal(detail.share, 'ready');
  const preview = await w.call({
    op: 'prepare',
    action: 'share',
    id: row.id,
    token: row.token,
    teamPath: '/',
  });
  assert.equal(
    w.server!.shareCalls.filter((c) => !c.memory_share?.check_only).length,
    0,
  );
  await w.call({ op: 'confirm', ticket: preview.ticket, confirmed: true });
  assert.equal(
    w.server!.shareCalls.filter((c) => !c.memory_share?.check_only).length,
    1,
  );
  assert.equal(w.server!.documents[0]!.markdown, 'PERSONAL_TO_TEAM');
  const next = await w.call({ op: 'prepare', action: 'mode', mode: 'local' });
  await w.call({ op: 'confirm', ticket: next.ticket, confirmed: true });
  const local = await w.call({ op: 'detail', id: row.id, token: row.token });
  assert.equal(local.share, 'local');
  const count = w.server!.shareCalls.length;
  await assert.rejects(
    w.call({ op: 'prepare', action: 'share', id: row.id, token: row.token }),
    /knowledge-share-local/,
  );
  assert.equal(w.server!.shareCalls.length, count);
});

test('a purge receipt stays pending until a read-only state observation confirms completion', async (t) => {
  const w = await world(t, true);
  memory(w, 'PRESERVE_DURING_PURGE');
  await w.call({ op: 'sync' });
  const retained = head(w);
  w.server!.peer.purgingOnLocal = true;
  const preview = await w.call({
    op: 'prepare',
    action: 'mode',
    mode: 'local',
  });
  await w.call({ op: 'confirm', ticket: preview.ticket, confirmed: true });
  assert.equal((await w.call({ op: 'settings' })).sync.clearing, true);
  w.server!.peer.purging = false;
  const at = w.server!.peer.calls.length;
  await w.call({ op: 'sync' });
  assert.equal((await w.call({ op: 'settings' })).sync.clearing, false);
  assert.equal(head(w), retained);
  assert.ok(w.server!.peer.calls.slice(at).every((c) => c.route === 'state'));
});

test('memory loaded labels reflect the actual bounded prompt, including omitted and partial documents', async (t) => {
  const w = await world(t, true);
  w.server!.chunkBytes = 24000;
  w.server!.pageItems = 10;
  w.server!.documents = [
    {
      id: '1'.repeat(64),
      version: '2'.repeat(64),
      title: 'team first',
      path: '/',
      markdown: 'A'.repeat(23900),
    },
    {
      id: '3'.repeat(64),
      version: '4'.repeat(64),
      title: 'team second',
      path: '/',
      markdown: 'B'.repeat(23900),
    },
  ];
  memory(w, 'PERSONAL_OMITTED_BY_BUDGET');
  await w.call({ op: 'refresh-memory' });
  const team = await w.call({ op: 'list', section: 'memory', scope: 'team' }),
    personal = await w.call({ op: 'list', section: 'memory' });
  assert.ok(team.rows.some((r: any) => r.loadState === 'partial'));
  assert.equal(personal.rows[0].loaded, false);
  assert.equal(personal.rows[0].loadState, 'not-loaded');
});

test('opaque authentication values never leave the worker in knowledge DTOs', async (t) => {
  const w = await world(t);
  const { saveSecret } = await import('../../../src/secrets.ts');
  saveSecret(w.home, 'HIDDEN', 'opaque-synthetic-credential-value');
  memory(w, 'a source returned opaque-synthetic-credential-value');
  const row = (await w.call({ op: 'list', section: 'memory' })).rows[0];
  await assert.rejects(
    w.call({ op: 'detail', id: row.id, token: row.token }),
    (error) => {
      assert.equal(String(error), 'Error: knowledge-credential-rejected');
      return true;
    },
  );
});

test('renderer empty folder selection lists root children and scopes subsequent entry creation to the selected folder', async (t) => {
  const w = await world(t);
  const folder = await w.call({
    op: 'prepare',
    action: 'create-folder',
    title: 'child folder',
    text: '',
  });
  await w.call({ op: 'confirm', ticket: folder.ticket, confirmed: true });
  const root = await w.call({
    op: 'list',
    section: 'knowledge',
    folder: '',
    query: '',
    filter: 'all',
  });
  assert.equal(root.rows.length, 1);
  assert.equal(root.rows[0].kind, 'folder');
  const entry = await w.call({
    op: 'prepare',
    action: 'create-entry',
    text: 'scoped entry',
    destination: root.rows[0].id,
  });
  await w.call({ op: 'confirm', ticket: entry.ticket, confirmed: true });
  assert.equal(
    (await w.call({ op: 'list', section: 'knowledge', folder: '' })).rows
      .length,
    1,
  );
  const children = await w.call({
    op: 'list',
    section: 'knowledge',
    folder: root.rows[0].id,
  });
  assert.equal(children.rows.length, 1);
  assert.equal(children.rows[0].title, 'scoped entry');
});

test('confirmation rechecks current credentials before publishing a previously prepared body', async (t) => {
  const w = await world(t);
  const preview = await w.call({
    op: 'prepare',
    action: 'create-memory',
    title: 'preference',
    text: 'opaque-later-authentication-value',
  });
  const { saveSecret } = await import('../../../src/secrets.ts');
  saveSecret(w.home, 'CHANGED', 'opaque-later-authentication-value');
  await assert.rejects(
    w.call({ op: 'confirm', ticket: preview.ticket, confirmed: true }),
    /knowledge-credential-rejected/,
  );
  assert.equal(head(w), null);
});

test('a library beyond the capability cache limit mints only the returned page and keeps its first rows readable', async (t) => {
  const w = await world(t);
  w.service.withStore((s) =>
    s.apply(null, () => {
      const directory = randomUUID();
      const root = s.put({
        schema: 'personal-sync-object@1',
        kind: 'directory_revision',
        body: {
          item_id: directory,
          parents: [],
          name: '',
          parent_directory: null,
        },
      });
      const items: any[] = [
        { kind: 'directory_revision', item_id: directory, heads: [root] },
      ];
      for (let n = 0; n < 4005; n++) {
        const item_id = randomUUID();
        const id = s.put({
          schema: 'personal-sync-object@1',
          kind: 'entry_revision',
          body: {
            item_id,
            parents: [],
            directory_id: directory,
            content: {
              kind: 'observation',
              statement: 'synthetic entry ' + String(n).padStart(4, '0'),
              data: {},
              applicability: null,
            },
            grounds: [],
          },
        });
        items.push({ kind: 'entry_revision', item_id, heads: [id] });
      }
      items.sort((a, b) => (itemKey(a) < itemKey(b) ? -1 : 1));
      const pages: string[] = [];
      for (let n = 0; n < items.length; n += 200)
        pages.push(
          s.put({
            schema: 'personal-sync-object@1',
            kind: 'inventory_page',
            body: { items: items.slice(n, n + 200) },
          }),
        );
      return s.put({
        schema: 'personal-sync-object@1',
        kind: 'snapshot',
        body: { parents: [], pages: pages.sort() },
      });
    }),
  );
  const first = await w.call({ op: 'list', section: 'knowledge', folder: '' });
  assert.equal(first.total, 4005);
  assert.equal(first.rows.length, 100);
  assert.equal(first.more, true);
  const next = await w.call({
    op: 'list',
    section: 'knowledge',
    folder: '',
    offset: 100,
  });
  assert.equal(next.rows.length, 100);
  const detail = await w.call({
    op: 'detail',
    id: first.rows[0].id,
    token: first.rows[0].token,
  });
  assert.equal(detail.text, 'synthetic entry 0000');
  assert.notEqual(first.rows[0].token, next.rows[0].token);
});
