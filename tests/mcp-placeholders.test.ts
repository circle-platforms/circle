// What MCP server entries give the %NAME% placeholders: an HTTP entry's endpoint and the token its connection sends, under
// the names its `placeholders` give, never over a value the person keeps, and nothing an entry does not name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { mcpPlaceholders } from '../src/mcp_placeholders.js';
import { AgentRuntime } from '../src/runtime.js';
import { saveSecret } from '../src/secrets.js';
import { defaultSettings, writePrivateJson } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { cleanup, scratch } from './helpers.js';

const endpoint = 'http://192.0.2.10:7420/mcp';
const none = { variables: {}, secrets: {}, until: Infinity };
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
    until: Infinity,
  });
  // A token with an expiry is given until then, and says when
  const expires = Date.now() + 60_000;
  signIn(
    home,
    { access_token: 'signed-in-token', token_type: 'Bearer' },
    expires,
  );
  assert.deepEqual(mcpPlaceholders(home, settings, nothingSaved), {
    variables: { DOCS_URL: endpoint },
    secrets: { DOCS_TOKEN: 'signed-in-token' },
    until: expires,
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
    until: Infinity,
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
    until: Infinity,
  });
});

test('a run keeps what it read only while nothing it came from changed: a secret saved, or a token expired, is seen at once', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const settings = defaultSettings();
  settings.mcp_servers = [
    {
      name: 'docs',
      url: endpoint,
      transport: 'streamable_http',
      placeholders: { url: 'DOCS_URL', token: 'DOCS_TOKEN' },
    },
  ];
  signIn(
    home,
    { access_token: 'short-lived', token_type: 'Bearer' },
    Date.now() + 400,
  );
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model: new ScriptedModel([]),
  });
  cleanup(t, () => runtime.close());
  assert.equal(runtime.runSecrets().DOCS_TOKEN, 'short-lived');
  assert.equal(runtime.runVariables().DOCS_URL, endpoint);
  // Read again: the same values, from what was kept
  assert.equal(runtime.runSecrets().DOCS_TOKEN, 'short-lived');
  saveSecret(home, 'MINE', 'synthetic-secret');
  assert.equal(runtime.runSecrets().MINE, 'synthetic-secret');
  await delay(450);
  assert.equal(runtime.runSecrets().DOCS_TOKEN, undefined);
  assert.equal(runtime.runSecrets().MINE, 'synthetic-secret');
});
