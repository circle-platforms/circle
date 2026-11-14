import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { McpManager } from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, saveSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { cleanup, scratch, until } from './helpers.js';
import { mcpStub, type McpStub, type StubOptions } from './mcp-stub.js';

// How Circle keeps a server's connection: reconnecting a dropped one, trying a first connection and a listing again,
// a program that exits, a session the server forgot, and the time limits of a call.
const FIXTURE = resolve('tests/fixtures/mcp-server.ts');
const schema = { type: 'object', properties: {} };
const tools = [
  { name: 'look', inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: 'write', inputSchema: schema },
];
const context = () => ({
  sessionId: 'one',
  signal: new AbortController().signal,
});
// Each connection, a first one and every reconnection, starts by asking the server for its revision
const starts = (stub: McpStub) =>
  stub.requests.filter(
    (request) => request.message?.method === 'server/discover',
  ).length;

/** A manager whose waits are recorded and pass at once. */
function manager(
  t: TestContext,
  services: ConstructorParameters<typeof McpManager>[3] = {},
) {
  const waits: number[] = [];
  const made = new McpManager(scratch(t), 30_000, undefined, services);
  made.wait = async (ms) => {
    waits.push(ms);
  };
  cleanup(t, () => made.close());
  return { manager: made, waits };
}
async function remote(t: TestContext, options: StubOptions = {}) {
  const stub = await mcpStub(t, { tools, ...options });
  const made = manager(t);
  await made.manager.load({ files: { type: 'http', url: stub.url } });
  return { stub, ...made };
}
const serverOf = (manager: McpManager) =>
  (manager as unknown as { servers: { client: { close(): Promise<void> } }[] })
    .servers[0]!;
const run = (manager: McpManager, name: string) =>
  manager.tools
    .find((tool) => tool.name === `mcp__files__${name}`)!
    .run({}, context());

test('a server reached over the network that drops is connected again in the background, after 1, 2, 4, 8 and 16 seconds, and is failed after the fifth try', async (t) => {
  const { stub, manager: mcp, waits } = await remote(t);
  await stub.pause();
  // As when the server goes away: its connection ends without Circle closing it
  await serverOf(mcp).client.close();
  assert.match(mcp.status[0]!.error, /^the connection ended; reconnecting/);
  await until(() => /^disconnected/.test(mcp.status[0]!.error));
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
  assert.match(
    mcp.status[0]!.error,
    /disconnected: 5 tries to connect again failed .*\/mcp reconnect files tries again/,
  );
  // Back, and connected again by hand
  await stub.resume();
  await mcp.reloadServer('files', { files: { type: 'http', url: stub.url } });
  assert.equal(mcp.status[0]!.error, '');
  assert.match(await run(mcp, 'write'), /ran write/);
});

test('a dropped server that comes back during the tries is connected again, and a call meanwhile waits for it', async (t) => {
  const { stub, manager: mcp } = await remote(t);
  const before = starts(stub);
  await serverOf(mcp).client.close();
  assert.match(await run(mcp, 'look'), /ran look/);
  assert.equal(starts(stub), before + 1);
  assert.equal(mcp.status[0]!.error, '');
});

test('a first connection that fails with a 5xx or a refused connection is tried three more times; an authorization or not-found answer is not', async (t) => {
  let refusals = 2;
  const stub = await mcpStub(t, {
    tools,
    refuse: (request) =>
      request.message?.method === 'initialize' && refusals-- > 0
        ? { status: 503, body: 'starting' }
        : undefined,
  });
  const { manager: mcp, waits } = manager(t);
  await mcp.load({ files: { type: 'http', url: stub.url } });
  assert.equal(mcp.status[0]!.error, '', mcp.describe());
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(starts(stub), 3);
  // Never up: three more tries, then the server is failed
  const down = await mcpStub(t, {
    refuse: () => ({ status: 502, body: 'bad gateway' }),
  });
  const failing = manager(t);
  await failing.manager.load({ down: { type: 'http', url: down.url } });
  assert.notEqual(failing.manager.status[0]!.error, '');
  assert.deepEqual(failing.waits, [1000, 2000, 4000]);
  assert.equal(starts(down), 4);
  // A 404 needs another address, not another try
  const missing = await mcpStub(t, {
    refuse: () => ({ status: 404, body: 'no such endpoint' }),
  });
  const once = manager(t);
  await once.manager.load({ missing: { type: 'http', url: missing.url } });
  assert.deepEqual(once.waits, []);
  assert.equal(starts(missing), 1);
});

test('a listing of the tools that fails with a 5xx is made again, three more times at most', async (t) => {
  let refusals = 2;
  const stub = await mcpStub(t, {
    tools,
    refuse: (request) =>
      request.message?.method === 'tools/list' && refusals-- > 0
        ? { status: 500, body: 'busy' }
        : undefined,
  });
  const { manager: mcp, waits } = manager(t);
  await mcp.load({ files: { type: 'http', url: stub.url } });
  assert.equal(mcp.status[0]!.error, '', mcp.describe());
  assert.deepEqual(waits, [250, 500]);
  assert.equal(mcp.tools.length, 2);
});

test('a session the server forgot (HTTP 404) is started again and the call sent once more, whatever the tool says of itself', async (t) => {
  const { stub, manager: mcp } = await remote(t, { sessions: true });
  assert.match(await run(mcp, 'write'), /ran write/);
  stub.dropSessions();
  assert.match(await run(mcp, 'write'), /ran write/);
  assert.equal(starts(stub), 2);
  // The call the server refused, then the one it ran
  const writes = stub
    .calls()
    .filter((request) => request.message?.params?.name === 'write');
  assert.equal(writes.length, 3);
});

test('where someone can reconnect it, a program that exits is failed until /mcp reconnect; otherwise the next call starts it again', async (t) => {
  for (const interactive of [true, false]) {
    const { manager: mcp } = manager(t, { interactive });
    await mcp.load({
      fixture: { command: process.execPath, args: [FIXTURE] },
    });
    const environment = () =>
      mcp.tools
        .find((tool) => tool.name === 'mcp__fixture__environment')!
        .run({}, context());
    const first = JSON.parse(await environment()) as { pid: number };
    process.kill(first.pid);
    await until(() => mcp.status[0]!.error !== '', { timeout: 10_000 });
    if (interactive) {
      assert.match(
        mcp.status[0]!.error,
        /the program exited; \/mcp reconnect fixture starts it again/,
      );
      await assert.rejects(
        environment(),
        /the program of fixture exited; \/mcp reconnect fixture starts it again/,
      );
      await mcp.reloadServer('fixture', {
        fixture: { command: process.execPath, args: [FIXTURE] },
      });
    } else
      assert.match(
        mcp.status[0]!.error,
        /the program exited; the next call starts it again/,
      );
    const again = JSON.parse(await environment()) as { pid: number };
    assert.notEqual(again.pid, first.pid);
  }
});

// Starts the fixture's login.wait and lets `seconds` pass on a mocked clock; says whether the call ended then.
async function waitThrough(
  t: TestContext,
  mcp: McpManager,
  root: string,
  seconds: number,
) {
  const release = join(root, `release-${crypto.randomUUID()}`);
  const started = release + '.started';
  let ended: unknown;
  const call = mcp.tools
    .find((tool) => tool.name === 'mcp__fixture__login_wait')!
    .run({ path: release, started }, context());
  call.then(
    () => (ended = 'answered'),
    (error: Error) => (ended = error),
  );
  const deadline = performance.now() + 10_000;
  while (!existsSync(started)) {
    assert.ok(performance.now() < deadline, 'the fixture never got the call');
    await new Promise((done) => setImmediate(done));
  }
  t.mock.timers.tick(seconds * 1000);
  for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
  writeFileSync(release, '');
  return { ended: () => ended, call };
}

test("a server's timeout is the most one of its calls may take, and a call with neither an answer nor progress ends at the idle limit", async (t) => {
  const root = scratch(t);
  const timed = new McpManager(root);
  cleanup(t, () => timed.close());
  await timed.load({
    fixture: { command: process.execPath, args: [FIXTURE], timeout: 5000 },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const short = await waitThrough(t, timed, root, 5.001);
    t.mock.timers.reset();
    assert.match(String(short.ended()), /timed out/i);
    await short.call.catch(() => {});
  } finally {
    t.mock.timers.reset();
  }
  process.env.CIRCLE_MCP_TOOL_IDLE_TIMEOUT = '60000';
  cleanup(t, () => {
    delete process.env.CIRCLE_MCP_TOOL_IDLE_TIMEOUT;
  });
  const idle = new McpManager(root);
  cleanup(t, () => idle.close());
  await idle.load({ fixture: { command: process.execPath, args: [FIXTURE] } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const quiet = await waitThrough(t, idle, root, 60.001);
    t.mock.timers.reset();
    assert.match(String(quiet.ended()), /timed out/i);
    await quiet.call.catch(() => {});
  } finally {
    t.mock.timers.reset();
  }
});

test('/mcp reconnect all connects again the servers that failed, and leaves the connected ones as they are', async (t) => {
  const root = scratch(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const up = await mcpStub(t, { tools });
  const down = await mcpStub(t, { tools });
  await down.pause();
  const settings = defaultSettings();
  settings.mcpServers = {
    up: { type: 'http', url: up.url },
    down: { type: 'http', url: down.url },
  };
  const home = join(root, 'home');
  mkdirSync(home);
  saveSettings(settings, home);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model: new ScriptedModel([]),
  });
  cleanup(t, () => runtime.close());
  // No waits between the first tries: the server stays down for all of them
  runtime.mcp.connectWaitsMs = [];
  await runtime.initialize();
  assert.notEqual(
    runtime.mcp.status.find((row) => row.name === 'down')!.error,
    '',
  );
  await down.resume();
  const before = starts(up);
  assert.deepEqual(await runtime.reconnectMcpServers(), ['down']);
  assert.equal(
    runtime.mcp.status.find((row) => row.name === 'down')!.error,
    '',
  );
  assert.ok(
    runtime.harness.tools.some((tool) => tool.name === 'mcp__down__look'),
  );
  assert.equal(starts(up), before);
});

test('a session the server forgot while it ran a task is not sent again: the model is told the tool may have run', async (t) => {
  let polls = 0;
  const task = (status: string) => ({
    taskId: 'task-1',
    status,
    ttl: null,
    createdAt: '2026-11-14T00:00:00Z',
    lastUpdatedAt: '2026-11-14T00:00:00Z',
    pollInterval: 1,
  });
  const stub: McpStub = await mcpStub(t, {
    sessions: true,
    tools: [
      {
        name: 'deploy',
        inputSchema: schema,
        execution: { taskSupport: 'optional' },
      },
    ],
    capabilities: { tasks: { cancel: {}, requests: { tools: { call: {} } } } },
    call: (request) =>
      request.message!.params!.task
        ? ({ task: task('working') } as never)
        : { content: [{ type: 'text', text: 'ran' }] },
    answer: (request) => {
      if (request.message?.method === 'tasks/result')
        return { content: [{ type: 'text', text: 'deployed' }] };
      if (request.message?.method !== 'tasks/get') return undefined;
      // The session is lost while the task is under way, as when the server restarts
      if (++polls === 1) stub.dropSessions();
      return task(polls >= 3 ? 'completed' : 'working');
    },
  });
  const { manager: mcp } = manager(t);
  await mcp.load({ ci: { type: 'http', url: stub.url } });
  await assert.rejects(
    mcp.tools[0]!.run({}, context()),
    /the server lost the session while task task-1 was running: the tool may have run, so check whether it did before calling it again/,
  );
  // The call that made the task was sent once, and nothing was sent again
  assert.equal(
    stub.calls().filter((request) => request.message?.params?.task).length,
    1,
  );
  assert.equal(starts(stub), 1);
});
