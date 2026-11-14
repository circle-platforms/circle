// How Circle keeps a 2026-07-28 server's tools current: a server that says its tools can change tells so on a stream
// Circle holds open (`subscriptions/listen`) and opens again when it closes, and a list given with `ttlMs` is listed
// again before the first turn after it expired. Checked on what the server received and on the tools the next model
// request offers; the manager's clock is a test's own.
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  afterStreamClosed,
  LISTEN_PAUSE_MS,
  TOOLS_EXPIRED_NOT_LISTED,
  type StreamHistory,
} from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { ModelResponse } from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';
import { mcpStub, type StubOptions, type StubTool } from './mcp-stub.js';

const CHANGED = 'notifications/tools/list_changed';
const tool = (name: string): StubTool => ({
  name,
  inputSchema: { type: 'object', properties: {} },
});
const answer = (content: string): Partial<ModelResponse> => ({
  message: { id: content, role: 'assistant', content },
});

async function world(t: TestContext, options: StubOptions, turns: number) {
  const root = realpathSync.native(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  // The stub reads the options a test changes
  options.modern = true;
  const stub = await mcpStub(t, options);
  const settings = defaultSettings();
  settings.mcpServers = { hub: { url: stub.url, type: 'http' } };
  writeFileSync(
    join(home, 'approvals.json'),
    JSON.stringify({ rules: [{ tool: 'mcp__hub__*', effect: 'allow' }] }),
  );
  const model = new ScriptedModel(
    Array.from({ length: turns }, (_, i) => answer(`turn ${i}`)),
  );
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model,
    userHome: join(root, 'user'),
  });
  cleanup(t, () => runtime.close());
  const clock = { now: Date.UTC(2026, 10, 1) };
  runtime.mcp.now = () => clock.now;
  // A listing that fails is tried again at once
  runtime.mcp.wait = async () => {};
  await runtime.initialize();
  const listings = () =>
    stub.requests.filter((r) => r.message?.method === 'tools/list').length;
  const offered = (request: number) =>
    model.requests[request]!.tools.map((item) => item.name).filter((name) =>
      name.startsWith('mcp__hub__'),
    );
  const status = () => runtime.mcp.status.find((s) => s.name === 'hub')!;
  return { stub, model, runtime, clock, listings, offered, status };
}

test('a server that says its tools can change tells so on a stream Circle holds open, and opens again when it closes', async (t) => {
  // A list good for an hour: what changes comes on the stream, not from the list running out
  const options: StubOptions = {
    listChanged: true,
    tools: [tool('alpha')],
    ttlMs: () => 3_600_000,
  };
  const w = await world(t, options, 3);
  await until(() => w.stub.listens() === 1);
  const listens = () =>
    w.stub.requests.filter(
      (request) => request.message?.method === 'subscriptions/listen',
    );
  assert.deepEqual(listens()[0]!.message!.params!.notifications, {
    toolsListChanged: true,
  });
  await w.runtime.harness.run('first');
  assert.deepEqual(w.offered(0), ['mcp__hub__alpha']);
  options.tools = [tool('beta')];
  w.stub.notify(CHANGED);
  await until(() => w.status().tools.includes('mcp__hub__beta'));
  await w.runtime.harness.run('second');
  assert.deepEqual(w.offered(1), ['mcp__hub__beta']);
  assert.equal(w.listings(), 2);
  // The server ends the stream: Circle opens another, and what it says there counts as before
  w.stub.endListens();
  await until(() => listens().length === 2 && w.stub.listens() === 1);
  options.tools = [tool('gamma')];
  w.stub.notify(CHANGED);
  await until(() => w.status().tools.includes('mcp__hub__gamma'));
  await w.runtime.harness.run('third');
  assert.deepEqual(w.offered(2), ['mcp__hub__gamma']);
});

test('a stream that closes at once is opened again three times in a row; longer ones pause after five reopens in an hour', () => {
  const history: StreamHistory = { quick: 0, reopened: [] };
  const start = Date.UTC(2026, 10, 1);
  // Closed within 10 seconds each time
  assert.deepEqual(
    [1, 2, 3, 4].map(() => afterStreamClosed(history, start, start + 9_000)),
    [0, 0, 0, 'stop'],
  );
  // A stream that stayed open longer starts the count again, and is opened again at once
  const longer: StreamHistory = { quick: 2, reopened: [] };
  let now = start;
  const closes: (number | 'stop')[] = [];
  for (let i = 0; i < 6; i++) {
    closes.push(afterStreamClosed(longer, now, now + 60_000));
    now += 60_000;
  }
  assert.equal(longer.quick, 0);
  assert.deepEqual(closes, [0, 0, 0, 0, 0, LISTEN_PAUSE_MS]);
  // An hour on, reopens long past no longer count
  const later: StreamHistory = { quick: 0, reopened: [start, start + 1000] };
  assert.equal(
    afterStreamClosed(
      later,
      start + 2 * 3_600_000,
      start + 2 * 3_600_000 + 20_000,
    ),
    0,
  );
  assert.equal(later.reopened.length, 1);
});

test("a list given with ttlMs is listed again before the first turn after it expired, by the manager's clock", async (t) => {
  let failing = false;
  const options: StubOptions = {
    tools: [tool('alpha')],
    ttlMs: () => 1000,
    refuse: (request) =>
      failing && request.message?.method === 'tools/list'
        ? { status: 500, body: 'synthetic failure' }
        : undefined,
  };
  const w = await world(t, options, 4);
  await w.runtime.harness.run('first');
  assert.deepEqual(w.offered(0), ['mcp__hub__alpha']);
  assert.equal(w.listings(), 1);
  options.tools = [tool('beta')];
  // Not yet expired: the list stands
  w.clock.now += 999;
  await w.runtime.harness.run('second');
  assert.deepEqual(w.offered(1), ['mcp__hub__alpha']);
  assert.equal(w.listings(), 1);
  // Expired: listed again, and the turn offers what the server lists now
  w.clock.now += 1;
  await w.runtime.harness.run('third');
  assert.equal(w.listings(), 2);
  assert.deepEqual(w.offered(2), ['mcp__hub__beta']);
  // A listing that fails keeps the earlier tools, and the status says so
  failing = true;
  options.tools = [tool('gamma')];
  w.clock.now += 1000;
  await w.runtime.harness.run('fourth');
  assert.deepEqual(w.offered(3), ['mcp__hub__beta']);
  assert.equal(w.status().error, TOOLS_EXPIRED_NOT_LISTED);
  assert.match(
    w.runtime.mcp.describe(),
    /\n {4}mcp__hub__beta\n {4}the server's list of tools expired/,
  );
});

test('a list given without ttlMs, as by a server of an earlier revision, is not listed again by the turn', async (t) => {
  const root = realpathSync.native(scratch(t));
  const stub = await mcpStub(t, { tools: [tool('alpha')] });
  const settings = defaultSettings();
  settings.mcpServers = { hub: { url: stub.url, type: 'http' } };
  const model = new ScriptedModel([answer('one'), answer('two')]);
  const runtime = new AgentRuntime({
    home: join(root, 'home'),
    workspace: root,
    settings,
    model,
    userHome: join(root, 'user'),
  });
  cleanup(t, () => runtime.close());
  let now = Date.UTC(2026, 10, 1);
  runtime.mcp.now = () => now;
  await runtime.initialize();
  await runtime.harness.run('one');
  now += 7 * 24 * 3_600_000;
  await runtime.harness.run('two');
  assert.equal(
    stub.requests.filter((r) => r.message?.method === 'tools/list').length,
    1,
  );
});
