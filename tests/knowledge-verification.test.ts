import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeService } from '../src/knowledge/service.js';
import { KnowledgeStore } from '../src/knowledge/store.js';
import {
  sha256,
  syncObjectId,
  encodeSyncObject,
} from '../src/knowledge/canonical.js';
import { exactQuotation } from '../src/knowledge/verification.js';
import { scratch } from './helpers.js';
const signal = () => new AbortController().signal;
const object = (kind: string, body: unknown) => ({
  schema: 'personal-sync-object@1',
  kind,
  body,
});
function proposal(
  raw = Buffer.from('synthetic fact\n'),
  quote = raw.subarray(0, -1),
  parser = 'text@1',
  selector = 'l/1',
) {
  const root = randomUUID(),
    source = randomUUID(),
    entry = randomUUID(),
    objects: unknown[] = [];
  const add = (kind: string, body: unknown) => {
    const o = object(kind, body);
    objects.push(o);
    return syncObjectId(o);
  };
  add('directory_revision', {
    item_id: root,
    parents: [],
    parent_directory: null,
    name: '',
  });
  const chunk = add('bytes', { bytes_base64: raw.toString('base64') });
  const src = add('source_revision', {
    item_id: source,
    parents: [],
    directory_id: root,
    name: null,
    media_type: 'text/plain',
    raw_sha256: sha256(raw),
    size: raw.length,
    chunks: [chunk],
  });
  const q = add('bytes', { bytes_base64: quote.toString('base64') });
  const id = add('entry_revision', {
    item_id: entry,
    parents: [],
    directory_id: root,
    content: {
      kind: 'observation',
      statement: 'synthetic conclusion',
      data: {},
      applicability: null,
    },
    grounds: [{ source: src, quotation: q, parser, selector }],
  });
  return { objects, id, src, root };
}
function observe(home: string, id: string) {
  const store = new KnowledgeStore(home);
  try {
    return store.observations().find((row) => row.object === id)!;
  } finally {
    store.close();
  }
}
test('all committed native-link vectors retain canonical bytes and exact identities', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        './fixtures/knowledge-sync/v1/native-links.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  for (const c of fixture.cases) {
    if (!c.input) continue;
    assert.equal(encodeSyncObject(c.input).toString(), c.canonical, c.name);
    assert.equal(syncObjectId(c.input), c.sha256, c.name);
  }
});
test('local qualification survives reopen and search rebuild without mutating immutable objects', (t) => {
  const home = scratch(t),
    service = new KnowledgeService(home),
    p = proposal();
  const prepared = service.prepare({ expected_head: null, objects: p.objects });
  assert.equal(service.search('synthetic').snapshot, null);
  const snapshot = prepared.commit(signal());
  assert.equal(observe(home, p.id).status, 'verified');
  assert.equal(
    service.search('synthetic', { status: 'verified' }).items.length,
    1,
  );
  const store = new KnowledgeStore(home);
  try {
    store.rebuildSearch();
    assert.equal(
      store.search('synthetic', { status: 'verified' }).items.length,
      1,
    );
    assert.equal(syncObjectId(store.read(p.id)), p.id);
  } finally {
    store.close();
  }
  assert.equal(
    service.read(snapshot, p.id).verification?.rule,
    'circle-local-verification@1',
  );
});
for (const [name, raw, quote, parser, selector, outcome] of [
  ['wrong quote', 'hello\n', 'HELLO', 'text@1', 'l/1', 'mismatch'],
  ['unknown parser', 'hello\n', 'hello', 'text@9', 'l/1', 'incomplete'],
  ['wrong selector', 'hello\n', 'hello', 'text@1', 'l/2', 'mismatch'],
  ['decomposed Unicode', 'cafe\u0301\n', 'café', 'text@1', 'l/1', 'mismatch'],
  ['raw CRLF quote', 'a\r\nb\r\n', 'a\r\nb', 'text@1', 'l/1-2', 'mismatch'],
  [
    'BOM is not discarded from quote',
    '\ufeffa\n',
    '\ufeffa',
    'text@1',
    'l/1',
    'mismatch',
  ],
  ['JSON actual parser', '{"a":"hello"}', 'hello', 'json@1', 'p/a', 'matched'],
  [
    'Markdown actual parser',
    '# Heading\n\nhello\n',
    'hello',
    'markdown@1',
    'b/0/Heading',
    'matched',
  ],
] as const)
  test(name, (t) => {
    const home = scratch(t),
      s = new KnowledgeService(home),
      p = proposal(Buffer.from(raw), Buffer.from(quote), parser, selector);
    s.prepare({ expected_head: null, objects: p.objects }).commit(signal());
    assert.equal(observe(home, p.id).outcome, outcome);
    if (parser === 'text@1') {
      const store = new KnowledgeStore(home);
      try {
        assert.deepEqual(store.sourceBytes(p.src), Buffer.from(raw));
      } finally {
        store.close();
      }
    }
  });
test('whitespace, case and Unicode are significant and empty quotations cannot qualify', () => {
  for (const [a, b] of [
    ['Ab', 'ab'],
    ['a b', 'a  b'],
    ['é', 'e\u0301'],
    ['x', ''],
    ['  ', ' '],
  ])
    assert.equal(exactQuotation(a!, b!), false);
  assert.equal(exactQuotation(' a\r\nb ', 'a\r\nb'), true);
});
test('native remote references are preserved as incomplete; the client does not fabricate authorization', (t) => {
  const home = scratch(t),
    s = new KnowledgeService(home),
    p = proposal();
  const e = p.objects.at(-1) as any;
  e.body.grounds = [
    {
      reference: 'src:' + 'a'.repeat(64) + '/text@1/l/1',
      quotation: e.body.grounds[0].quotation,
    },
  ];
  const id = syncObjectId(e);
  s.prepare({ expected_head: null, objects: p.objects }).commit(signal());
  assert.equal(observe(home, id).outcome, 'incomplete');
  assert.match(observe(home, id).reasons[0]!.code, /resolver/);
});
test('locked task reads only allowlisted immutable addresses and cannot search or write', (t) => {
  const home = scratch(t),
    s = new KnowledgeService(home),
    p = proposal();
  const snapshot = s
    .prepare({ expected_head: null, objects: p.objects })
    .commit(signal());
  const locked = new KnowledgeService(home, () => ({
    locked: true,
    addresses: [{ snapshot, object: p.id }],
  }));
  assert.equal(locked.read(snapshot, p.id).object, p.id);
  assert.throws(() => locked.read(snapshot, p.src), /lock/);
  assert.throws(() => locked.search('synthetic'), /explicit/);
  assert.throws(
    () =>
      locked.prepareMemory({
        expected_head: snapshot,
        title: 'x',
        markdown: 'x',
      }),
    /locked/,
  );
});
test('a stale approved closure leaves object files, heads, observations and search untouched', (t) => {
  const home = scratch(t),
    s = new KnowledgeService(home);
  const a = s.prepareMemory({
    expected_head: null,
    title: 'first',
    markdown: 'synthetic one',
  });
  const b = s.prepareMemory({
    expected_head: null,
    title: 'second',
    markdown: 'synthetic two',
  });
  a.commit(signal());
  const files = readdirSync(join(home, 'knowledge', 'objects'));
  const head = s.search('x').snapshot;
  assert.throws(() => b.commit(signal()), /version changed/);
  assert.deepEqual(readdirSync(join(home, 'knowledge', 'objects')), files);
  assert.equal(s.search('x').snapshot, head);
});
test('memory quotas and encoded credentials are rejected before publication', (t) => {
  const home = scratch(t),
    s = new KnowledgeService(home);
  const secret = 'Password' + '=Syn9' + 'theticSecretValue';
  for (const markdown of [
    secret,
    JSON.stringify(secret).replace('Password', 'Pass\\u0077ord'),
    Buffer.from(secret).toString('base64'),
    'x'.repeat(24001),
  ])
    assert.throws(() =>
      s.prepareMemory({ expected_head: null, title: 'synthetic', markdown }),
    );
  const store = new KnowledgeStore(home);
  try {
    assert.equal(store.head, null);
    assert.deepEqual(store.items(), []);
    assert.deepEqual(store.history(), []);
  } finally {
    store.close();
  }
  assert.deepEqual(readdirSync(join(home, 'knowledge', 'objects')), []);
});
test('memory create, edit, disable and deletion keep identity and require fresh snapshots', (t) => {
  const home = scratch(t),
    s = new KnowledgeService(home);
  let p = s.prepareMemory({
    expected_head: null,
    title: 'test',
    markdown: 'synthetic',
  });
  let head = p.commit(signal());
  const memory = p.preview.objects.find(
    (row) => row.object.kind === 'memory_revision',
  )!.object as any;
  p = s.prepareMemory({
    expected_head: head,
    item_id: memory.body.item_id,
    title: 'test 2',
    markdown: 'new synthetic',
    state: 'disabled',
  });
  head = p.commit(signal());
  const store = new KnowledgeStore(home);
  try {
    const item = store.items().find((row) => row.kind === 'memory_revision')!;
    assert.equal(item.item_id, memory.body.item_id);
    assert.equal((store.read(item.heads[0]!) as any).body.state, 'disabled');
  } finally {
    store.close();
  }
  head = s
    .prepareMemory({
      expected_head: head,
      item_id: memory.body.item_id,
      delete: true,
    })
    .commit(signal());
  assert.ok(head);
});
test('aborted preparation never publishes and later caller mutation cannot change the approved bytes', (t) => {
  const home = scratch(t),
    s = new KnowledgeService(home),
    p = proposal();
  const input = { expected_head: null, objects: p.objects };
  const pending = s.prepare(input);
  (p.objects.at(-1) as any).body.content.statement = 'mutated';
  pending.preview.objects.length = 0;
  const canceled = new AbortController();
  canceled.abort();
  assert.throws(() => pending.commit(canceled.signal));
  assert.equal(s.search('synthetic').snapshot, null);
  pending.commit(signal());
  assert.equal(
    s.search('synthetic').items[0]?.statement,
    'synthetic conclusion',
  );
});

// Quota fixtures need one populated snapshot, not 20 or 21 unrelated revision histories.
// Individual create/edit/disable/delete operations are exercised separately above.
function seedMemories(
  service: KnowledgeService,
  count: number,
  state: 'enabled' | 'disabled',
  markdown: string,
) {
  const directory = randomUUID();
  return service
    .prepare({
      expected_head: null,
      objects: [
        object('directory_revision', {
          item_id: directory,
          parents: [],
          parent_directory: null,
          name: '',
        }),
        ...Array.from({ length: count }, (_, i) =>
          object('memory_revision', {
            item_id: randomUUID(),
            parents: [],
            directory_id: directory,
            title: `${state} ${i}`,
            markdown,
            state,
          }),
        ),
      ],
    })
    .commit(signal());
}
test('memory count and aggregate UTF-8 bounds apply to enabled memories', (t) => {
  const home = scratch(t),
    service = new KnowledgeService(home);
  const head = seedMemories(service, 20, 'enabled', 'synthetic');
  assert.throws(
    () =>
      service.prepareMemory({
        expected_head: head,
        title: 'overflow',
        markdown: 'synthetic',
      }),
    /20 documents/,
  );
  const other = new KnowledgeService(scratch(t));
  const first = other
    .prepareMemory({
      expected_head: null,
      title: 'long title',
      markdown: 'a'.repeat(23990),
    })
    .commit(signal());
  assert.throws(
    () =>
      other.prepareMemory({
        expected_head: first,
        title: 'long title',
        markdown: 'b'.repeat(23990),
      }),
    /48000/,
  );
});
test('rejected multi-chunk credentials never publish any original or quotation bytes', (t) => {
  const home = scratch(t),
    s = new KnowledgeService(home),
    secret = 'Pass' + 'word=Syn9theticSplitValue',
    p = proposal(Buffer.from('clean\n'));
  const source = p.objects.find(
    (o: any) => o.kind === 'source_revision',
  ) as any;
  const chunks = [
    Buffer.from(secret.slice(0, 4)),
    Buffer.from(secret.slice(4)),
  ].map((bytes) => object('bytes', { bytes_base64: bytes.toString('base64') }));
  source.body.chunks = chunks.map(syncObjectId);
  source.body.raw_sha256 = sha256(secret);
  source.body.size = Buffer.byteLength(secret);
  (p.objects.at(-1) as any).body.grounds[0].source = syncObjectId(source);
  p.objects.push(...chunks);
  assert.throws(
    () => s.prepare({ expected_head: null, objects: p.objects }),
    /credential/,
  );
  assert.deepEqual(readdirSync(join(home, 'knowledge', 'objects')), []);
  assert.equal(s.search('x').snapshot, null);
});

test('state-only memory changes preserve content and edits preserve the disabled state', (t) => {
  const home = scratch(t),
    service = new KnowledgeService(home);
  const first = service.prepareMemory({
    expected_head: null,
    title: 'keep title',
    markdown: 'keep body',
    state: 'disabled',
  });
  let head = first.commit(signal());
  const item = (
    first.preview.objects.find((row) => row.object.kind === 'memory_revision')!
      .object as any
  ).body.item_id;
  head = service
    .prepareMemory({
      expected_head: head,
      item_id: item,
      markdown: 'edited body',
    })
    .commit(signal());
  const read = () => {
    const store = new KnowledgeStore(home);
    try {
      const row = store.items().find((row) => row.item_id === item)!;
      return (store.read(row.heads[0]!) as any).body;
    } finally {
      store.close();
    }
  };
  assert.equal(read().state, 'disabled');
  assert.equal(read().title, 'keep title');
  head = service
    .prepareMemory({ expected_head: head, item_id: item, state: 'enabled' })
    .commit(signal());
  assert.equal(read().markdown, 'edited body');
  assert.equal(read().state, 'enabled');
  assert.ok(head);
});

test('disabled memories retain bytes without consuming the active-context quota', (t) => {
  const home = scratch(t),
    service = new KnowledgeService(home);
  const head = seedMemories(service, 21, 'disabled', 'x'.repeat(24000));
  assert.ok(head);
  const active = service
    .prepareMemory({
      expected_head: head,
      title: 'active',
      markdown: 'synthetic',
    })
    .commit(signal());
  assert.ok(active);
});
