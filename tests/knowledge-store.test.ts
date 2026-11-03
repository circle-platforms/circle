import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  KnowledgeStore,
  KnowledgeVersionConflict,
} from '../src/knowledge/store.js';
import { sha256, syncObjectId } from '../src/knowledge/canonical.js';
import { knowledgeTokens } from '../src/knowledge/search.js';
import { renameObject } from '../src/knowledge/objects.js';
import type { SyncItem } from '../src/knowledge/types.js';
import { scratch } from './helpers.js';

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const object = (kind: string, body: unknown): unknown => ({
  schema: 'personal-sync-object@1',
  kind,
  body,
});
const entry = (
  statement: string,
  parents: string[] = [],
  id = uuid(2),
  directory = uuid(1),
  extra = {},
): unknown =>
  object('entry_revision', {
    item_id: id,
    parents,
    directory_id: directory,
    content: {
      kind: 'observation',
      statement,
      data: {},
      applicability: null,
      ...extra,
    },
    grounds: [],
  });
const directory = (
  id: string,
  name: string,
  parent: string | null = uuid(1),
  parents: string[] = [],
): unknown =>
  object('directory_revision', {
    item_id: id,
    parents,
    name,
    parent_directory: parent,
  });
function world(t: TestContext): {
  home: string;
  store: KnowledgeStore;
  rows: SyncItem[];
} {
  const home = scratch(t, 'circle-knowledge-test-'),
    store = new KnowledgeStore(home);
  t.after(() => store.close());
  const root = store.put(directory(uuid(1), '', null));
  return {
    home,
    store,
    rows: [{ kind: 'directory_revision', item_id: uuid(1), heads: [root] }],
  };
}
function snapshot(
  store: KnowledgeStore,
  rows: SyncItem[],
  parents = store.head ? [store.head] : [],
): string {
  const page = store.put(
    object('inventory_page', {
      items: [...rows].sort((a, b) =>
        `${a.kind}:${a.item_id}` < `${b.kind}:${b.item_id}` ? -1 : 1,
      ),
    }),
  );
  return store.put(object('snapshot', { parents, pages: [page] }));
}
const row = (id: string, heads: string[]): SyncItem => ({
  kind: 'entry_revision',
  item_id: id,
  heads: heads.sort(),
});

test('the dedicated store preserves the session database and persists its own client identity', (t) => {
  const home = scratch(t),
    session = join(home, 'circle.sqlite');
  writeFileSync(session, 'synthetic session database sentinel');
  const bytes = readFileSync(session),
    store = new KnowledgeStore(home),
    id = store.clientId;
  assert.equal(store.head, null);
  assert.deepEqual(store.search('知识'), {
    snapshot: null,
    items: [],
    next: null,
  });
  store.close();
  const reopened = new KnowledgeStore(home);
  t.after(() => reopened.close());
  assert.equal(reopened.clientId, id);
  assert.deepEqual(readFileSync(session), bytes);
  const separate = new KnowledgeStore(scratch(t));
  t.after(() => separate.close());
  assert.notEqual(separate.clientId, id);
  if (process.platform !== 'win32') {
    assert.equal(statSync(reopened.directory).mode & 0o777, 0o700);
    assert.equal(statSync(reopened.databasePath).mode & 0o777, 0o600);
  }
});

test('staged objects stay out of search until one atomic snapshot commit; old bytes remain readable', (t) => {
  const w = world(t),
    first = w.store.put(entry('中文知识支持离线查询'));
  assert.deepEqual(w.store.search('知识').items, []);
  const s1 = snapshot(w.store, [...w.rows, row(uuid(2), [first])]);
  w.store.commit(s1, null);
  assert.equal(w.store.search('知识').items[0]!.objectId, first);
  assert.equal(w.store.search('离线').items[0]!.status, 'unverified');
  assert.deepEqual(w.store.search('知识', { status: 'verified' }).items, []);
  const second = w.store.put(entry('中文知识现在支持同步', [first]));
  const s2 = snapshot(w.store, [...w.rows, row(uuid(2), [second])]);
  w.store.commit(s2, s1);
  assert.equal(w.store.search('同步').items[0]!.objectId, second);
  assert.equal(w.store.read(first).kind, 'entry_revision');
  assert.deepEqual(w.store.history(), [s1, s2]);
});

test('the canonical empty Hub snapshot can precede the first local directory without inventing remote data', (t) => {
  const home = scratch(t),
    store = new KnowledgeStore(home);
  t.after(() => store.close());
  const empty = store.put(object('snapshot', { parents: [], pages: [] }));
  store.commit(empty, null);
  assert.equal(store.head, empty);
  assert.deepEqual(store.items(), []);
  assert.deepEqual(store.search('知识').items, []);
  const root = store.put(directory(uuid(1), '', null));
  const next = snapshot(store, [
    { kind: 'directory_revision', item_id: uuid(1), heads: [root] },
  ]);
  store.commit(next, empty);
  assert.deepEqual(store.history(), [empty, next]);
});

test('two handles compare and exchange the same current head rather than overwriting a competing write', (t) => {
  const w = world(t),
    first = w.store.put(entry('共同知识'));
  const s1 = snapshot(w.store, [...w.rows, row(uuid(2), [first])]);
  w.store.commit(s1, null);
  const peer = new KnowledgeStore(w.home);
  t.after(() => peer.close());
  const a = w.store.put(entry('甲方知识', [first])),
    b = peer.put(entry('乙方知识', [first]));
  const left = snapshot(w.store, [...w.rows, row(uuid(2), [a])]);
  const right = snapshot(peer, [...w.rows, row(uuid(2), [b])]);
  w.store.commit(left, s1);
  assert.throws(
    () => peer.commit(right, s1),
    (error: unknown) =>
      error instanceof KnowledgeVersionConflict && error.current === left,
  );
  assert.equal(peer.head, left);
  assert.equal(peer.search('甲方').items[0]!.objectId, a);
  assert.deepEqual(peer.search('乙方').items, []);
  assert.equal(peer.read(b).kind, 'entry_revision');
});

test('omitting an item is refused; an explicit deletion preserves immutable history', (t) => {
  const w = world(t),
    first = w.store.put(entry('保留原件'));
  const initial = snapshot(w.store, [...w.rows, row(uuid(2), [first])]);
  w.store.commit(initial, null);
  const omitted = snapshot(w.store, w.rows);
  assert.throws(() => w.store.commit(omitted, initial), /omitted/);
  assert.equal(w.store.head, initial);
  assert.equal(w.store.search('原件').items.length, 1);
  const deleted = w.store.put(
    object('deletion', {
      item_id: uuid(2),
      parents: [first],
      target_kind: 'entry_revision',
    }),
  );
  const next = snapshot(w.store, [...w.rows, row(uuid(2), [deleted])]);
  w.store.commit(next, initial);
  assert.equal(w.store.search('原件').items.length, 0);
  assert.equal(w.store.read(first).kind, 'entry_revision');
  assert.deepEqual(w.store.items().find((r) => r.item_id === uuid(2))!.heads, [
    deleted,
  ]);
});

test('conflicting heads have no selected search body; explicit resolution retains both parents', (t) => {
  const w = world(t),
    base = w.store.put(entry('基础知识'));
  w.store.commit(snapshot(w.store, [...w.rows, row(uuid(2), [base])]), null);
  const a = w.store.put(entry('甲方知识', [base])),
    b = w.store.put(entry('乙方知识', [base]));
  const heads = [a, b].sort(),
    conflicted = snapshot(w.store, [...w.rows, row(uuid(2), heads)]);
  w.store.commit(conflicted, w.store.head);
  assert.equal(w.store.search('知识').items.length, 0);
  assert.deepEqual(
    w.store.items().find((r) => r.item_id === uuid(2))!.heads,
    heads,
  );
  const dropped = w.store.put(entry('错误选择', [a]));
  assert.throws(
    () =>
      w.store.commit(
        snapshot(w.store, [...w.rows, row(uuid(2), [dropped])]),
        conflicted,
      ),
    /omitted/,
  );
  const resolved = w.store.put(entry('本人选定知识', heads));
  w.store.commit(
    snapshot(w.store, [...w.rows, row(uuid(2), [resolved])]),
    conflicted,
  );
  assert.equal(w.store.search('选定').items[0]!.objectId, resolved);
  assert.equal(w.store.read(a).kind, 'entry_revision');
  assert.equal(w.store.read(b).kind, 'entry_revision');
});

test('shared memory revisions retain exact fixture identities through conflict and resolution snapshots', (t) => {
  const home = scratch(t),
    store = new KnowledgeStore(home);
  t.after(() => store.close());
  const fixtures = JSON.parse(
    readFileSync(
      new URL('./fixtures/knowledge-sync/v1/scenarios.json', import.meta.url),
      'utf8',
    ),
  );
  for (const o of fixtures.objects)
    store.importBytes(Buffer.from(o.canonical), o.id);
  const rootId = '22222222-2222-4222-8222-222222222222',
    itemId = '11111111-1111-4111-8111-111111111111';
  const root = store.put(directory(rootId, '', null));
  const rows: SyncItem[] = [
    { kind: 'directory_revision', item_id: rootId, heads: [root] },
  ];
  const memoryRow = (heads: string[]): SyncItem => ({
    kind: 'memory_revision',
    item_id: itemId,
    heads,
  });
  const conflict = fixtures.merges.find(
    (s: any) => s.name === 'same-item-conflict',
  );
  store.commit(snapshot(store, [...rows, memoryRow(conflict.base)]), null);
  store.commit(
    snapshot(store, [...rows, memoryRow(conflict.expected_heads)]),
    store.head,
  );
  assert.deepEqual(
    store.items().find((r) => r.item_id === itemId)!.heads,
    conflict.expected_heads,
  );
  const resolution = fixtures.merges.find(
    (s: any) => s.name === 'explicit-resolution',
  );
  store.commit(
    snapshot(store, [...rows, memoryRow(resolution.expected_heads)]),
    store.head,
  );
  assert.deepEqual(
    store.items().find((r) => r.item_id === itemId)!.heads,
    resolution.expected_heads,
  );
});

test('directory moves keep stable identity and update the path projection without rewriting entries', (t) => {
  const w = world(t),
    folder = w.store.put(directory(uuid(3), '规范'));
  const text = w.store.put(entry('认证知识', [], uuid(2), uuid(3)));
  let rows: SyncItem[] = [
    ...w.rows,
    { kind: 'directory_revision', item_id: uuid(3), heads: [folder] },
    row(uuid(2), [text]),
  ];
  w.store.commit(snapshot(w.store, rows), null);
  assert.equal(w.store.search('认证', { path: '/规范' }).items.length, 1);
  const moved = w.store.put(directory(uuid(3), '接口规范', uuid(1), [folder]));
  rows = [
    ...w.rows,
    { kind: 'directory_revision', item_id: uuid(3), heads: [moved] },
    row(uuid(2), [text]),
  ];
  w.store.commit(snapshot(w.store, rows), w.store.head);
  assert.equal(w.store.search('认证', { path: '/规范' }).items.length, 0);
  assert.equal(
    w.store.search('认证', { path: '/接口规范' }).items[0]!.objectId,
    text,
  );
  assert.equal(w.store.read(folder).kind, 'directory_revision');
});

test('directory cycles, escaped names, duplicate roots, NFC collisions and duplicate identities cannot commit', (t) => {
  const w = world(t);
  const cases: SyncItem[][] = [];
  const a = w.store.put(directory(uuid(3), '甲', uuid(4))),
    b = w.store.put(directory(uuid(4), '乙', uuid(3)));
  cases.push([
    ...w.rows,
    { kind: 'directory_revision', item_id: uuid(3), heads: [a] },
    { kind: 'directory_revision', item_id: uuid(4), heads: [b] },
  ]);
  for (const name of ['..', 'a/b', 'a\\b', 'a\0b']) {
    const id = w.store.put(directory(uuid(3), name));
    cases.push([
      ...w.rows,
      { kind: 'directory_revision', item_id: uuid(3), heads: [id] },
    ]);
  }
  const root2 = w.store.put(directory(uuid(3), '', null));
  cases.push([
    ...w.rows,
    { kind: 'directory_revision', item_id: uuid(3), heads: [root2] },
  ]);
  const nfc = w.store.put(directory(uuid(3), 'é')),
    nfd = w.store.put(directory(uuid(4), 'e\u0301'));
  cases.push([
    ...w.rows,
    { kind: 'directory_revision', item_id: uuid(3), heads: [nfc] },
    { kind: 'directory_revision', item_id: uuid(4), heads: [nfd] },
  ]);
  for (const rows of cases)
    assert.throws(() => w.store.commit(snapshot(w.store, rows), null), /graph/);
  const page1 = w.store.put(object('inventory_page', { items: w.rows }));
  const page2 = w.store.put(
    object('inventory_page', {
      items: [...w.rows, row(uuid(2), [w.store.put(entry('合成'))])],
    }),
  );
  assert.throws(
    () =>
      w.store.commit(
        w.store.put(
          object('snapshot', { parents: [], pages: [page1, page2].sort() }),
        ),
        null,
      ),
    /duplicate inventory/,
  );
  assert.equal(w.store.head, null);
});

test('raw source blocks retain BOM, CRLF, Unicode and order; inconsistent or missing sources do not commit', (t) => {
  const w = world(t),
    raw = Buffer.from('\ufeff合成来源\r\ne\u0301\r\n');
  const chunks = [raw.subarray(0, 7), raw.subarray(7)].map((bytes) =>
    w.store.put(object('bytes', { bytes_base64: bytes.toString('base64') })),
  );
  const body = {
    item_id: uuid(4),
    directory_id: uuid(1),
    parents: [],
    name: 'synthetic.txt',
    media_type: 'text/plain',
    raw_sha256: sha256(raw),
    size: raw.length,
    chunks,
  };
  const source = w.store.put(object('source_revision', body));
  const sourceRow: SyncItem = {
    kind: 'source_revision',
    item_id: uuid(4),
    heads: [source],
  };
  w.store.commit(snapshot(w.store, [...w.rows, sourceRow]), null);
  assert.deepEqual(w.store.sourceBytes(source), raw);
  assert.throws(() => w.store.sourceBytes(source, raw.length - 1), /limit/);
  for (const change of [
    { raw_sha256: 'a'.repeat(64) },
    { chunks: [...chunks].reverse() },
    { chunks: ['b'.repeat(64)] },
  ]) {
    const invalid = w.store.put(
      object('source_revision', { ...body, parents: [source], ...change }),
    );
    assert.throws(() =>
      w.store.commit(
        snapshot(w.store, [...w.rows, { ...sourceRow, heads: [invalid] }]),
        w.store.head,
      ),
    );
  }
  const oversized = w.store.put(
    object('source_revision', {
      ...body,
      parents: [source],
      size: 32 * 1024 * 1024 + 1,
    }),
  );
  assert.throws(
    () =>
      w.store.commit(
        snapshot(w.store, [...w.rows, { ...sourceRow, heads: [oversized] }]),
        w.store.head,
      ),
    /source byte limit/,
  );
  const empty = w.store.put(
    object('source_revision', {
      ...body,
      item_id: uuid(5),
      size: 0,
      raw_sha256: sha256(Buffer.alloc(0)),
      chunks: [],
    }),
  );
  assert.deepEqual(w.store.sourceBytes(empty), Buffer.alloc(0));
});

test('search includes data and quotation text, respects scopes and pins continuation to a version', (t) => {
  const w = world(t),
    raw = Buffer.from('证据逐字原文\r\n'),
    bytes = w.store.put(
      object('bytes', { bytes_base64: raw.toString('base64') }),
    );
  const source = w.store.put(
    object('source_revision', {
      item_id: uuid(4),
      parents: [],
      directory_id: uuid(1),
      name: 'synthetic.txt',
      media_type: 'text/plain',
      raw_sha256: sha256(raw),
      size: raw.length,
      chunks: [bytes],
    }),
  );
  const a: any = entry('知识甲', [], uuid(2), uuid(1), {
    data: { feature: '认证兼容' },
  });
  a.body.grounds = [
    { source, quotation: bytes, parser: 'text@1', selector: 'l/1' },
  ];
  const first = w.store.put(a),
    second = w.store.put(entry('知识乙', [], uuid(3)));
  const rows = [...w.rows, row(uuid(2), [first]), row(uuid(3), [second])];
  w.store.commit(snapshot(w.store, rows), null);
  assert.equal(w.store.search('逐字').items[0]!.objectId, first);
  assert.equal(w.store.search('认证').items[0]!.objectId, first);
  assert.equal(w.store.search('知识', { kind: 'definition' }).items.length, 0);
  assert.equal(w.store.search('知识', { path: '/missing' }).items.length, 0);
  const page = w.store.search('知识', { limit: 1 });
  assert.ok(page.next);
  assert.equal(
    w.store.search('知识', { limit: 1, cursor: page.next }).items[0]!.objectId,
    second,
  );
  assert.throws(() => w.store.search('逐字', { cursor: page.next! }), /stale/);
  const before = w.store.search('知识');
  w.store.rebuildSearch();
  assert.deepEqual(w.store.search('知识'), before);
  const damaged = new DatabaseSync(w.store.databasePath);
  damaged.exec('DELETE FROM search_terms');
  damaged.close();
  assert.deepEqual(w.store.search('知识').items, []);
  w.store.rebuildSearch();
  assert.deepEqual(w.store.search('知识'), before);
  const changed = w.store.put(entry('知识更新', [first]));
  w.store.commit(
    snapshot(w.store, [
      ...w.rows,
      row(uuid(2), [changed]),
      row(uuid(3), [second]),
    ]),
    w.store.head,
  );
  assert.throws(() => w.store.search('知识', { cursor: page.next! }), /stale/);
  assert.throws(() => w.store.search('x', { limit: 101 }), /limit/);
  assert.deepEqual(w.store.search('😀!').items, []);
});

test('Chinese two-character terms, isolated characters, compatibility forms and mixed scripts use one tokenizer', () => {
  assert.deepEqual(knowledgeTokens('知识库'), ['知识', '识库']);
  assert.deepEqual(knowledgeTokens('ＡＢＣ abc Ｋ'), ['ab', 'bc', 'k']);
  assert.deepEqual(knowledgeTokens('中 😀 文 a'), ['a', '中', '文']);
  assert.deepEqual(knowledgeTokens('中文ABC'), ['ab', 'bc', '中文', '文a']);
  assert.throws(() => knowledgeTokens('知识', 64), /limit/);
});

test('graphs larger than the object cache still stream and verify all source bytes', (t) => {
  const w = world(t),
    chunks: string[] = [],
    raw: Buffer[] = [];
  for (let i = 0; i < 8; i++) {
    const bytes = Buffer.alloc(1024 * 1024, i);
    raw.push(bytes);
    chunks.push(
      w.store.put(object('bytes', { bytes_base64: bytes.toString('base64') })),
    );
  }
  const combined = Buffer.concat(raw);
  const source = w.store.put(
    object('source_revision', {
      item_id: uuid(4),
      directory_id: uuid(1),
      parents: [],
      name: 'synthetic.bin',
      media_type: 'application/octet-stream',
      raw_sha256: sha256(combined),
      size: combined.length,
      chunks,
    }),
  );
  const next = snapshot(w.store, [
    ...w.rows,
    { kind: 'source_revision', item_id: uuid(4), heads: [source] },
  ]);
  w.store.commit(next, null);
  assert.deepEqual(w.store.sourceBytes(source), combined);
  assert.equal(w.store.graph(next).objects.size, 12);
});

test('heads cannot masquerade as a conflict by including an ancestor and its descendant', (t) => {
  const w = world(t),
    base = w.store.put(entry('基础知识')),
    child = w.store.put(entry('新知识', [base]));
  assert.throws(
    () =>
      w.store.commit(
        snapshot(w.store, [...w.rows, row(uuid(2), [base, child])]),
        null,
      ),
    /redundant ancestor/,
  );
  assert.equal(w.store.head, null);
});

test('newer and unrelated databases are rejected without downgrading or changing their records', (t) => {
  const home = scratch(t),
    store = new KnowledgeStore(home),
    path = store.databasePath,
    id = store.clientId;
  store.close();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=5');
  db.close();
  const before = readFileSync(path);
  assert.throws(() => new KnowledgeStore(home), /newer/);
  assert.deepEqual(readFileSync(path), before);
  const check = new DatabaseSync(path);
  t.after(() => check.close());
  assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 5);
  assert.equal(
    check.prepare("SELECT value FROM metadata WHERE key='client_id'").get()!
      .value,
    id,
  );
  const other = scratch(t);
  mkdirSync(join(other, 'knowledge'));
  const foreign = new DatabaseSync(join(other, 'knowledge/knowledge.sqlite'));
  foreign.exec(
    "CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES('synthetic')",
  );
  foreign.close();
  assert.throws(() => new KnowledgeStore(other), /not a Circle/);
});

test('invalid or corrupt objects cannot become readable registered data', (t) => {
  const w = world(t),
    clean = entry('合成知识'),
    id = syncObjectId(clean);
  assert.throws(() => w.store.putBatch([clean, { schema: 'other' }]));
  assert.equal(w.store.has(id), false);
  const actual = w.store.put(clean),
    file = join(w.store.directory, 'objects', actual);
  assert.equal(
    statSync(file).mode & 0o777,
    process.platform === 'win32' ? statSync(file).mode & 0o777 : 0o600,
  );
  writeFileSync(file, '{}');
  assert.throws(() => w.store.read(actual));
  assert.throws(() => w.store.importBytes(Buffer.from('{}'), actual));
  assert.throws(() => w.store.read('../outside'));
});

test('a crash after file publication recovers an invisible orphan, not a partial object registration', (t) => {
  const home = scratch(t),
    payload = entry('崩溃前暂存'),
    id = syncObjectId(payload);
  crash(home, 'object-published', { object: payload });
  const file = join(home, 'knowledge/objects', id);
  assert.ok(existsSync(file));
  const store = new KnowledgeStore(home);
  t.after(() => store.close());
  assert.equal(store.has(id), false);
  assert.equal(store.head, null);
  assert.equal(store.recoveredObjects, 1);
  assert.equal(existsSync(file), false);
  assert.deepEqual(store.search('暂存').items, []);
});

test('a crash between index replacement and commit rolls back both index and current head', (t) => {
  const w = world(t),
    old = w.store.put(entry('旧版知识'));
  const initial = snapshot(w.store, [...w.rows, row(uuid(2), [old])]);
  w.store.commit(initial, null);
  const next = w.store.put(entry('新版知识', [old])),
    candidate = snapshot(w.store, [...w.rows, row(uuid(2), [next])]);
  w.store.close();
  crash(w.home, 'projection-written', {
    snapshot: candidate,
    expected: initial,
  });
  const reopened = new KnowledgeStore(w.home);
  t.after(() => reopened.close());
  assert.equal(reopened.head, initial);
  assert.equal(reopened.search('旧版').items[0]!.objectId, old);
  assert.deepEqual(reopened.search('新版').items, []);
  assert.equal(reopened.read(next).kind, 'entry_revision');
});
function crash(home: string, phase: string, payload: unknown): void {
  const worker = fileURLToPath(
    new URL('./fixtures/knowledge-sync/crash-worker.ts', import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      worker,
      home,
      phase,
      Buffer.from(JSON.stringify(payload)).toString('base64'),
    ],
    {
      env: {
        ...process.env,
        CIRCLE_HOME: home,
        CIRCLE_WORKBENCH_DATA_DIR: join(home, 'desktop-data'),
      },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 73, result.stderr);
}

test('rename sharing errors retry a bounded number of times while preserving actual file bytes', (t) => {
  const home = scratch(t),
    from = join(home, 'temporary'),
    to = join(home, 'object');
  writeFileSync(from, 'synthetic bytes');
  const pauses: number[] = [];
  let attempts = 0;
  renameObject(
    from,
    to,
    (a, b) => {
      if (++attempts < 3)
        throw Object.assign(Error('synthetic sharing violation'), {
          code: 'EBUSY',
        });
      renameSync(a, b);
    },
    (ms) => {
      pauses.push(ms);
    },
  );
  assert.equal(readFileSync(to, 'utf8'), 'synthetic bytes');
  assert.deepEqual(pauses, [10, 20]);
  assert.equal(existsSync(from), false);
  attempts = 0;
  assert.throws(
    () =>
      renameObject(
        from,
        to,
        () => {
          attempts++;
          throw Object.assign(Error('held'), { code: 'EPERM' });
        },
        () => {},
      ),
    /held/,
  );
  assert.equal(attempts, 5);
  attempts = 0;
  assert.throws(
    () =>
      renameObject(
        from,
        to,
        () => {
          attempts++;
          throw Object.assign(Error('disk'), { code: 'ENOSPC' });
        },
        () => {},
      ),
    /disk/,
  );
  assert.equal(attempts, 1);
});

test(
  'a substituted symlink cannot redirect object reads into another file',
  {
    skip:
      process.platform === 'win32'
        ? 'requires a symlink-capable test account'
        : false,
  },
  (t) => {
    const home = scratch(t),
      outside = join(home, 'outside');
    writeFileSync(outside, 'synthetic outside sentinel');
    const store = new KnowledgeStore(join(home, 'runtime'));
    t.after(() => store.close());
    const payload = entry('合成知识'),
      id = syncObjectId(payload);
    symlinkSync(outside, join(store.directory, 'objects', id));
    assert.throws(() => store.put(payload), /invalid knowledge object/);
    assert.equal(readFileSync(outside, 'utf8'), 'synthetic outside sentinel');
  },
);

test('migration 3 rebuilds an existing projection and preserves identities, current heads and immutable bytes', (t) => {
  const w = world(t);
  const entryId = w.store.put(entry('真实陈述'));
  const head = snapshot(w.store, [...w.rows, row(uuid(2), [entryId])]);
  w.store.commit(head, null);
  const client = w.store.clientId,
    bytes = w.store.readBytes(entryId),
    path = w.store.databasePath;
  w.store.close();
  // Recreate the previous applied schema using a synthetic database, then corrupt only derived search text.
  const old = new DatabaseSync(path);
  old.exec(
    'DROP TABLE sync_journal; DROP TABLE sync_lease; DROP TABLE local_revision_times; PRAGMA user_version=2;',
  );
  old
    .prepare("UPDATE search_documents SET statement='stale derived text'")
    .run();
  old.close();
  const upgraded = new KnowledgeStore(w.home);
  t.after(() => upgraded.close());
  assert.equal(upgraded.clientId, client);
  assert.equal(upgraded.head, head);
  assert.deepEqual(upgraded.readBytes(entryId), bytes);
  assert.equal(upgraded.search('真实').items[0]!.statement, '真实陈述');
  assert.equal(
    upgraded.acquireSyncLease('migration-holder', 1000, 30000),
    true,
  );
});

test('local update times record committed revisions only and never assign an imported remote update time', (t) => {
  const w = world(t),
    first = w.store.put(entry('合成远端版本'));
  assert.equal(w.store.localUpdatedAt(first), null);
  const remote = snapshot(w.store, [...w.rows, row(uuid(2), [first])]);
  w.store.commit(remote, null, true);
  assert.equal(w.store.localUpdatedAt(first), null);
  const next = w.store.put(entry('合成本机更改', [first]));
  const changed = snapshot(w.store, [...w.rows, row(uuid(2), [next])]);
  const before = Date.now();
  w.store.commit(changed, remote);
  const at = w.store.localUpdatedAt(next);
  assert.ok(at && Date.parse(at) >= before && Date.parse(at) <= Date.now());
  assert.equal(w.store.localUpdatedAt(first), null);
  w.store.commit(changed, changed);
  assert.equal(w.store.localUpdatedAt(next), at);
});
