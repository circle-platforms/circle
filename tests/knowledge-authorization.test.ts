import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, statSync } from 'node:fs';
import {
  McpManager,
  backgroundMcpConnection,
  buildMcpConnections,
} from '../src/mcp_loader.js';
import { keptFor, forgetAuthorization, mcpAuthPath } from '../src/mcp_auth.js';
import {
  mcpSyncHttp,
  KnowledgeConnection,
} from '../src/knowledge/connection.js';
import { defaultSettings, saveSettings } from '../src/settings.js';
import { AuthorizedServer } from './fixtures/knowledge-sync/authorized-server.js';
import { scratch, cleanup, until } from './helpers.js';
import { KnowledgeService } from '../src/knowledge/service.js';

const signal = new AbortController().signal;
async function world(t: Parameters<typeof scratch>[0]) {
  const home = scratch(t, 'circle-auth-sync-'),
    server = new AuthorizedServer(scratch(t, 'circle-auth-peer-'));
  await server.start();
  cleanup(t, () => server.close());
  const provider = await server.seed(home);
  const connection = {
    name: 'selected',
    transport: 'streamable_http' as const,
    url: server.origin + '/mcp',
  };
  const manager = new McpManager(
    scratch(t, 'circle-auth-work-'),
    undefined,
    undefined,
    {
      home,
      openUrl: async () => {
        throw Error('background opened browser');
      },
    },
  );
  cleanup(t, () => manager.close());
  return { home, server, provider, connection, manager };
}

test('MCP and sync share one rotating refresh and preserve their opaque grant identity', async (t) => {
  const w = await world(t),
    before = keptFor(w.home, w.connection.url).grant_id,
    port = backgroundMcpConnection(w.home, w.connection, () => ({}));
  await Promise.all([
    w.manager.load([w.connection], new Set()),
    mcpSyncHttp(port).request('state', {
      schema: 'personal-sync-state@1',
      signal,
    }),
  ]);
  assert.equal(w.server.tokenRequests.length, 1);
  assert.equal(w.manager.status[0]!.error, '');
  assert.equal(keptFor(w.home, w.connection.url).grant_id, before);
  assert.equal(
    backgroundMcpConnection(w.home, w.connection, () => ({})).binding,
    port.binding,
  );
  assert.equal(w.server.tokenRequests[0]!.get('resource'), w.connection.url);
  assert.equal(w.server.tokenRequests[0]!.get('client_id'), 'synthetic-client');
  assert.equal(
    statSync(mcpAuthPath(w.home)).mode & 0o777,
    process.platform === 'win32'
      ? statSync(mcpAuthPath(w.home)).mode & 0o777
      : 0o600,
  );
});

test('two SDK providers with a non-rotating refresh token still share the accepted access token', async (t) => {
  const w = await world(t);
  w.server.rotatesRefresh = false;
  const before = keptFor(w.home, w.connection.url).grant_id;
  const ports = [
    backgroundMcpConnection(w.home, w.connection, () => ({})),
    backgroundMcpConnection(w.home, w.connection, () => ({})),
  ];
  await Promise.all(
    ports.map((port) =>
      mcpSyncHttp(port).request('state', {
        schema: 'personal-sync-state@1',
        signal,
      }),
    ),
  );
  assert.equal(w.server.tokenRequests.length, 1);
  assert.equal(keptFor(w.home, w.connection.url).grant_id, before);
});

test('refresh failure pauses sync without registration, authorization redirects or token text in the error', async (t) => {
  const w = await world(t);
  w.server.refreshFails = true;
  const port = backgroundMcpConnection(w.home, w.connection, () => ({}));
  await assert.rejects(
    mcpSyncHttp(port).request('state', {
      schema: 'personal-sync-state@1',
      signal,
    }),
    (error) => {
      assert.doesNotMatch(String(error), /synthetic-refresh|synthetic-expired/);
      return true;
    },
  );
  await w.manager.load([w.connection], new Set());
  assert.equal(w.manager.status[0]!.authorize, undefined);
  assert.ok(w.manager.status[0]!.error);
  assert.equal(
    w.server.requests.filter(
      (r) => r.path === '/authorize' || r.path === '/register',
    ).length,
    0,
  );
});

test('logout during a refresh cannot resurrect authorization or accept its in-flight response', async (t) => {
  const w = await world(t);
  let entered!: () => void, release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  w.server.gateRefresh = async () => {
    entered();
    await gate;
  };
  const port = backgroundMcpConnection(w.home, w.connection, () => ({})),
    request = mcpSyncHttp(port).request('state', { signal });
  await started;
  forgetAuthorization(w.home, w.connection.url);
  release();
  await assert.rejects(request);
  assert.equal(keptFor(w.home, w.connection.url).tokens, undefined);
  assert.equal(keptFor(w.home, w.connection.url).grant_id, undefined);
});

test('direct Bearer replacement invalidates only its selected profile and never enters the sync journal', async (t) => {
  const home = scratch(t, 'circle-direct-binding-');
  let secret = 'synthetic-first-bearer';
  const connection = {
    name: 'direct',
    transport: 'streamable_http' as const,
    url: 'https://example.test/mcp',
    headers: { authorization: 'Bearer ${secret:SYNC_TOKEN}' },
  };
  const first = backgroundMcpConnection(home, connection, () => ({
    SYNC_TOKEN: secret,
  }));
  assert.equal(await first.token(signal), secret);
  const other = backgroundMcpConnection(
    home,
    {
      ...connection,
      name: 'other',
      headers: { authorization: 'Bearer synthetic-other-bearer' },
    },
    () => ({}),
  );
  assert.equal(await first.token(signal), secret);
  secret = 'synthetic-second-bearer';
  assert.throws(() => first.assertActive());
  const replacement = backgroundMcpConnection(home, connection, () => ({
    SYNC_TOKEN: secret,
  }));
  assert.notEqual(replacement.binding, first.binding);
  assert.equal(await other.token(signal), 'synthetic-other-bearer');
  assert.doesNotMatch(
    readFileSync(mcpAuthPath(home), 'utf8'),
    /synthetic-first-bearer|synthetic-second-bearer|synthetic-other-bearer/,
  );
});

test('only the explicitly selected connection syncs and changing its grant requires a new person selection', async (t) => {
  const w = await world(t);
  await w.manager.load([w.connection], new Set());
  const settings = defaultSettings();
  settings.mcp_servers = [
    w.connection,
    { name: 'unselected', url: 'https://unselected.invalid/mcp' },
  ];
  saveSettings(settings, w.home);
  const host = new KnowledgeConnection(
    w.home,
    () => settings,
    () => ({}),
    w.manager,
  );
  cleanup(t, () => host.close());
  await host.configure();
  assert.equal(w.server.peer.calls.length, 0);
  const preview = host.preview('selected');
  await host.select('selected', preview.binding);
  await host.synchronize();
  assert.equal(host.status().condition, 'synced');
  forgetAuthorization(w.home, w.connection.url);
  await until(() => host.status().condition === 'login-required');
  const calls = w.server.peer.calls.length;
  await host.configure();
  assert.equal(w.server.peer.calls.length, calls);
  assert.equal(host.status().condition, 'login-required');
});

test('two real processes coordinate a rotating token through the same private-store refresh lock', async (t) => {
  const w = await world(t);
  const { spawn } = await import('node:child_process'),
    { fileURLToPath } = await import('node:url');
  const child = () => {
    const processChild = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(
          new URL('./fixtures/knowledge-sync/auth-worker.ts', import.meta.url),
        ),
        w.home,
        w.connection.url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    processChild.stdout.on('data', (chunk) => (output += String(chunk)));
    let error = '';
    processChild.stderr.on('data', (chunk) => (error += String(chunk)));
    cleanup(t, () => {
      if (processChild.exitCode === null) processChild.kill('SIGKILL');
    });
    return new Promise<any>((resolve, reject) => {
      processChild.once('exit', (code) => {
        if (code !== 0) reject(Error(error));
        else resolve(JSON.parse(output.trim().split('\n').at(-1)!));
      });
    });
  };
  const [first, second] = await Promise.all([child(), child()]);
  assert.equal(first.digest, second.digest);
  assert.equal(first.grant, second.grant);
  assert.equal(w.server.tokenRequests.length, 1);
});

test('canceling one refresh waiter keeps the other alive, while canceling the sole waiter releases its network request and lock', async (t) => {
  const w = await world(t);
  let entered!: () => void, release!: () => void;
  let reached = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  w.server.gateRefresh = async () => {
    entered();
    await gate;
  };
  const firstPort = backgroundMcpConnection(w.home, w.connection, () => ({})),
    secondPort = backgroundMcpConnection(w.home, w.connection, () => ({})),
    controller = new AbortController();
  const first = firstPort.token(controller.signal, 'synthetic-expired-access'),
    second = secondPort.token(signal, 'synthetic-expired-access');
  await reached;
  controller.abort(Error('synthetic waiter canceled'));
  await assert.rejects(first);
  release();
  assert.equal(await second, w.server.token);
  assert.equal(w.server.tokenRequests.length, 1);
  const current = keptFor(w.home, w.connection.url).tokens!.access_token;
  reached = new Promise<void>((r) => (entered = r));
  gate = new Promise<void>((r) => (release = r));
  const sole = new AbortController();
  const pending = firstPort.token(sole.signal, current);
  await reached;
  sole.abort(Error('synthetic sole waiter canceled'));
  await assert.rejects(pending);
  release();
  w.server.gateRefresh = undefined;
  assert.equal(keptFor(w.home, w.connection.url).tokens!.access_token, current);
});

test('explicit MCP reauthorization uses PKCE, changes the binding, and leaves the old local queue paused until another person selection', async (t) => {
  const w = await world(t);
  await w.manager.load([w.connection], new Set());
  const settings = defaultSettings();
  settings.mcp_servers = [w.connection];
  saveSettings(settings, w.home);
  const host = new KnowledgeConnection(
    w.home,
    () => settings,
    () => ({}),
    w.manager,
  );
  cleanup(t, () => host.close());
  const preview = host.preview('selected');
  await host.select('selected', preview.binding);
  await host.synchronize();
  forgetAuthorization(w.home, w.connection.url);
  (w.manager as any).services.openUrl = async (url: string) => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
  };
  await w.manager.load([w.connection], new Set());
  await until(() => w.manager.status[0]?.error === '');
  const fresh = host.preview('selected');
  assert.notEqual(fresh.binding, preview.binding);
  const calls = w.server.peer.calls.length;
  await host.configure();
  assert.equal(host.status().condition, 'login-required');
  assert.equal(w.server.peer.calls.length, calls);
  await host.select('selected', fresh.binding);
  await host.synchronize();
  assert.equal(host.status().condition, 'synced');
  assert.ok(
    w.server.tokenRequests.some(
      (form) =>
        form.get('grant_type') === 'authorization_code' &&
        form.has('code_verifier'),
    ),
  );
});

test('expired saved tokens refresh before sync dispatch and an issuer or resource mismatch sends no refresh token', async (t) => {
  const w = await world(t);
  await w.server.seed(w.home, 0);
  const port = backgroundMcpConnection(w.home, w.connection, () => ({}));
  await mcpSyncHttp(port).request('state', {
    schema: 'personal-sync-state@1',
    signal,
  });
  assert.equal(w.server.tokenRequests.length, 1);
  assert.equal(w.server.peer.calls.length, 1);
  const provider = await w.server.seed(w.home, 0),
    current = provider.discoveryState()!;
  provider.saveDiscoveryState({
    ...current,
    resourceMetadata: {
      ...current.resourceMetadata!,
      resource: 'https://other.invalid/mcp',
    },
  });
  const count = w.server.tokenRequests.length;
  await assert.rejects(
    backgroundMcpConnection(w.home, w.connection, () => ({})).token(signal),
  );
  assert.equal(w.server.tokenRequests.length, count);
  provider.saveDiscoveryState(current);
  provider.saveTokens({
    ...provider.tokens()!,
    issuer: 'https://other.invalid',
  });
  await assert.rejects(
    backgroundMcpConnection(w.home, w.connection, () => ({})).token(signal),
  );
  assert.equal(w.server.tokenRequests.length, count);
});

test('a persistent 401 keeps the exact pending operation and an explicit same-grant retry resumes it', async (t) => {
  const w = await world(t);
  await w.manager.load([w.connection], new Set());
  const settings = defaultSettings();
  settings.mcp_servers = [w.connection];
  saveSettings(settings, w.home);
  const host = new KnowledgeConnection(
    w.home,
    () => settings,
    () => ({}),
    w.manager,
  );
  cleanup(t, () => host.close());
  await host.select('selected', host.preview('selected').binding);
  const service = new KnowledgeService(w.home);
  service
    .prepareMemory({
      expected_head: null,
      title: 'retained',
      markdown: 'synthetic retained preference',
    })
    .commit(signal);
  w.server.peer.onRequest = (route) => {
    if (route === 'upload')
      w.server.peer.errorNext = {
        route: 'upload',
        status: 401,
        code: 'SOURCE_UNAVAILABLE',
      };
  };
  await assert.rejects(host.synchronize());
  assert.equal(host.status().condition, 'login-required');
  const initial = w.server.peer.calls.find((c) => c.route === 'upload')!.body;
  w.server.peer.onRequest = null;
  await host.synchronize();
  assert.equal(host.status().condition, 'synced');
  const replay = w.server.peer.calls
    .filter((c) => c.route === 'upload')
    .findLast((c) => c.body.operation_id === initial.operation_id)!.body;
  assert.deepEqual(replay, initial);
});

test('a configuration changed by another process stops the old client until settings are reloaded', async (t) => {
  const w = await world(t);
  await w.manager.load([w.connection], new Set());
  const settings = defaultSettings();
  settings.mcp_servers = [w.connection];
  saveSettings(settings, w.home);
  const host = new KnowledgeConnection(
    w.home,
    () => settings,
    () => ({}),
    w.manager,
  );
  cleanup(t, () => host.close());
  await host.select('selected', host.preview('selected').binding);
  await host.synchronize();
  const external = {
    ...settings,
    mcp_servers: [{ ...w.connection, url: 'https://different.invalid/mcp' }],
  };
  saveSettings(external, w.home);
  await until(
    () =>
      host.status().condition === 'login-required' ||
      host.status().condition === 'paused',
  );
  const count = w.server.peer.calls.length;
  await host.configure();
  assert.equal(host.status().condition, 'paused');
  assert.equal(w.server.peer.calls.length, count);
});

test('a transport failure after an accepted refresh stays retryable rather than requesting another login', async (t) => {
  const w = await world(t);
  w.server.peer.onRequest = (route) => {
    if (route === 'state') w.server.server.closeAllConnections();
  };
  const port = backgroundMcpConnection(w.home, w.connection, () => ({}));
  await assert.rejects(
    mcpSyncHttp(port).request('state', { signal }),
    (error: any) => {
      assert.equal(error.status, 0);
      assert.equal(error.code, 'SOURCE_RETRYABLE');
      return true;
    },
  );
  assert.equal(w.server.tokenRequests.length, 1);
  assert.ok(keptFor(w.home, w.connection.url).tokens);
});
