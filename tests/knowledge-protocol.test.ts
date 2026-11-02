import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeSyncObject,
  encodeSyncObject,
  sha256,
  syncObjectId,
} from '../src/knowledge/canonical.js';
import {
  decodeBase64,
  SYNC_LIMITS,
  SYNC_PROTOCOL,
  validateSync,
} from '../src/knowledge/protocol.js';
import { parseStrictJson } from '../src/knowledge/strict-json.js';
import { verifyKnowledgeSync } from '../scripts/verify-knowledge-sync.js';
import { scratch } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name: string): any =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/knowledge-sync/v1/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
const encoding = fixture('encoding');
const epoch = '11111111-1111-4111-8111-111111111111',
  hash = 'a'.repeat(64);
const memory = (): any => structuredClone(encoding.cases[0].input);
const envelope = (kind: string, body: unknown): any => ({
  schema: 'personal-sync-object@1',
  kind,
  body,
});

test('the unchanged shared vectors pin canonical bytes, identities and original-byte exceptions', () => {
  for (const vector of encoding.cases) {
    const original = structuredClone(vector.input);
    assert.equal(
      encodeSyncObject(vector.input).toString(),
      vector.canonical,
      vector.name,
    );
    assert.equal(syncObjectId(vector.input), vector.sha256, vector.name);
    assert.deepEqual(
      decodeSyncObject(Buffer.from(vector.canonical), vector.sha256),
      JSON.parse(vector.canonical),
    );
    assert.deepEqual(
      vector.input,
      original,
      'encoding does not add defaults or change its caller',
    );
  }
  const raw = decodeBase64(
    encoding.cases.find((v: any) => v.name === 'verbatim-source-and-quote')
      .input.body.bytes_base64,
  );
  assert.equal(sha256(raw), encoding.raw_source_sha256);
  assert.notEqual(
    sha256(raw),
    encoding.cases.find((v: any) => v.name === 'verbatim-source-and-quote')
      .sha256,
  );
});

test('the shared scenario objects decode independently and the HTTP routes match the mirrored protocol', () => {
  for (const object of fixture('scenarios').objects)
    decodeSyncObject(Buffer.from(object.canonical), object.id);
  assert.deepEqual(fixture('http').routes, SYNC_PROTOCOL.routes);
  assert.equal(Object.keys(SYNC_PROTOCOL.routes).length, 12);
  assert.equal(SYNC_PROTOCOL.defaultMode, 'hub');
  assert.ok(SYNC_PROTOCOL.routes.commit!.path.startsWith('/api/sync/v1/'));
});

test('the offline mirror matches every recorded byte without pretending to check an absent upstream', (t) => {
  const checked = verifyKnowledgeSync(root);
  assert.equal(checked.mirrored, 45);
  assert.equal(checked.upstream, 0);
  assert.throws(() => verifyKnowledgeSync(root, join(scratch(t), 'absent')));
});

test('explicit upstream comparison rejects drift instead of quietly accepting changed fixtures', (t) => {
  const local = scratch(t),
    upstream = scratch(t),
    bytes = Buffer.from('synthetic fixture\n');
  const path = 'tests/vector.json';
  mkdirSync(join(local, 'src/data/knowledge-sync/v1'), { recursive: true });
  mkdirSync(dirname(join(local, path)), { recursive: true });
  writeFileSync(join(local, path), bytes);
  writeFileSync(join(upstream, 'vector.json'), bytes);
  writeFileSync(
    join(local, 'src/data/knowledge-sync/v1/provenance.json'),
    JSON.stringify({
      files: [{ path, source: 'vector.json', sha256: sha256(bytes) }],
      derived: [],
      references: [],
    }),
  );
  assert.deepEqual(verifyKnowledgeSync(local, upstream), {
    mirrored: 1,
    upstream: 1,
  });
  writeFileSync(join(upstream, 'vector.json'), 'changed');
  assert.throws(
    () => verifyKnowledgeSync(local, upstream),
    /differs: vector.json/,
  );
  writeFileSync(join(local, path), 'changed');
  assert.throws(() => verifyKnowledgeSync(local), /differs/);
});

test('the production desktop asset copier includes all protocol schemas without a neighbouring repository import', async (t) => {
  const output = scratch(t);
  const copier = new URL(
    '../apps/desktop/scripts/runtime-assets.mjs',
    import.meta.url,
  ).href;
  const { copyRuntimeAssets } = await import(copier);
  await copyRuntimeAssets(output);
  for (const name of SYNC_PROTOCOL.schemas)
    assert.ok(
      JSON.parse(
        readFileSync(join(output, 'data/knowledge-sync/v1', name), 'utf8'),
      ).$schema,
    );
  const manifest = readFileSync(
    join(root, 'src/data/knowledge-sync/v1/provenance.json'),
    'utf8',
  );
  assert.doesNotMatch(manifest, /\/Users\/|\/private\/var\/|file:\/\//);
});

test('wire bytes refuse whitespace, BOM, changed identities, malformed UTF-8 and duplicate members', () => {
  const { canonical, sha256: id } = encoding.cases[0];
  for (const value of [
    ' ' + canonical,
    canonical + '\n',
    '\ufeff' + canonical,
    canonical.replace('"kind":', '"kind":"memory_revision","kind":'),
  ]) {
    assert.throws(() => decodeSyncObject(Buffer.from(value), id));
  }
  assert.throws(
    () => decodeSyncObject(Buffer.from(canonical), hash),
    /hash mismatch/,
  );
  assert.throws(() => decodeSyncObject(Buffer.from([0xff]), hash));
  assert.throws(() => decodeSyncObject(Buffer.from(canonical), '../object'));
  assert.throws(() => parseStrictJson('{"a":1,"\\u0061":2}'), /duplicate/);
  assert.throws(() => parseStrictJson('{"a":{"x":0,"x":1}}'), /duplicate/);
});

test('canonicalization refuses collisions, non-JSON values and invalid Unicode instead of repairing identity', () => {
  const entry = envelope('entry_revision', {
    item_id: epoch,
    directory_id: epoch,
    parents: [],
    content: {
      kind: 'definition',
      statement: 'synthetic',
      data: { é: 1, 'e\u0301': 2 },
      applicability: null,
    },
    grounds: [],
  });
  assert.throws(() => encodeSyncObject(entry), /collision/);
  for (const value of ['\ud800', '\udfff']) {
    const m = memory();
    m.body.markdown = value;
    assert.throws(() => encodeSyncObject(m), /Unicode/);
  }
  for (const value of [
    Infinity,
    NaN,
    undefined,
    BigInt(1),
    new Date(),
    () => 1,
  ]) {
    entry.body.content.data = { value };
    assert.throws(() => encodeSyncObject(entry));
  }
  let deep: any = 1;
  for (let i = 0; i < 66; i++) deep = { child: deep };
  entry.body.content.data = deep;
  assert.throws(() => encodeSyncObject(entry), /nesting/);
});

test('base64 is standard, canonical and padded, with independently bounded chunks', () => {
  for (const value of ['YQ', 'YR==', 'YQ==\n', 'YQ===', '____', ' YQ==']) {
    assert.throws(() =>
      encodeSyncObject(envelope('bytes', { bytes_base64: value })),
    );
  }
  assert.equal(decodeBase64('').length, 0);
  assert.equal(decodeBase64('YQ==').toString(), 'a');
  assert.throws(
    () =>
      encodeSyncObject(
        envelope('bytes', {
          bytes_base64: Buffer.alloc(SYNC_LIMITS.chunkBytes + 1).toString(
            'base64',
          ),
        }),
      ),
    /chunk/,
  );
  const large = memory();
  large.body.markdown = 'x'.repeat(SYNC_LIMITS.objectBytes);
  assert.throws(() => encodeSyncObject(large), /object size/);
});

test('strict objects do not acquire defaults, extra fields or coerce types', () => {
  const entry = envelope('entry_revision', {
    item_id: epoch,
    directory_id: epoch,
    parents: [],
    content: { kind: 'definition', statement: 'synthetic' },
    grounds: [],
  });
  assert.throws(() => encodeSyncObject(entry), /schema/);
  const m = memory();
  m.body.verified = true;
  assert.throws(() => encodeSyncObject(m), /schema/);
  delete m.body.verified;
  m.body.parents = '[]';
  assert.throws(() => encodeSyncObject(m), /schema/);
  const title = memory();
  title.body.title = '😀'.repeat(151);
  assert.throws(() => encodeSyncObject(title), /string maximum/);
});

test('only declared sets are sorted and unique; ordered source chunks keep their supplied order', () => {
  const m = memory();
  m.body.parents = ['b'.repeat(64), hash];
  assert.throws(() => encodeSyncObject(m), /parents/);
  m.body.parents = [hash, hash];
  assert.throws(() => encodeSyncObject(m), /parents/);
  assert.throws(
    () =>
      encodeSyncObject(
        envelope('snapshot', { parents: [], pages: ['b'.repeat(64), hash] }),
      ),
    /pages/,
  );
  const items = [{ kind: 'memory_revision', item_id: epoch, heads: [hash] }];
  assert.throws(
    () =>
      encodeSyncObject(
        envelope('inventory_page', { items: [items[0], items[0]] }),
      ),
    /inventory/,
  );
  assert.throws(() =>
    encodeSyncObject(
      envelope('inventory_page', { items: [{ ...items[0], heads: [] }] }),
    ),
  );
  assert.throws(
    () =>
      encodeSyncObject(
        envelope('deletion', {
          item_id: epoch,
          target_kind: 'memory_revision',
          parents: [],
        }),
      ),
    /parents/,
  );
  const source = envelope('source_revision', {
    item_id: epoch,
    directory_id: epoch,
    parents: [],
    name: 'synthetic.txt',
    media_type: 'text/plain',
    raw_sha256: hash,
    size: 0,
    chunks: ['b'.repeat(64), hash, hash],
  });
  assert.deepEqual(
    JSON.parse(encodeSyncObject(source).toString()).body.chunks,
    source.body.chunks,
  );
});

test('wire refinements require unique batches, registered errors and explicit checked purge', () => {
  validateSync('personal-sync-missing@1', { epoch, objects: [hash] });
  assert.throws(() =>
    validateSync('personal-sync-missing@1', { epoch, objects: [hash, hash] }),
  );
  const upload = {
    schema: 'personal-sync-upload@1',
    epoch,
    operation_id: 'upload',
    objects: [{ id: hash, bytes_base64: '' }],
  };
  validateSync('personal-sync-upload@1', upload);
  assert.throws(() =>
    validateSync('personal-sync-upload@1', {
      ...upload,
      objects: [upload.objects[0], upload.objects[0]],
    }),
  );
  assert.throws(() =>
    validateSync('personal-sync-upload@1', {
      ...upload,
      objects: [{ id: hash, bytes_base64: 'YR==' }],
    }),
  );
  const mode = {
    epoch,
    operation_id: 'mode',
    mode: 'local',
    expected_state: hash,
    check: hash,
    confirm_purge: true,
  };
  validateSync('personal-sync-mode-change@1', mode);
  assert.throws(() =>
    validateSync('personal-sync-mode-change@1', {
      ...mode,
      confirm_purge: false,
    }),
  );
  assert.throws(() =>
    validateSync('personal-sync-mode-change@1', { ...mode, check: null }),
  );
  validateSync('personal-sync-error@1', { code: 'SYNC_EPOCH_CHANGED' });
  assert.throws(() =>
    validateSync('personal-sync-error@1', { code: 'MADE_UP' }),
  );
  assert.throws(() => validateSync('personal-sync-state@1', { owner: epoch }));
  assert.throws(
    () =>
      validateSync('personal-sync-client@1', {
        client_id: epoch,
        name: '\ud800',
      }),
    /Unicode/,
  );
  assert.throws(() => SYNC_PROTOCOL.kinds.push('invented'));
});

test('response qualification and conflicts keep their semantic checks outside JSON Schema', () => {
  const state = {
    epoch,
    mode: 'hub',
    status: SYNC_PROTOCOL.statuses[0],
    state_version: hash,
    snapshot: null,
    last_synced_at: null,
    used_bytes: 0,
    capacity_bytes: 1024,
    limits: {
      object_bytes: 1024,
      batch_bytes: 1024,
      batch_objects: 64,
      page_items: 500,
      session_seconds: 86400,
    },
  };
  const receipt = {
    operation_id: 'commit',
    epoch,
    request: hash,
    previous_state: null,
    state_version: hash,
    counts: { accepted: 0, existing: 0, downloaded: 0, bytes: 0 },
    at: '2026-11-03T00:00:00Z',
  };
  const observation = {
    object: hash,
    status: 'unverified',
    rule_version: '1.0.0',
    scanner: 'credential-scan@3',
    parser_lock: null,
    codes: ['QUOTE_MISMATCH'],
    checked_at: receipt.at,
  };
  const result = {
    state,
    receipt,
    verification: [observation],
    conflicts: [{ item_id: epoch, heads: [hash, 'b'.repeat(64)] }],
    next: null,
  };
  validateSync('personal-sync-result@1', result);
  assert.throws(() =>
    validateSync('personal-sync-result@1', {
      ...result,
      verification: [{ ...observation, codes: ['UNREGISTERED'] }],
    }),
  );
  assert.throws(() =>
    validateSync('personal-sync-result@1', {
      ...result,
      conflicts: [{ item_id: epoch, heads: [hash, hash] }],
    }),
  );
  assert.throws(() =>
    validateSync('personal-sync-result@1', { ...result, next: '\ud800' }),
  );
  assert.throws(() =>
    validateSync('personal-sync-receipt@1', {
      ...receipt,
      at: '2026-02-30T00:00:00Z',
    }),
  );
  assert.throws(() =>
    validateSync('personal-sync-receipt@1', {
      ...receipt,
      at: '2026-11-03T00:00:00+09:00',
    }),
  );
});

test('a pack manifest is metadata with required, ordered, safe, case-unique files and dependencies', () => {
  const pack = envelope('pack_manifest', {
    item_id: epoch,
    parents: [],
    manifest: {
      schema: 'pack@1',
      id: 'synthetic-skill',
      version: '1.0.0',
      kind: 'skill',
      title: 'synthetic',
      description: 'synthetic skill',
      files: ['SKILL.md', 'skill.json'].map((path) => ({
        path,
        sha256: hash,
        size: 0,
      })),
    },
  });
  encodeSyncObject(pack);
  for (const path of [
    '../outside',
    '/SKILL.md',
    'functions/../../outside',
    'functions/.hidden',
    'functions/x.',
    'pack.json',
    'arbitrary/x',
  ]) {
    const candidate = structuredClone(pack);
    candidate.body.manifest.files.push({ path, sha256: hash, size: 0 });
    candidate.body.manifest.files.sort((a: any, b: any) =>
      a.path < b.path ? -1 : 1,
    );
    assert.throws(() => encodeSyncObject(candidate), path);
  }
  const duplicate = structuredClone(pack);
  duplicate.body.manifest.files.push({
    path: 'Skill.md',
    sha256: hash,
    size: 0,
  });
  duplicate.body.manifest.files.sort((a: any, b: any) =>
    a.path < b.path ? -1 : 1,
  );
  assert.throws(() => encodeSyncObject(duplicate), /unique/);
  const missing = structuredClone(pack);
  missing.body.manifest.files.pop();
  assert.throws(() => encodeSyncObject(missing), /required/);
  const unsorted = structuredClone(pack);
  unsorted.body.manifest.files.reverse();
  assert.throws(() => encodeSyncObject(unsorted), /ordered/);
  pack.body.manifest.dependencies = [
    { pack: 'synthetic-other' },
    { pack: 'synthetic-other' },
  ];
  assert.throws(() => encodeSyncObject(pack), /dependencies/);
});
