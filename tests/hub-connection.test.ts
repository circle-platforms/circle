// The Hub extension's address handling: what a person may type, how the Hub's MCP endpoint is found from it, the
// settings entry it keeps, and signing out of a server. A scripted fetch stands in for the Hub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HUB_SERVER,
  HubAddressError,
  addHub,
  findHub,
  hubCandidates,
  hubEndpoint,
  removeHub,
} from '../src/hub_connection.js';
import { keptFor, revokeAuthorization } from '../src/mcp_auth.js';
import { defaultSettings } from '../src/settings.js';
import { writePrivateJson } from '../src/settings.js';
import { join } from 'node:path';
import { scratch } from './helpers.js';

test('an address is taken with or without its scheme, as the Hub itself, and nothing else', () => {
  assert.deepEqual(
    hubCandidates(' hub.example.test:7420 ').map((url) => url.href),
    ['https://hub.example.test:7420/', 'http://hub.example.test:7420/'],
  );
  assert.deepEqual(
    hubCandidates('http://192.0.2.10:7420/mcp').map((url) => url.href),
    ['http://192.0.2.10:7420/'],
  );
  for (const typed of [
    '',
    'ftp://hub.example.test',
    'https://user:secret@hub.example.test',
    'https://hub.example.test/console',
    'https://hub.example.test/?a=1',
    'https://hub example.test',
  ])
    assert.throws(() => hubCandidates(typed), HubAddressError, typed);
});

function hub(answers: Record<string, unknown>) {
  const asked: string[] = [];
  const fetcher = (async (url: string | URL) => {
    asked.push(String(url));
    const body = answers[String(url)];
    return body === undefined
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
        });
  }) as typeof fetch;
  return { asked, fetcher };
}

test('the Hub is found by its knowledge-sync discovery, else by its protected-resource metadata, on its own origin', async () => {
  const discovered = hub({
    'http://hub.example.test/.well-known/knowledge-sync': {
      schema: 'knowledge-sync-discovery@1',
      mcp: { endpoint: 'http://hub.example.test/mcp' },
    },
  });
  // https answers nothing, so http is tried next
  assert.equal(
    await findHub('hub.example.test', discovered.fetcher),
    'http://hub.example.test/mcp',
  );
  assert.equal(
    discovered.asked[0],
    'https://hub.example.test/.well-known/knowledge-sync',
  );

  const resource = hub({
    'https://hub.example.test/.well-known/oauth-protected-resource/mcp': {
      resource: 'https://hub.example.test/mcp',
    },
  });
  assert.equal(
    await findHub('https://hub.example.test', resource.fetcher),
    'https://hub.example.test/mcp',
  );

  // An endpoint on another origin is not this Hub's
  const elsewhere = hub({
    'https://hub.example.test/.well-known/knowledge-sync': {
      schema: 'knowledge-sync-discovery@1',
      mcp: { endpoint: 'https://other.example.test/mcp' },
    },
  });
  await assert.rejects(
    findHub('https://hub.example.test', elsewhere.fetcher),
    /no Circle Hub answers at https:\/\/hub\.example\.test/,
  );
  await assert.rejects(
    findHub('hub.example.test', hub({}).fetcher),
    (error) =>
      error instanceof HubAddressError &&
      error.message ===
        'no Circle Hub answers at https://hub.example.test or http://hub.example.test',
  );
});

test('the Hub entry is added with the extension on, keeps its id when replaced, and is removed alone', () => {
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'other', command: 'synthetic', transport: 'stdio' },
    { id: 'kept-id', name: HUB_SERVER, url: 'http://old.example.test/mcp' },
  ];
  addHub(settings, 'https://hub.example.test/mcp');
  assert.deepEqual(settings.mcp_servers, [
    { name: 'other', command: 'synthetic', transport: 'stdio' },
    {
      id: 'kept-id',
      name: HUB_SERVER,
      url: 'https://hub.example.test/mcp',
      transport: 'streamable_http',
      enabled: true,
    },
  ]);
  assert.equal(settings.extensions.hub?.enabled, true);
  assert.equal(hubEndpoint(settings), 'https://hub.example.test/mcp');
  removeHub(settings);
  assert.deepEqual(settings.mcp_servers, [
    { name: 'other', command: 'synthetic', transport: 'stdio' },
  ]);
  assert.equal(hubEndpoint(settings), undefined);
});

test('signing out revokes the tokens at the revocation endpoint and forgets them, also when revoking fails', async (t) => {
  const home = scratch(t);
  const server = 'https://hub.example.test/mcp';
  const keep = () =>
    writePrivateJson(join(home, 'mcp-auth.json'), {
      servers: {
        [server]: {
          client: { client_id: 'client-1' },
          tokens: {
            access_token: 'access',
            refresh_token: 'refresh',
            token_type: 'Bearer',
          },
          discovery: {
            authorizationServerUrl: 'https://hub.example.test',
            authorizationServerMetadata: {
              revocation_endpoint: 'https://hub.example.test/oauth/revoke',
            },
          },
        },
      },
    });
  keep();
  const sent: URLSearchParams[] = [];
  const revoked = await revokeAuthorization(home, server, async (url, init) => {
    assert.equal(String(url), 'https://hub.example.test/oauth/revoke');
    sent.push(new URLSearchParams(String(init?.body)));
    return new Response(null, { status: 200 });
  });
  assert.equal(revoked, true);
  assert.deepEqual(
    sent.map((form) => [
      form.get('token'),
      form.get('token_type_hint'),
      form.get('client_id'),
    ]),
    [
      ['refresh', 'refresh_token', 'client-1'],
      ['access', 'access_token', 'client-1'],
    ],
  );
  assert.deepEqual(keptFor(home, server), {});

  keep();
  assert.equal(
    await revokeAuthorization(home, server, async () => {
      throw new Error('unreachable');
    }),
    false,
  );
  assert.deepEqual(keptFor(home, server), {}, 'forgotten all the same');
});
