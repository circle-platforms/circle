import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, saveSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { cleanup, scratch } from './helpers.js';
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
