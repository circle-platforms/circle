import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { McpManager } from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';
import { mcpStub } from './mcp-stub.js';

const reply = (
  text: string,
  calls: Message['tool_calls'] = [],
): Partial<ModelResponse> => ({
  message: {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: text,
    tool_calls: calls,
  },
});
const call = (name: string, args: Record<string, unknown> = {}) =>
  reply('', [{ id: crypto.randomUUID(), name, args }]);

test("a tool's resource link reads as what it is, and the model reads what it points at", async (t) => {
  const root = scratch(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const stub = await mcpStub(t, {
    tools: [
      {
        name: 'export_report',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    capabilities: { resources: {} },
    call: () => ({
      content: [
        {
          type: 'resource_link',
          uri: 'example://reports/1',
          name: 'report-1',
          mimeType: 'text/plain',
        },
        {
          type: 'resource',
          resource: {
            uri: 'example://notes/1',
            mimeType: 'text/plain',
            text: 'an embedded note',
          },
        },
      ],
    }),
    answer: (request) => {
      const message = request.message!;
      if (message.method === 'resources/read')
        return {
          contents: [
            {
              uri: String(message.params?.uri),
              mimeType: 'text/plain',
              text: 'quarterly numbers',
            },
          ],
        };
      if (message.method === 'resources/list')
        return {
          resources: [{ uri: 'example://reports/1', name: 'report-1' }],
        };
      return undefined;
    },
  });
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'http-server', url: stub.url, transport: 'streamable_http' },
  ];
  const model = new ScriptedModel([
    call('http-server_export_report'),
    call('read_mcp_resource', {
      server: 'http-server',
      uri: 'example://reports/1',
    }),
    call('list_mcp_resources'),
    reply('done'),
  ]);
  const runtime = new AgentRuntime({
    home: join(root, 'home'),
    workspace,
    userHome: join(root, 'user'),
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('export it');

  const offered = model.requests[0]!.tools.map((tool) => tool.name);
  assert.ok(offered.includes('read_mcp_resource'));
  assert.ok(offered.includes('list_mcp_resources'));
  const results = model.requests
    .at(-1)!
    .messages.filter((message) => message.role === 'tool')
    .map((message) => String(message.content));
  // The link says what it is and how to read it; an embedded text resource reads as its text
  assert.match(
    results[0]!,
    /^Resource link: report-1 <example:\/\/reports\/1> \(text\/plain\)\. Its content is not here; read_mcp_resource with server "http-server" and this uri reads it\./,
  );
  assert.match(
    results[0]!,
    /Resource <example:\/\/notes\/1> \(text\/plain\):\nan embedded note/,
  );
  assert.match(results[1]!, /quarterly numbers/);
  assert.match(results[2]!, /http-server · report-1 <example:\/\/reports\/1>/);
  assert.equal(
    stub.requests.filter(
      (request) => request.message?.method === 'resources/read',
    ).length,
    1,
  );
});

test('a server that declares no resources offers no resource tools', async (t) => {
  const stub = await mcpStub(t, {
    tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
  });
  const manager = new McpManager(scratch(t));
  cleanup(t, () => manager.close());
  await manager.load([
    { name: 'plain', url: stub.url, transport: 'streamable_http' },
  ]);
  assert.deepEqual(manager.resourceTools, []);
});
