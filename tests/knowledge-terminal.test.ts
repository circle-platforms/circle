import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, saveSettings } from '../src/settings.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import { KnowledgeStore } from '../src/knowledge/store.js';
import {
  setPalette,
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
} from '../src/ink/theme.js';
import { renderScreen } from '../src/tui/render.js';
import { stripAnsi } from '../src/ink/string_width.js';
import { scratch, cleanup, until } from './helpers.js';
import { AuthorizedServer } from './fixtures/knowledge-sync/authorized-server.js';
const signal = new AbortController().signal;
async function session(t: Parameters<typeof scratch>[0]) {
  const home = scratch(t, 'circle-knowledge-terminal-'),
    workspace = scratch(t, 'circle-knowledge-work-'),
    userHome = scratch(t, 'circle-knowledge-user-'),
    settings = defaultSettings();
  settings.initialized = true;
  settings.trusted_folders = [workspace];
  saveSettings(settings, home);
  const model = new ScriptedModel(
    Array.from({ length: 10 }, () => ({
      message: {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: 'synthetic reply',
      },
    })),
  );
  const app = new SessionApp(workspace, home, settings),
    ui = app as any;
  ui.screen.render = () => {};
  await app.attach({
    workspace,
    home,
    userHome,
    settings,
    model,
    headless: true,
    bundledExtensions: false,
  });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    await (ui.sessions?.close() ?? app.runtime!.close());
  });
  const key = (key: string) =>
    ui.handle({ type: 'key', key, char: key.length === 1 ? key : '' });
  const stored = () =>
    new KnowledgeService(home).withStore((s) => ({
      head: s.head,
      items: s.items(),
    }));
  return {
    home,
    workspace,
    settings,
    model,
    app,
    ui,
    key,
    stored,
    runtime: app.runtime!,
  };
}
for (const mode of ['manual', 'auto'] as const)
  test(`structured memory commands in ${mode} require the person and a refusal has no stored effect`, async (t) => {
    const w = await session(t);
    w.runtime.setMode(mode);
    const denied = w.app.submit('/memory write synthetic | NEVER_APPROVED');
    await until(() => !!w.ui.state.dialog);
    assert.equal(w.stored().head, null);
    w.key('n');
    await denied;
    assert.equal(w.stored().head, null);
    const approved = w.app.submit('/memory write synthetic | PERSON_APPROVED');
    await until(() => !!w.ui.state.dialog);
    assert.equal(w.stored().head, null);
    w.key('y');
    await approved;
    assert.equal(
      w.stored().items.filter((i) => i.kind === 'memory_revision').length,
      1,
    );
    assert.equal(w.model.requests.length, 0);
    await w.app.submit('/memory refresh');
    await w.app.submit('hello');
    assert.match(w.model.requests[0]!.system, /PERSON_APPROVED/);
    assert.doesNotMatch(w.model.requests[0]!.system, /NEVER_APPROVED/);
  });

test('a concurrent local write while the terminal confirmation is open refuses the stale proposal', async (t) => {
  const w = await session(t);
  const pending = w.app.submit('/memory write proposed | STALE_BODY');
  await until(() => !!w.ui.state.dialog);
  const service = new KnowledgeService(w.home);
  service
    .prepareMemory({
      expected_head: null,
      title: 'concurrent',
      markdown: 'CONCURRENT_BODY',
    })
    .commit(signal);
  const head = w.stored().head;
  w.key('y');
  await pending;
  assert.equal(w.stored().head, head);
  service.withStore((s) =>
    assert.equal(
      s.items().filter((i) => i.kind === 'memory_revision').length,
      1,
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(w.ui.state.messages),
    /STALE_BODY.*saved locally/,
  );
});

test('legacy file commands coexist with structured memory and both reach a later request', async (t) => {
  const w = await session(t);
  await w.app.submit('/memory add account LEGACY_FILE_PREF');
  const write = w.app.submit('/memory write personal | STRUCTURED_PREF');
  await until(() => !!w.ui.state.dialog);
  w.key('y');
  await write;
  await w.app.submit('/memory personal');
  assert.ok(w.ui.state.picker);
  w.key('esc');
  await w.app.submit('/memory refresh');
  await w.app.submit('hello');
  assert.match(w.model.requests[0]!.system, /LEGACY_FILE_PREF/);
  assert.match(w.model.requests[0]!.system, /STRUCTURED_PREF/);
  await w.app.submit('/memory remove 1');
  await w.app.submit('/memory loaded');
  assert.ok(
    w.ui.state.notices.some((v: string) => v.includes('session preferences')),
  );
});

test('terminal knowledge browsing, search and conflict selection use existing pickers and commit an explicitly approved resolution', async (t) => {
  const w = await session(t),
    service = new KnowledgeService(w.home);
  service
    .prepareMemory({
      expected_head: null,
      title: 'base',
      markdown: 'BASE_PREF',
    })
    .commit(signal);
  service.withStore((s) => {
    const item = s.items().find((i) => i.kind === 'memory_revision')!,
      old = s.read(item.heads[0]!) as any;
    const heads = ['LEFT', 'RIGHT']
      .map((markdown) =>
        s.put({ ...old, body: { ...old.body, parents: item.heads, markdown } }),
      )
      .sort();
    const items = s.items().map(({ kind, item_id, heads: prior }) => ({
        kind,
        item_id,
        heads: item_id === item.item_id ? heads : prior,
      })),
      page = s.put({
        schema: 'personal-sync-object@1',
        kind: 'inventory_page',
        body: { items },
      }),
      snapshot = s.put({
        schema: 'personal-sync-object@1',
        kind: 'snapshot',
        body: { parents: [s.head], pages: [page] },
      });
    s.commit(snapshot, s.head);
  });
  await w.app.submit('/knowledge conflicts');
  assert.equal(w.ui.state.picker.items.length, 1);
  w.key('esc');
  const number =
      w.stored().items.findIndex((i) => i.kind === 'memory_revision') + 1,
    before = w.stored().items[number - 1]!.heads;
  const resolving = w.app.submit(`/knowledge resolve ${number} 1`);
  await until(() => !!w.ui.state.dialog);
  w.key('y');
  await resolving;
  const after = w.stored().items[number - 1]!;
  assert.equal(after.heads.length, 1);
  service.withStore((s) =>
    assert.deepEqual((s.read(after.heads[0]!) as any).body.parents, before),
  );
  await w.app.submit(`/knowledge read ${number}`);
  assert.ok(
    w.ui.state.notices.some(
      (v: string) => v.includes('LEFT') || v.includes('RIGHT'),
    ),
  );
});

test('sync connection and destructive mode changes require exact person approval and expose no token in terminal notices', async (t) => {
  const w = await session(t),
    server = new AuthorizedServer(scratch(t, 'circle-terminal-peer-'));
  await server.start();
  cleanup(t, () => server.close());
  await server.seed(w.home);
  const config = {
    name: 'chosen',
    transport: 'streamable_http',
    url: server.origin + '/mcp',
  };
  w.runtime.options.settings.mcp_servers = [config];
  w.settings.mcp_servers = [config];
  saveSettings(w.settings, w.home);
  const selecting = w.app.submit('/knowledge connect chosen');
  await until(() => !!w.ui.state.dialog);
  assert.equal(w.runtime.options.settings.knowledge_sync.server, '');
  w.key('y');
  await selecting;
  assert.equal(w.runtime.options.settings.knowledge_sync.server, 'chosen');
  const local = w.app.submit('/knowledge mode local');
  await until(() => !!w.ui.state.dialog);
  assert.equal(server.peer.mode, 'hub');
  w.key('n');
  await local;
  assert.equal(server.peer.mode, 'hub');
  const approved = w.app.submit('/knowledge mode local');
  await until(() => !!w.ui.state.dialog);
  w.key('y');
  await approved;
  assert.equal(server.peer.mode, 'local');
  assert.equal(w.runtime.knowledge.status().condition, 'local');
  assert.doesNotMatch(
    JSON.stringify(w.ui.state.notices),
    /synthetic-access-|synthetic-refresh/,
  );
  await w.runtime.knowledge.close();
});

test('knowledge status and confirmation render safely on narrow dark and light terminals', async (t) => {
  const w = await session(t);
  const pending = w.app.submit('/memory write 标题 | 内容 <tag>');
  await until(() => !!w.ui.state.dialog);
  for (const theme of ['dark', 'light'] as const) {
    setPalette(
      buildPalette(...(theme === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT)),
    );
    const screen = renderScreen(w.ui.state, 60, 24).map(stripAnsi).join('\n');
    // The card says what it writes, by name, with no head or object hash.
    assert.match(screen, /write memory/);
    assert.match(screen, /new · mine \/ 标题 · 1 line/);
    assert.doesNotMatch(screen, /[0-9a-f]{64}|memory_write|knowledge_write/);
    assert.doesNotMatch(screen, /\u001b\]52/);
  }
  w.key('n');
  await pending;
  setPalette(buildPalette(...DEFAULT_DARK));
});

test('structured proposals submitted through the real composer never persist their body in input history', async (t) => {
  const w = await session(t);
  w.ui.composer.set('/memory write private | INPUT_HISTORY_MUST_NOT_KEEP');
  w.key('enter');
  await until(() => !!w.ui.state.dialog);
  w.key('n');
  await until(() => !w.ui.state.dialog);
  assert.ok(
    !w.ui.history.items.some((text: string) =>
      text.includes('INPUT_HISTORY_MUST_NOT_KEEP'),
    ),
  );
  assert.equal(w.stored().head, null);
});

test('terminal source import requires person approval, preserves BOM and CRLF, and refuses credentials and outside paths', async (t) => {
  const w = await session(t),
    raw = Buffer.from('\ufeffsynthetic original\r\nexact  \r\n');
  writeFileSync(join(w.workspace, 'sample  document.txt'), raw);
  const denied = w.app.submit('/knowledge import sample  document.txt');
  await until(() => !!w.ui.state.dialog);
  w.key('n');
  await denied;
  assert.equal(w.stored().head, null);
  const accepted = w.app.submit('/knowledge import sample  document.txt');
  await until(() => !!w.ui.state.dialog);
  w.key('y');
  await accepted;
  new KnowledgeService(w.home).withStore((s) => {
    const source = s.items().find((i) => i.kind === 'source_revision')!;
    assert.deepEqual(s.sourceBytes(source.heads[0]!), raw);
  });
  const head = w.stored().head;
  writeFileSync(
    join(w.workspace, 'bad.txt'),
    'Password=Syn9theticRejectedValue',
  );

  let done = false;
  const rejected = w.app.submit('/knowledge import bad.txt').finally(() => {
    done = true;
  });
  await until(() => done || !!w.ui.state.dialog);
  const unexpectedlyAsked = !!w.ui.state.dialog;
  if (unexpectedlyAsked) w.key('n');
  await rejected;
  assert.equal(unexpectedlyAsked, false);

  assert.equal(w.stored().head, head);
  assert.equal(!!w.ui.state.dialog, false);
  const outside = join(scratch(t), 'outside.txt');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, join(w.workspace, 'outside.txt'));
  await w.app.submit('/knowledge import outside.txt');
  assert.equal(w.stored().head, head);
  assert.equal(!!w.ui.state.dialog, false);
});

test('structured terminal edits preserve Markdown whitespace and refuse a missing body', async (t) => {
  const w = await session(t),
    initial = w.app.submit('/memory write title | original');
  await until(() => !!w.ui.state.dialog);
  w.key('y');
  await initial;
  const edit = w.app.submit('/memory edit 1 line one\n\nline  two  ');
  await until(() => !!w.ui.state.dialog);
  w.key('y');
  await edit;
  new KnowledgeService(w.home).withStore((s) => {
    const id = s.items().find((i) => i.kind === 'memory_revision')!.heads[0]!;
    assert.equal((s.read(id) as any).body.markdown, 'line one\n\nline  two  ');
  });
  const head = w.stored().head;
  await w.app.submit('/memory edit 1');
  assert.equal(w.stored().head, head);
  assert.equal(!!w.ui.state.dialog, false);
});

test('a direct Bearer connection offers credential replacement rather than claiming an OAuth login', async (t) => {
  const w = await session(t);
  w.runtime.options.settings.mcp_servers = [
    {
      name: 'direct',
      url: 'http://127.0.0.1:9/mcp',
      transport: 'streamable_http',
      headers: { authorization: 'Bearer synthetic-direct-token' },
    },
  ];
  w.runtime.options.settings.knowledge_sync = {
    server: 'direct',
    binding: 'a'.repeat(64),
  };
  await w.app.submit('/knowledge login');
  assert.equal(!!w.ui.state.dialog, false);
  assert.match(JSON.stringify(w.ui.state.notices), /configured credential/);
  assert.doesNotMatch(
    JSON.stringify(w.ui.state.notices),
    /synthetic-direct-token|sign-in requested/,
  );
});

test('the terminal says synced and local, asks with named cards and leaves a notice per sync change', async (t) => {
  const w = await session(t),
    server = new AuthorizedServer(scratch(t, 'circle-terminal-peer-'));
  await server.start();
  cleanup(t, () => server.close());
  await server.seed(w.home);
  const config = {
    name: '团队服务器',
    transport: 'streamable_http',
    url: server.origin + '/mcp',
  };
  w.runtime.options.settings.mcp_servers = [config];
  w.settings.mcp_servers = [config];
  saveSettings(w.settings, w.home);
  const notices = () => w.ui.state.notices as string[];
  const selecting = w.app.submit('/knowledge connect 团队服务器');
  await until(() => !!w.ui.state.dialog);
  assert.match(w.ui.state.dialog.title, /^connect sync server$/);
  w.key('y');
  await selecting;
  await w.app.submit('/knowledge status');
  const block = notices().at(-1)!;
  assert.match(block, /^knowledge · (?:pending|syncing|synced) · 团队服务器/);
  assert.match(block, /\n {2}\d+ items?/);
  // The protocol's word is not the person's: `hub` is refused, `synced` is sent as `hub`.
  await w.app.submit('/knowledge mode hub');
  assert.match(
    JSON.stringify(notices()),
    /usage: \/knowledge mode synced\|local/,
  );
  const local = w.app.submit('/knowledge mode local');
  await until(() => !!w.ui.state.dialog);
  assert.equal(w.ui.state.dialog.title, 'change sync mode');
  w.key('y');
  await local;
  assert.equal(server.peer.mode, 'local');
  assert.match(notices().at(-1)!, /^knowledge · mode local only$/);
  const synced = w.app.submit('/knowledge mode synced');
  await until(() => !!w.ui.state.dialog);
  assert.match(JSON.stringify(w.ui.state.dialog.lines), /to synced/);
  w.key('y');
  await synced;
  assert.equal(server.peer.mode, 'hub');
  assert.doesNotMatch(JSON.stringify(notices()), /[0-9a-f]{64}|Hub/);
  // A runtime sync change the person has to act on leaves one notice, once.
  const real = w.runtime.knowledge.status.bind(w.runtime.knowledge);
  w.runtime.knowledge.status = () => ({ ...real(), condition: 'conflicted' });
  const before = notices().length;
  w.runtime.bus.emit('info', { payload: { knowledge_sync: 'conflicted' } });
  w.runtime.bus.emit('info', { payload: { knowledge_sync: 'conflicted' } });
  assert.deepEqual(notices().slice(before), [
    'knowledge · conflict · /knowledge conflicts',
  ]);
  w.runtime.knowledge.status = real;
  await w.runtime.knowledge.close();
});

test('a list longer than the picker says how much it shows', async (t) => {
  const w = await session(t);
  const service = new KnowledgeService(w.home);
  const root = crypto.randomUUID();
  const folders = (names: number[], head: string | null) =>
    service
      .prepare({
        expected_head: head,
        objects: [
          ...(head === null
            ? [
                {
                  schema: 'personal-sync-object@1',
                  kind: 'directory_revision',
                  body: {
                    item_id: root,
                    parents: [],
                    parent_directory: null,
                    name: '',
                  },
                },
              ]
            : []),
          ...names.map((n) => ({
            schema: 'personal-sync-object@1',
            kind: 'directory_revision',
            body: {
              item_id: crypto.randomUUID(),
              parents: [],
              parent_directory: root,
              name: `文件夹 ${n}`,
            },
          })),
        ],
      })
      .commit(signal);
  const first = folders(
    Array.from({ length: 60 }, (_, i) => i),
    null,
  );
  folders(
    Array.from({ length: 40 }, (_, i) => 60 + i),
    first,
  );
  await w.app.submit('/knowledge list');
  assert.equal(w.ui.state.picker.items.length, 100);
  assert.equal(
    (w.ui.state.notices as string[]).at(-1),
    'showing 100 of 101 · narrow with /knowledge search <words>',
  );
});
