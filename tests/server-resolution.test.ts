import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  DiscoveryError,
  discoverServer,
  fallbackDiscovery,
  mcpOperation,
  parseDiscovery,
  serverBaseUrl,
} from '../src/server_resolution.js';
import { validateAnswer, validateSync } from '../src/knowledge/protocol.js';
import { SyncHttp, SyncHttpError } from '../src/knowledge/sync-http.js';
import { cleanup } from './helpers.js';

const vector = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `./fixtures/knowledge-sync/v1-capabilities/${name}`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
const signal = new AbortController().signal;

test('the pinned discovery vector resolves the sync base, local tools and declared tools', () => {
  const found = parseDiscovery(
    vector('discovery.json'),
    'https://192.0.2.10/mcp',
  );
  assert.equal(found.source, 'document');
  assert.equal(found.syncBase, 'https://192.0.2.10/api/sync/v1');
  assert.equal(found.localToolsBase, 'https://192.0.2.10/local-tools');
  assert.deepEqual(found.capabilities, ['error-detail', 'purge-confirmation']);
  assert.deepEqual(
    mcpOperation(found, 'team-memory-read', { for_session: true }),
    {
      tool: 'get_nodes',
      args: { memory: { for_session: true, scope: 'team' } },
    },
  );
  assert.deepEqual(mcpOperation(found, 'entry-share', { entry: 'e' }), {
    tool: 'upload_file',
    args: { share_entry: { entry: 'e' } },
  });
  assert.equal(mcpOperation(found, 'something-else', {}), null);
});

test('a fixed member the server declared wins over the caller', () => {
  const found = parseDiscovery(
    vector('discovery.json'),
    'https://192.0.2.10/mcp',
  );
  assert.deepEqual(
    mcpOperation(found, 'team-memory-read', { scope: 'personal' })!.args,
    { memory: { scope: 'team' } },
  );
});

test('a discovery document is used only for the origin and endpoint it was asked for', () => {
  const doc = vector('discovery.json');
  // Another origin's document, or one sending the token elsewhere, is refused.
  assert.throws(
    () => parseDiscovery(doc, 'https://192.0.2.11/mcp'),
    DiscoveryError,
  );
  const elsewhere = structuredClone(doc);
  elsewhere.sync.versions[0].base_url = 'https://192.0.2.99/api/sync/v1';
  assert.throws(
    () => parseDiscovery(elsewhere, 'https://192.0.2.10/mcp'),
    /another origin/,
  );
  // A mapping for another MCP endpoint is not this entry's: no declared tools.
  const other = parseDiscovery(doc, 'https://192.0.2.10/other/mcp');
  assert.deepEqual(other.mcp, {});
  assert.equal(other.syncBase, 'https://192.0.2.10/api/sync/v1');
  // Unknown members are ignored; a document without v1 is refused.
  const later = { ...structuredClone(doc), later: { synthetic: true } };
  later.sync.versions[0].later = 1;
  assert.equal(
    parseDiscovery(later, 'https://192.0.2.10/mcp').source,
    'document',
  );
  const v2 = structuredClone(doc);
  v2.sync.versions[0].version = 'v2';
  assert.throws(
    () => parseDiscovery(v2, 'https://192.0.2.10/mcp'),
    /no knowledge-sync v1/,
  );
  assert.throws(() =>
    parseDiscovery({ schema: 'x' }, 'https://192.0.2.10/mcp'),
  );
});

test('without a document, local tools and sync share one base: the entry without /mcp', () => {
  for (const [entry, base] of [
    ['https://192.0.2.10/mcp', 'https://192.0.2.10'],
    ['https://192.0.2.10/mcp/', 'https://192.0.2.10'],
    ['https://192.0.2.10/team/mcp', 'https://192.0.2.10/team'],
  ] as const) {
    assert.equal(serverBaseUrl(entry), base);
    const found = fallbackDiscovery(entry);
    assert.equal(found.source, 'fallback');
    assert.equal(found.syncBase, base + '/api/sync/v1');
    assert.equal(found.localToolsBase, base + '/local-tools');
    assert.deepEqual(found.capabilities, []);
    // No server's tool names are guessed
    assert.deepEqual(found.mcp, {});
  }
  assert.throws(() => fallbackDiscovery('http://192.0.2.10/mcp'));
  assert.equal(
    fallbackDiscovery('http://192.0.2.10/mcp', true).localToolsBase,
    'http://192.0.2.10/local-tools',
  );
});

test('discovery reads the origin without credentials; 404 falls back, other failures do not', async (t) => {
  let answer: { status: number; body: string; type?: string } = {
    status: 404,
    body: '{}',
  };
  const seen: { path: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url!, authorization: req.headers.authorization });
    res
      .writeHead(answer.status, {
        'content-type': answer.type ?? 'application/json',
      })
      .end(answer.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup(t, () => new Promise<void>((r) => server.close(() => r())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const entry = origin + '/team/mcp';
  const fallback = await discoverServer(entry, { signal });
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.syncBase, origin + '/team/api/sync/v1');
  assert.deepEqual(seen, [
    { path: '/.well-known/knowledge-sync', authorization: undefined },
  ]);
  const doc = JSON.stringify(vector('discovery.json')).replaceAll(
    'https://192.0.2.10',
    origin,
  );
  answer = { status: 200, body: doc };
  const found = await discoverServer(origin + '/mcp', { signal });
  assert.equal(found.source, 'document');
  assert.equal(found.syncBase, origin + '/api/sync/v1');
  answer = { status: 503, body: '{}' };
  await assert.rejects(discoverServer(entry, { signal }), (e: unknown) => {
    assert.ok(e instanceof DiscoveryError && e.retryable);
    return true;
  });
  answer = { status: 200, body: '<html>', type: 'text/html' };
  await assert.rejects(discoverServer(entry, { signal }), (e: unknown) => {
    assert.ok(e instanceof DiscoveryError && !e.retryable);
    return true;
  });
});

test('every capability error vector parses as an answer, the unknown code included', () => {
  for (const item of vector('errors.json').errors) {
    validateAnswer('personal-sync-error@1', item.body);
    if (item.server_output) validateSync('personal-sync-error@1', item.body);
  }
  // A request stays closed: a member the protocol does not have is refused.
  assert.throws(() =>
    validateSync('personal-sync-mode-check@1', { mode: 'hub', later: true }),
  );
  validateAnswer('personal-sync-mode-impact@1', {
    check: 'a'.repeat(64),
    expected_state: 'b'.repeat(64),
    mode: 'hub',
    personal_bytes: 0,
    directory_grants: 0,
    pending_shares: null,
    team_copies_preserved: 0,
    later: { synthetic: true },
  });
});

test('error answers keep detail, the purge confirmation and unknown codes as a generic failure', async (t) => {
  const errors = vector('errors.json').errors as {
    name: string;
    status: number;
    body: any;
  }[];
  let current = errors[0]!;
  const server = createServer((_req, res) => {
    res
      .writeHead(current.status, { 'content-type': 'application/json' })
      .end(JSON.stringify(current.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup(t, () => new Promise<void>((r) => server.close(() => r())));
  const http = new SyncHttp(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
    async () => 'synthetic-token',
  );
  const failure = async (name: string) => {
    current = errors.find((e) => e.name === name)!;
    try {
      await http.request('state', { signal });
    } catch (error) {
      assert.ok(error instanceof SyncHttpError);
      return error;
    }
    assert.fail('expected a refusal');
  };
  const plain = await failure('v1-without-detail');
  assert.equal(plain.detail, undefined);
  assert.equal(plain.unknownCode, false);
  assert.equal((await failure('detail')).detail, current.body.detail);
  const purge = await failure('purge-confirmation-required');
  assert.equal(purge.status, 403);
  assert.deepEqual(purge.confirmation, {
    url: current.body.confirmation.url,
    expiresAt: current.body.confirmation.expires_at,
  });
  const newer = await failure('unknown-code-from-a-newer-server');
  assert.equal(newer.code, 'SYNC_SOMETHING_NEWER');
  assert.equal(newer.unknownCode, true);
  assert.equal(newer.detail, '合成的较新错误说明。');
});

test("a discovery document that cannot be read now is retried as an absent server, with no detail: that is the server's own text", async () => {
  const http = new SyncHttp(
    'https://192.0.2.10/mcp',
    async () => 'synthetic-token',
    (async () => {
      throw Error('no request is sent without a discovery');
    }) as typeof fetch,
    async () => {
      throw new DiscoveryError('discovery document unavailable', true);
    },
  );
  await assert.rejects(
    http.request('state', { signal: AbortSignal.timeout(5000) }),
    (error: unknown) =>
      error instanceof SyncHttpError &&
      error.status === 0 &&
      error.code === 'SOURCE_RETRYABLE' &&
      error.detail === undefined,
  );
});
