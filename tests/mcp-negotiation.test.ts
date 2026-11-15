// Which MCP revision Circle speaks with a server: by default it asks a server reached over Streamable HTTP, and a
// program it starts, for 2026-07-28 (`server/discover`), and falls back to `initialize` when the server does not speak
// it; what a program answered is kept for 7 days by the manager's clock. CIRCLE_MCP_PROTOCOL_NEGOTIATION=auto asks
// every time and `legacy` never asks. The real effects checked are what the servers received and the program starts
// noted in a file.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { McpManager } from '../src/mcp_loader.js';
import { MCP_PROTOCOL_FILE, REMEMBER_MS } from '../src/mcp_protocol.js';
import { cleanup, scratch } from './helpers.js';
import {
  mcpStub,
  modernRequest,
  type McpStub,
  type StubTool,
} from './mcp-stub.js';

const FIXTURE = resolve('tests/fixtures/mcp-server.ts');
const tool: StubTool = {
  name: 'look',
  inputSchema: { type: 'object', properties: {} },
};
const context = { sessionId: 'one', signal: new AbortController().signal };
const methods = (stub: McpStub): string[] =>
  stub.requests.flatMap((request) =>
    request.message ? [request.message.method] : [],
  );
/** CIRCLE_MCP_PROTOCOL_NEGOTIATION for this test only. */
function negotiation(t: TestContext, value: string): void {
  const before = process.env.CIRCLE_MCP_PROTOCOL_NEGOTIATION;
  process.env.CIRCLE_MCP_PROTOCOL_NEGOTIATION = value;
  t.after(() => {
    if (before === undefined)
      delete process.env.CIRCLE_MCP_PROTOCOL_NEGOTIATION;
    else process.env.CIRCLE_MCP_PROTOCOL_NEGOTIATION = before;
  });
}
/**
 * A manager with time enough for a program to answer the question for its revision however busy the machine: the
 * answer, not the question's limit, decides here. The test of a program that never answers sets its own limit.
 */
function manager(
  workspace: string,
  services: ConstructorParameters<typeof McpManager>[3] = {},
): McpManager {
  const made = new McpManager(workspace, 120_000, undefined, services);
  made.probeMs = 60_000;
  return made;
}
async function connected(
  t: TestContext,
  servers: Parameters<McpManager['load']>[0],
  services: ConstructorParameters<typeof McpManager>[3] = {},
): Promise<McpManager> {
  const made = manager(scratch(t), services);
  cleanup(t, () => made.close());
  await made.load(servers);
  return made;
}

test('a server on the 2026-07-28 revision is asked for it and connected so: no initialize, and every request names the revision', async (t) => {
  const stub = await mcpStub(t, { modern: true, tools: [tool] });
  const mcp = await connected(t, { lab: { type: 'http', url: stub.url } });
  assert.equal(mcp.status[0]!.error, '', mcp.describe());
  assert.equal(methods(stub)[0], 'server/discover');
  assert.ok(!methods(stub).includes('initialize'));
  assert.match(String(await mcp.tools[0]!.run({}, context)), /ran look/);
  const call = stub.calls()[0]!;
  assert.ok(modernRequest(call));
  // The client's capabilities go with each request on this revision
  assert.deepEqual(
    call.message!.params!._meta!['io.modelcontextprotocol/clientCapabilities'],
    { elicitation: { form: {}, url: {} } },
  );
  assert.equal(call.headers['mcp-protocol-version'], '2026-07-28');
});

test('a server of an earlier revision is asked, and connected with initialize as before', async (t) => {
  const stub = await mcpStub(t, { tools: [tool] });
  const mcp = await connected(t, { lab: { type: 'http', url: stub.url } });
  assert.equal(mcp.status[0]!.error, '', mcp.describe());
  assert.deepEqual(methods(stub).slice(0, 2), [
    'server/discover',
    'initialize',
  ]);
  assert.match(String(await mcp.tools[0]!.run({}, context)), /ran look/);
  assert.ok(!modernRequest(stub.calls()[0]!));
});

test('CIRCLE_MCP_PROTOCOL_NEGOTIATION=legacy asks no server: one on 2026-07-28 is connected with initialize too', async (t) => {
  negotiation(t, 'legacy');
  const stub = await mcpStub(t, { modern: true, tools: [tool] });
  const mcp = await connected(t, { lab: { type: 'http', url: stub.url } });
  assert.equal(mcp.status[0]!.error, '', mcp.describe());
  assert.ok(!methods(stub).includes('server/discover'));
  assert.equal(methods(stub)[0], 'initialize');
  assert.match(String(await mcp.tools[0]!.run({}, context)), /ran look/);
  assert.ok(!modernRequest(stub.calls()[0]!));
});

test('a server over the older HTTP+SSE transport is not asked for the revision', async (t) => {
  const stub = await mcpStub(t, { modern: true, tools: [tool] });
  const mcp = await connected(t, { lab: { type: 'sse', url: stub.sseUrl } });
  assert.equal(mcp.status[0]!.error, '', mcp.describe());
  assert.ok(!methods(stub).includes('server/discover'));
  assert.ok(methods(stub).includes('initialize'));
});

/** A program of the fixture, which notes each question for its revision in `log`. */
const program = (log: string, env: Record<string, string> = {}) => ({
  lab: {
    type: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: { TEST_PROBE_LOG: log, ...env },
  },
});
const asked = (log: string): number =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;

test("a program that answers it speaks an earlier revision is not asked again for 7 days, by the manager's clock", async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const log = join(scratch(t), 'asked');
  let now = Date.UTC(2026, 10, 1);
  const connect = async (): Promise<void> => {
    const mcp = manager(workspace, { home });
    mcp.now = () => now;
    try {
      await mcp.load(program(log));
      assert.equal(mcp.status[0]!.error, '', mcp.describe());
      // It runs as it did before Circle asked anything
      assert.match(
        String(
          await mcp.tools
            .find((item) => item.name === 'mcp__lab__environment')!
            .run({}, context),
        ),
        /"pid"/,
      );
    } finally {
      await mcp.close();
    }
  };
  await connect();
  assert.equal(asked(log), 1);
  // What it answered is kept in the home, by a digest of what starts it: no value of its entry is in the file
  const kept = readFileSync(join(home, MCP_PROTOCOL_FILE), 'utf8');
  assert.match(kept, /"era": "legacy"/);
  assert.doesNotMatch(kept, /TEST_PROBE_LOG|mcp-server/);
  if (process.platform !== 'win32')
    assert.equal(statSync(join(home, MCP_PROTOCOL_FILE)).mode & 0o777, 0o600);
  now += REMEMBER_MS - 60_000;
  await connect();
  assert.equal(asked(log), 1, 'not asked within 7 days');
  now += 120_000;
  await connect();
  assert.equal(asked(log), 2, 'asked again after 7 days');
});

test('CIRCLE_MCP_PROTOCOL_NEGOTIATION=auto asks a program every time, whatever it answered before', async (t) => {
  negotiation(t, 'auto');
  const home = scratch(t);
  const workspace = scratch(t);
  const log = join(scratch(t), 'asked');
  for (let i = 0; i < 2; i++) {
    const mcp = manager(workspace, { home });
    await mcp.load(program(log));
    assert.equal(mcp.status[0]!.error, '', mcp.describe());
    await mcp.close();
  }
  assert.equal(asked(log), 2);
});

test('a program on the 2026-07-28 revision is connected so, and asked again at its next start', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const log = join(scratch(t), 'asked');
  for (let i = 0; i < 2; i++) {
    const mcp = manager(workspace, { home });
    await mcp.load(program(log, { TEST_MODERN: '1' }));
    assert.equal(mcp.status[0]!.error, '', mcp.describe());
    const result = String(
      await mcp.tools
        .find((item) => item.name === 'mcp__lab__environment')!
        .run({}, context),
    );
    assert.match(result, /"pid"/);
    await mcp.close();
  }
  assert.equal(asked(log), 2);
  assert.match(
    readFileSync(join(home, MCP_PROTOCOL_FILE), 'utf8'),
    /"era": "modern"/,
  );
});

test('a program that exits when asked, or does not answer in time, is started again and connected with initialize', async (t) => {
  for (const silent of [false, true]) {
    const home = scratch(t);
    const log = join(scratch(t), 'asked');
    const mcp = manager(scratch(t), { home });
    cleanup(t, () => mcp.close());
    // The question's own limit, short for the program that never answers it, so the test does not wait long
    if (silent) mcp.probeMs = 100;
    await mcp.load(
      program(
        log,
        silent ? { TEST_SILENT_PROBE: '1' } : { TEST_EXIT_ON_PROBE: '1' },
      ),
    );
    assert.equal(mcp.status[0]!.error, '', mcp.describe());
    // The program that exits was asked before it did; whether the silent one read the question in time is not checked
    if (!silent) assert.equal(asked(log), 1);
    assert.match(
      readFileSync(join(home, MCP_PROTOCOL_FILE), 'utf8'),
      /"era": "legacy"/,
    );
  }
});

test('CIRCLE_MCP_PROTOCOL_NEGOTIATION=legacy never asks a program', async (t) => {
  negotiation(t, 'legacy');
  const log = join(scratch(t), 'asked');
  const mcp = await connected(t, program(log, { TEST_MODERN: '1' }), {
    home: scratch(t),
  });
  assert.equal(mcp.status[0]!.error, '', mcp.describe());
  assert.equal(asked(log), 0);
});
