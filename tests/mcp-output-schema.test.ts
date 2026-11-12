// A tool's result that does not match the output schema its server listed when Circle connected (#513): it arrives
// whole, as the server sent it, with what Circle can say of it; it is never thrown away, and the tools are not listed
// again for it. A result that matches reads as it always did. A local stub server stands in for the Hub.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { McpManager, UNDECLARED_STRUCTURE } from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { ModelResponse } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
import { mcpStub, type StubResult, type StubTool } from './mcp-stub.js';

// The schema the server listed when Circle connected: a run, and no field beside it
const LISTED = {
  type: 'object',
  properties: { run: { type: 'string' } },
  required: ['run'],
  additionalProperties: false,
};
const tool = (name: string, extra: Partial<StubTool> = {}): StubTool => ({
  name,
  inputSchema: { type: 'object', properties: {} },
  outputSchema: LISTED,
  ...extra,
});
// The server, upgraded since: its answer now has a `record` too
const UPGRADED: StubResult = {
  content: [{ type: 'text', text: 'run_1 started' }],
  structuredContent: { run: 'run_1', record: 'rec_1' },
};
const context = () => ({
  sessionId: 'one',
  signal: new AbortController().signal,
});
async function manager(t: TestContext, options: Parameters<typeof mcpStub>[1]) {
  const stub = await mcpStub(t, options);
  const mcp = new McpManager(realpathSync.native(scratch(t)));
  t.after(() => mcp.close());
  await mcp.load([
    { name: 'hub', url: stub.url, transport: 'streamable_http' },
  ]);
  assert.equal(mcp.status[0]?.error, '', mcp.describe());
  const listings = () =>
    stub.requests.filter((request) => request.message?.method === 'tools/list')
      .length;
  return { stub, mcp, listings };
}

test('a result unlike the schema the tool was listed with arrives whole, with what Circle can say of it, and nothing is listed again', async (t) => {
  const { mcp, listings } = await manager(t, {
    tools: [tool('start_run')],
    call: () => UPGRADED,
  });
  const before = listings();
  assert.equal(
    await mcp.tools[0]!.run({}, context()),
    `run_1 started\n\n${UNDECLARED_STRUCTURE}\n{"run":"run_1","record":"rec_1"}`,
  );
  assert.equal(listings(), before, 'no tools/list for it');

  // With no text, the structure alone, said the same way
  const bare = await manager(t, {
    tools: [tool('start_run')],
    call: () => ({
      content: [],
      structuredContent: UPGRADED.structuredContent,
    }),
  });
  assert.equal(
    await bare.mcp.tools[0]!.run({}, context()),
    `${UNDECLARED_STRUCTURE}\n{"run":"run_1","record":"rec_1"}`,
  );
});

test('a result that matches its schema, or that has no structure, reads as it always did', async (t) => {
  const matching = await manager(t, {
    tools: [tool('start_run')],
    call: () => ({
      content: [{ type: 'text', text: 'run_1 started' }],
      structuredContent: { run: 'run_1' },
    }),
  });
  assert.equal(
    await matching.mcp.tools[0]!.run({}, context()),
    'run_1 started',
  );
  const textOnly = await manager(t, {
    tools: [tool('start_run')],
    // The SDK refused this: a tool with an output schema that returned no structure
    call: () => ({ content: [{ type: 'text', text: 'run_1 started' }] }),
  });
  assert.equal(
    await textOnly.mcp.tools[0]!.run({}, context()),
    'run_1 started',
  );
  // A schema that cannot be compiled (it names a definition it does not have) says nothing either way
  const unreadable = await manager(t, {
    tools: [
      tool('start_run', {
        outputSchema: {
          type: 'object',
          properties: { run: { $ref: '#/definitions/missing' } },
        },
      }),
    ],
    call: () => UPGRADED,
  });
  assert.equal(
    await unreadable.mcp.tools[0]!.run({}, context()),
    'run_1 started',
  );
});

test("an error is the tool's own word: its structure is not checked, and with no text its structure is the message", async (t) => {
  const failing = await manager(t, {
    tools: [tool('submit_result')],
    call: (request) =>
      request.message?.params?.arguments?.bare
        ? { isError: true, content: [], structuredContent: { code: 'X1' } }
        : {
            isError: true,
            content: [{ type: 'text', text: 'not accepted' }],
            structuredContent: { code: 'X1', detail: 'not listed' },
          },
  });
  await assert.rejects(
    failing.mcp.tools[0]!.run({}, context()),
    (error: Error) => error.message === 'not accepted',
  );
  await assert.rejects(
    failing.mcp.tools[0]!.run({ bare: true }, context()),
    (error: Error) => error.message === '{"code":"X1"}',
  );
});

test("every page's tools are checked against their own listed schema, and the host's reads get the whole result", async (t) => {
  const { mcp } = await manager(t, {
    pages: [
      [
        tool('get_nodes', {
          annotations: { readOnlyHint: true },
        }),
      ],
      [tool('start_run')],
    ],
    call: () => UPGRADED,
  });
  assert.deepEqual(
    mcp.tools.map((item) => item.name),
    ['hub_get_nodes', 'hub_start_run'],
  );
  for (const item of mcp.tools)
    assert.match(
      await item.run({}, context()),
      new RegExp(`\\n\\n${UNDECLARED_STRUCTURE}\\n`),
    );
  // What Circle's own code reads: the result as the server sent it, extra field and all
  for (const result of [
    await mcp.readOnly('hub', 'get_nodes', {}, new AbortController().signal),
    await mcp.personCall('hub', 'start_run', {}, new AbortController().signal),
  ])
    assert.deepEqual(
      (result as { structuredContent: unknown }).structuredContent,
      { run: 'run_1', record: 'rec_1' },
    );
});

test('the model reads the whole result in its next request, and no error', async (t) => {
  const root = realpathSync.native(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const stub = await mcpStub(t, {
    tools: [tool('start_run', { annotations: { readOnlyHint: true } })],
    call: () => UPGRADED,
  });
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'hub', url: stub.url, transport: 'streamable_http' },
  ];
  const replies: Partial<ModelResponse>[] = [
    {
      message: {
        id: 'call',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'start', name: 'hub_start_run', args: {} }],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ];
  const model = new ScriptedModel(replies);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model,
    userHome: join(root, 'user'),
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  await runtime.harness.run('start a run');
  const result = model.requests[1]!.messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === 'start',
  )!;
  assert.equal(
    result.content,
    `run_1 started\n\n${UNDECLARED_STRUCTURE}\n{"run":"run_1","record":"rec_1"}`,
  );
  assert.equal(JSON.stringify(model.requests).includes('-32602'), false);
});
