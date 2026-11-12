// What MCP server entries give the %NAME% placeholders: an HTTP entry's endpoint and the token its connection sends, under
// the names its `placeholders` give, never over a value the person keeps, and nothing an entry does not name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mcpPlaceholders } from '../src/mcp_placeholders.js';
import { defaultSettings, writePrivateJson } from '../src/settings.js';
import { scratch } from './helpers.js';

const endpoint = 'http://192.0.2.10:7420/mcp';
const none = { variables: {}, secrets: {} };
const nothingSaved = { variables: {}, secrets: {} };

function signIn(
  home: string,
  tokens: Record<string, unknown>,
  expires_at?: number,
) {
  writePrivateJson(join(home, 'mcp-auth.json'), {
    servers: {
      [endpoint]: {
        tokens,
        grant_id: 'grant-1',
        ...(expires_at === undefined ? {} : { expires_at }),
      },
    },
  });
}

test('an entry gives its endpoint and the token of its sign-in under the names it gives, and nothing it does not name', (t) => {
  const home = scratch(t);
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'docs', url: endpoint, transport: 'streamable_http' },
  ];
  signIn(home, { access_token: 'signed-in-token', token_type: 'Bearer' });
  // Signed in, but it names nothing: nothing is given
  assert.deepEqual(mcpPlaceholders(home, settings, nothingSaved), none);
  settings.mcp_servers[0] = {
    ...settings.mcp_servers[0],
    placeholders: { url: 'DOCS_URL', token: 'DOCS_TOKEN' },
  };
  assert.deepEqual(mcpPlaceholders(home, settings, nothingSaved), {
    variables: { DOCS_URL: endpoint },
    secrets: { DOCS_TOKEN: 'signed-in-token' },
  });
  // A token past its expiry, or none kept, is not given; the endpoint still is
  signIn(
    home,
    { access_token: 'signed-in-token', token_type: 'Bearer' },
    Date.now() - 1000,
  );
  assert.deepEqual(mcpPlaceholders(home, settings, nothingSaved), {
    variables: { DOCS_URL: endpoint },
    secrets: {},
  });
  writePrivateJson(join(home, 'mcp-auth.json'), { servers: {} });
  assert.deepEqual(mcpPlaceholders(home, settings, nothingSaved).secrets, {});
});

test("an entry's Authorization header is the token it gives, and a name the person keeps, or a name that is no name, is left out", (t) => {
  const home = scratch(t);
  signIn(home, { access_token: 'signed-in-token', token_type: 'Bearer' });
  const settings = defaultSettings();
  settings.mcp_servers = [
    {
      name: 'docs',
      url: endpoint,
      transport: 'streamable_http',
      headers: { Authorization: 'Bearer ${secret:DOCS_SAVED}' },
      placeholders: { url: 'DOCS_URL', token: 'DOCS_TOKEN' },
    },
  ];
  assert.deepEqual(
    mcpPlaceholders(home, settings, {
      variables: {},
      secrets: { DOCS_SAVED: 'header-token' },
    }).secrets,
    { DOCS_TOKEN: 'header-token' },
    "the header's token, not the sign-in's",
  );
  assert.deepEqual(
    mcpPlaceholders(home, settings, nothingSaved).secrets,
    {},
    'a header naming a secret not saved sends no token',
  );
  // The person's own values under those names are theirs
  assert.deepEqual(
    mcpPlaceholders(home, settings, {
      variables: { DOCS_TOKEN: 'mine' },
      secrets: { DOCS_URL: 'mine', DOCS_SAVED: 'header-token' },
    }),
    none,
  );
  settings.mcp_servers[0] = {
    ...settings.mcp_servers[0],
    headers: {},
    placeholders: { url: 'docs_url', token: 7 },
  };
  assert.deepEqual(mcpPlaceholders(home, settings, nothingSaved), none);
});

test('an entry that is off, not reached over HTTP, or the second to claim a name gives nothing', (t) => {
  const home = scratch(t);
  signIn(home, { access_token: 'signed-in-token', token_type: 'Bearer' });
  const placeholders = { url: 'DOCS_URL', token: 'DOCS_TOKEN' };
  const settings = defaultSettings();
  settings.mcp_servers = [
    {
      name: 'docs',
      url: endpoint,
      transport: 'streamable_http',
      enabled: false,
      placeholders,
    },
    { name: 'local', command: 'synthetic', transport: 'stdio', placeholders },
  ];
  assert.deepEqual(mcpPlaceholders(home, settings, nothingSaved), none);
  settings.mcp_servers = [
    { name: 'docs', url: endpoint, transport: 'streamable_http', placeholders },
    {
      name: 'other',
      url: 'http://192.0.2.20/mcp',
      transport: 'streamable_http',
      placeholders,
    },
  ];
  assert.deepEqual(mcpPlaceholders(home, settings, nothingSaved), {
    variables: { DOCS_URL: endpoint },
    secrets: { DOCS_TOKEN: 'signed-in-token' },
  });
});
