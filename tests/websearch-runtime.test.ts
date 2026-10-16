import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { GatewayModel } from '../src/model.js';
import { ScriptedModel } from '../src/testing.js';
import {
  defaultSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';
import type { Message } from '../src/types.js';
import { formatCosts } from '../src/pricing.js';

const assistant = (
  id: string,
  content = '',
  calls: Message['tool_calls'] = [],
): Message => ({ id, role: 'assistant', content, tool_calls: calls });
const search = (id = 'search') =>
  assistant(id, '', [
    { id, name: 'websearch', args: { query: 'synthetic query' } },
  ]);
const native = (model: string) => ({
  model,
  output: [
    {
      type: 'web_search_call',
      status: 'completed',
      action: {
        sources: [{ title: 'Docs', url: 'https://docs.example/verified' }],
      },
    },
  ],
  usage: { input_tokens: 11, output_tokens: 7 },
});
function stream(res: ServerResponse, message: Message): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = message.tool_calls?.length
    ? {
        tool_calls: message.tool_calls.map((call, index) => ({
          index,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      }
    : { content: message.content };
  res.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
  );
}
async function fixture(
  t: TestContext,
  handler: (url: string, body: any, res: ServerResponse) => void,
) {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    handler(req.url!, body, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const settings = trustFolder(defaultSettings(), workspace);
  settings.initialized = true;
  settings.auth = {
    ...settings.auth,
    protocol: 'openai',
    base_url: `http://127.0.0.1:${address.port}/v1`,
    api_key_ref: 'api_key',
    model: 'main-model',
  };
  saveSettings(settings, home);
  saveCredentials({ api_key: 'synthetic-key' }, home);
  return { home, workspace, settings };
}

test('ScriptedModel drives native search through a real local gateway and preserves accounting and history', async (t) => {
  const requests: any[] = [];
  const setup = await fixture(t, (url, body, res) => {
    assert.equal(url, '/v1/responses');
    requests.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(native(body.model)));
  });
  const scripted = new ScriptedModel([
    { message: search() },
    { message: assistant('done', 'done') },
  ]);
  const gateway = new GatewayModel(setup.settings, setup.home);
  gateway.complete = (request) => scripted.complete(request);
  const runtime = new AgentRuntime({
    ...setup,
    model: gateway,
    headless: true,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  const run = await runtime.harness.run(
    'private session information should not reach search helper',
  );
  assert.equal(run.answer, 'done');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'main-model');
  assert.ok(
    !JSON.stringify(requests[0]).includes('private session information'),
  );
  const next = scripted.requests[1]!.messages.find(
    (m) => m.tool_call_id === 'search',
  )!;
  const stored = runtime.store
    .messages(runtime.session.id)
    .find((m) => m.tool_call_id === 'search')!;
  assert.equal(next.content, stored.content);
  assert.match(next.content, /https:\/\/docs.example\/verified/);
  assert.deepEqual(next.model_calls, stored.model_calls);
  assert.equal(next.model_calls![0]!.model, 'main-model');
  assert.equal(next.model_calls![0]!.cost!.tool_fee_unknown, true);
  assert.equal(runtime.stats().usage.input_tokens, 11);
  assert.equal(runtime.stats().usage.output_tokens, 7);
  assert.equal(run.usage.input_tokens, 11);
  assert.equal(runtime.stats().costs.calls, 3);
  assert.equal(formatCosts([runtime.stats().costs]), 'N/A');
});

test('switching current model routes the next tool search to the new model, including concurrent runtimes', async (t) => {
  const seen: string[] = [];
  const setup = await fixture(t, (url, body, res) => {
    if (url === '/v1/responses') {
      seen.push(body.model);
      res.end(JSON.stringify(native(body.model)));
    } else if (body.messages.at(-1).role === 'tool')
      stream(res, assistant('done', 'done'));
    else stream(res, search('search-' + body.model));
  });
  const first = new AgentRuntime({
    ...setup,
    headless: true,
    bundledExtensions: false,
  });
  cleanup(t, () => first.close());
  await first.harness.run('search');
  first.setModel('second-model');
  await first.harness.run('search again');
  assert.deepEqual(seen, ['main-model', 'second-model']);
  // A separate home/connection is not allowed to borrow the first runtime's model or key.
  const other = await fixture(t, (url, body, res) => {
    if (url === '/v1/responses') {
      seen.push('other:' + body.model);
      res.end(JSON.stringify(native(body.model)));
    } else if (body.messages.at(-1).role === 'tool')
      stream(res, assistant('other-done', 'done'));
    else stream(res, search('other-search'));
  });
  other.settings.auth.model = 'independent-model';
  saveSettings(other.settings, other.home);
  const second = new AgentRuntime({
    ...other,
    headless: true,
    bundledExtensions: false,
  });
  cleanup(t, () => second.close());
  await Promise.all([first.harness.run('one'), second.harness.run('two')]);
  assert.ok(seen.includes('other:independent-model'));
  assert.equal(seen.at(-1)?.includes('main-model'), false);
});

test('a custom child agent searches using its own model and charges its own stored tool result', async (t) => {
  const seen: string[] = [];
  const setup = await fixture(t, (url, body, res) => {
    if (url === '/v1/responses') {
      seen.push(body.model);
      res.end(JSON.stringify(native(body.model)));
      return;
    }
    if (body.messages.at(-1).role === 'tool')
      stream(res, assistant('done-' + body.model, 'done'));
    else if (body.model === 'child-model') stream(res, search('child-search'));
    else
      stream(
        res,
        assistant('task', '', [
          {
            id: 'task',
            name: 'task',
            args: { description: 'look', subagent_type: 'researcher' },
          },
        ]),
      );
  });
  const dir = join(setup.home, 'extensions', 'researcher');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'extension.mjs'),
    `export function register(api){api.registerSubagent({name:'researcher',description:'research',system_prompt:'research',model:'child-model'},['websearch'])}`,
  );
  const runtime = new AgentRuntime({
    ...setup,
    headless: true,
    integrations: true,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  assert.ok(
    runtime.extensions
      .subagents(runtime.allTools)
      .some((agent) => agent.spec.name === 'researcher'),
    JSON.stringify(runtime.extensions.extensions),
  );
  await runtime.harness.run('delegate research');
  assert.deepEqual(
    seen,
    ['child-model'],
    JSON.stringify(runtime.harness.messages.filter((m) => m.role === 'tool')),
  );
  const ids = runtime.store.contextState(
    runtime.session.id,
  ).subagentSessionIds!;
  assert.equal(ids.length, 1);
  const tool = runtime.store
    .messages(ids[0]!)
    .find((m) => m.tool_call_id === 'child-search')!;
  assert.equal(tool.model_calls![0]!.model, 'child-model');
  assert.equal(runtime.stats().usage.input_tokens, 11);
  assert.equal(runtime.stats().costs.calls, 5);
});

test('usage from an unsuccessful native request survives a tool error and reaches the next model request', async (t) => {
  const setup = await fixture(t, (_url, _body, res) => {
    res.end(
      JSON.stringify({
        ...native('actual-helper'),
        output: [{ type: 'web_search_call', status: 'failed' }],
      }),
    );
  });
  const scripted = new ScriptedModel([
    { message: search() },
    { message: assistant('done', 'done') },
  ]);
  const gateway = new GatewayModel(setup.settings, setup.home);
  gateway.complete = (request) => scripted.complete(request);
  const runtime = new AgentRuntime({
    ...setup,
    model: gateway,
    headless: true,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  // Keep the fallback completely local and deterministic; it must not use the test host network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).includes('duckduckgo.com')
      ? new Response('unavailable', { status: 503 })
      : realFetch(url, init);
  try {
    await runtime.harness.run('search');
  } finally {
    globalThis.fetch = realFetch;
  }
  const next = scripted.requests[1]!.messages.find(
    (m) => m.tool_call_id === 'search',
  )!;
  assert.equal(next.status, 'error');
  assert.match(next.content, /native search tool failed/);
  assert.equal(next.model_calls![0]!.model, 'actual-helper');
  assert.equal(runtime.stats().usage.input_tokens, 11);
  assert.equal(
    runtime.store
      .messages(runtime.session.id)
      .find((m) => m.tool_call_id === 'search')!.model_calls!.length,
    1,
  );
});
