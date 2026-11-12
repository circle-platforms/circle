// A server that declares its tools can change (`tools.listChanged`) and then sends
// notifications/tools/list_changed is listed again: the next turn's model request has the tools it lists now, the turn
// under way keeps the ones it started with, several notices in a row list once, and a listing that fails keeps the
// earlier tools with the server's status saying so.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS_NOT_LISTED_AGAIN } from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { ModelResponse } from '../src/types.js';
import { scratch, cleanup, until } from './helpers.js';
import { mcpStub, type StubOptions, type StubTool } from './mcp-stub.js';

const CHANGED = 'notifications/tools/list_changed';
// Read-only, so the model's call runs without a person's approval
const tool = (name: string): StubTool => ({
  name,
  description: `synthetic ${name}`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
});
const answer = (content: string): Partial<ModelResponse> => ({
  message: { id: content, role: 'assistant', content },
});

async function world(
  t: TestContext,
  options: StubOptions,
  replies: Partial<ModelResponse>[],
) {
  const root = realpathSync.native(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const stub = await mcpStub(t, options);
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'hub', url: stub.url, transport: 'streamable_http' },
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
  // The client holds a stream open for what the server sends of its own
  await until(() =>
    stub.requests.some((r) => r.method === 'GET' && r.path === '/mcp'),
  );
  const listings = () =>
    stub.requests.filter((r) => r.message?.method === 'tools/list').length;
  const offered = (request: number) =>
    model.requests[request]!.tools.map((tool) => tool.name).filter((name) =>
      name.startsWith('hub_'),
    );
  const status = () => runtime.mcp.status.find((s) => s.name === 'hub')!;
  return { stub, model, runtime, listings, offered, status };
}

test('several notices that the tools changed list them once, and the next turn offers what the server lists now', async (t) => {
  const options: StubOptions = { listChanged: true, tools: [tool('alpha')] };
  const w = await world(t, options, [answer('first'), answer('second')]);
  await w.runtime.harness.run('first');
  assert.deepEqual(w.offered(0), ['hub_alpha']);
  assert.equal(w.listings(), 1);
  options.tools = [tool('beta')];
  for (let i = 0; i < 3; i++) w.stub.notify(CHANGED);
  await until(() => w.status().tools.includes('hub_beta'));
  await w.runtime.harness.run('second');
  assert.deepEqual(w.offered(1), ['hub_beta']);
  assert.equal(w.listings(), 2);
  assert.equal(w.status().error, '');
});

test('the turn under way keeps the tools it started with; the next turn has the new ones', async (t) => {
  const options: StubOptions = { listChanged: true, tools: [tool('alpha')] };
  let w: Awaited<ReturnType<typeof world>>;
  // While the model's call runs, the server's tools change and it says so; the call answers once they are listed again
  options.call = async () => {
    options.tools = [tool('beta')];
    w.stub.notify(CHANGED);
    await until(() => w.status().tools.includes('hub_beta'));
    return { content: [{ type: 'text', text: 'ran alpha' }] };
  };
  w = await world(t, options, [
    {
      message: {
        id: 'call',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'alpha', name: 'hub_alpha', args: {} }],
      },
    },
    answer('done'),
    answer('next'),
  ]);
  await w.runtime.harness.run('use alpha');
  assert.equal(w.stub.calls().length, 1);
  assert.deepEqual(w.offered(0), ['hub_alpha']);
  // The same turn, after the call: still the tools it started with
  assert.deepEqual(w.offered(1), ['hub_alpha']);
  await w.runtime.harness.run('again');
  assert.deepEqual(w.offered(2), ['hub_beta']);
});

test('when the tools cannot be listed again, the earlier ones stay and the status says why', async (t) => {
  let failing = false;
  const options: StubOptions = {
    listChanged: true,
    tools: [tool('alpha')],
    refuse: (request) =>
      failing && request.message?.method === 'tools/list'
        ? { status: 500, body: 'synthetic failure' }
        : undefined,
  };
  const w = await world(t, options, [answer('first'), answer('second')]);
  await w.runtime.harness.run('first');
  failing = true;
  options.tools = [tool('beta')];
  w.stub.notify(CHANGED);
  await until(() => w.status().error === TOOLS_NOT_LISTED_AGAIN);
  assert.deepEqual(w.status().tools, ['hub_alpha']);
  // /mcp lists the tools that stay, with why they may be out of date; the server has not failed
  const shown = w.runtime.mcp.describe();
  assert.match(shown, /\n {4}hub_alpha\n {4}the server changed its tools/);
  assert.doesNotMatch(shown, /failed: the server changed/);
  await w.runtime.harness.run('second');
  assert.deepEqual(w.offered(1), ['hub_alpha']);
  // The server lists again once it can; the note goes with the earlier tools
  failing = false;
  w.stub.notify(CHANGED);
  await until(() => w.status().tools.includes('hub_beta'));
  assert.equal(w.status().error, '');
});
