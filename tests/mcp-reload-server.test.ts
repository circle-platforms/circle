import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
} from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { cleanup, scratch, until } from './helpers.js';
import { mcpStub } from './mcp-stub.js';

test('one MCP server connects again and lists its tools again, and the others are left as they are', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const schema = { type: 'object', properties: {} };
  // The stub lists `tools` again at each tools/list
  const served = { tools: [{ name: 'old', inputSchema: schema }] };
  const one = await mcpStub(t, served);
  const other = await mcpStub(t, {
    tools: [{ name: 'echo', inputSchema: schema }],
  });
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'one', url: one.url, transport: 'streamable_http' },
    { name: 'other', url: other.url, transport: 'streamable_http' },
  ];
  saveSettings(settings, home);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model: new ScriptedModel([]),
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  const names = () => runtime.harness.tools.map((tool) => tool.name);
  const starts = (stub: typeof one) =>
    stub.requests.filter((request) => request.message?.method === 'initialize')
      .length;
  assert.ok(names().includes('one_old'));
  const otherBefore = starts(other);

  // The server changed its tools and does not say so: connecting it alone again finds them
  served.tools = [{ name: 'new', inputSchema: schema }];
  await runtime.reloadMcpServer('one');
  assert.ok(names().includes('one_new'));
  assert.ok(!names().includes('one_old'));
  assert.ok(names().includes('other_echo'));
  assert.equal(
    starts(other),
    otherBefore,
    'the other server is not reached again',
  );
  assert.equal(starts(one), 2);

  // A name no server has is refused, and so is a reload while a turn runs
  await assert.rejects(
    runtime.reloadMcpServer('nobody'),
    /no MCP server named nobody/,
  );
});

async function runtimeWith(
  t: Parameters<typeof scratch>[0],
  servers: Record<string, unknown>[],
  model = new ScriptedModel([]),
) {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const settings = defaultSettings();
  settings.mcp_servers = servers;
  saveSettings(settings, home);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  return { runtime, home };
}

test('a server the settings name by its id is connected again by that name, not taken away', async (t) => {
  const stub = await mcpStub(t, {
    tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
  });
  const { runtime } = await runtimeWith(t, [
    { id: 'docs', url: stub.url, transport: 'streamable_http' },
  ]);
  const names = () => runtime.harness.tools.map((tool) => tool.name);
  assert.ok(names().includes('docs_echo'));
  await runtime.reloadMcpServer('docs');
  assert.ok(names().includes('docs_echo'));
  assert.equal(
    stub.requests.filter((request) => request.message?.method === 'initialize')
      .length,
    2,
  );
});

test('an extension saving a server while a turn runs is refused, and nothing is saved', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { runtime, home } = await runtimeWith(
    t,
    [],
    new ScriptedModel([
      async () => {
        await gate;
        return {
          message: {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: 'done',
          },
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
        } as never;
      },
    ]),
  );
  const turn = runtime.harness.run('wait');
  await until(() => runtime.busy);
  await assert.rejects(
    runtime.saveMcpServer({ name: 'later', url: 'http://127.0.0.1:9/mcp' }),
    /a turn is running: nothing was saved/,
  );
  assert.ok(
    !loadSettings(home).mcp_servers.some((row) => row.name === 'later'),
  );
  release();
  await turn;
});
