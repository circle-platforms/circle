import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse } from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';
import { mcpStub, type StubOptions } from './mcp-stub.js';

// What the model is given of an MCP call: a result too large for it is kept in a file, and a call of the conversation
// that runs a while goes on as a background job.
const schema = { type: 'object', properties: {} };
const assistant = (
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
const calling = (id: string, tool: string) =>
  assistant('', [{ id, name: `mcp__files__${tool}`, args: {} }]);

async function setup(
  t: TestContext,
  stub: StubOptions,
  options: { headless?: boolean } = {},
) {
  const root = realpathSync.native(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  // Every tool of the server runs without a card
  writeFileSync(
    join(home, 'approvals.json'),
    JSON.stringify({ rules: [{ tool: 'mcp__files__*', effect: 'allow' }] }),
  );
  const server = await mcpStub(t, stub);
  const settings = defaultSettings();
  settings.mcpServers = { files: { type: 'http', url: server.url } };
  const replies: Partial<ModelResponse>[] = [];
  const model = new ScriptedModel(replies);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model,
    userHome: join(root, 'user'),
    ...(options.headless ? { headless: true, integrations: true } : {}),
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  assert.equal(runtime.mcp.status[0]?.error, '', runtime.mcp.describe());
  const result = (id: string) =>
    runtime.harness.messages.find((message) => message.tool_call_id === id)!
      .content;
  return { home, server, runtime, model, replies, result };
}

test('a result over 50,000 characters or the token limit is kept in a file and the model is given its path; a smaller one comes whole', async (t) => {
  const big = 'x'.repeat(60_000);
  const { runtime, replies, result, model } = await setup(t, {
    tools: [
      { name: 'big', inputSchema: schema },
      { name: 'small', inputSchema: schema },
    ],
    call: (request) => ({
      content: [
        {
          type: 'text',
          text:
            request.message?.params?.name === 'big' ? big : 'a short answer',
        },
      ],
    }),
  });
  replies.push(
    assistant('', [
      { id: 'big', name: 'mcp__files__big', args: {} },
      { id: 'small', name: 'mcp__files__small', args: {} },
    ]),
    assistant('done'),
  );
  await runtime.harness.run('get both');
  assert.equal(result('small'), 'a short answer');
  const said = result('big');
  assert.match(
    said,
    /^The result of mcp__files__big is too large to give here \(60000 characters, about \d+ tokens\), so it was kept in full in \/large_tool_results\/[0-9a-f]+\.txt\./,
  );
  // The model reads the path in its next request, and the file holds the whole result
  const sent = model.requests[1]!.messages.find(
    (message) => message.tool_call_id === 'big',
  )!.content;
  assert.equal(sent, said);
  const path = /\/large_tool_results\/[0-9a-f]+\.txt/.exec(said)![0];
  assert.equal(readFileSync(runtime.sandbox.resolvePath(path), 'utf8'), big);
});

test('the token limit is CIRCLE_MAX_MCP_OUTPUT_TOKENS when it is set', async (t) => {
  process.env.CIRCLE_MAX_MCP_OUTPUT_TOKENS = '100';
  cleanup(t, () => {
    delete process.env.CIRCLE_MAX_MCP_OUTPUT_TOKENS;
  });
  const { runtime, replies, result } = await setup(t, {
    tools: [{ name: 'words', inputSchema: schema }],
    call: () => ({
      content: [{ type: 'text', text: 'word '.repeat(400) }],
    }),
  });
  replies.push(calling('words', 'words'), assistant('done'));
  await runtime.harness.run('words');
  assert.match(result('words'), /too large to give here \(2000 characters/);
});

test('a call of the conversation still running after the limit goes on as a background job, and the model reads its result in the notice', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { runtime, replies, result, model, server } = await setup(t, {
    tools: [{ name: 'slow', inputSchema: schema }],
    call: async () => {
      await gate;
      return { content: [{ type: 'text', text: 'the slow answer' }] };
    },
  });
  runtime.mcp.autoBackgroundMs = 1;
  replies.push(calling('slow', 'slow'), assistant('waiting'));
  await runtime.harness.run('start it');
  assert.match(
    result('slow'),
    /^mcp__files__slow was still running after 0 seconds, so it goes on as background job (j\d+); its result arrives in a notice when it ends\./,
  );
  const id = /background job (j\d+)/.exec(result('slow'))![1]!;
  const job = () => runtime.jobs.get(id)!;
  assert.equal(job().kind, 'call');
  assert.equal(job().status, 'running');
  release();
  await until(() => job().status !== 'running');
  assert.equal(job().status, 'done');
  assert.equal(server.calls().length, 1);
  // The next turn tells the model, with the result
  replies.push(assistant('read it'));
  await runtime.harness.run('anything new?');
  const told = model.requests
    .at(-1)!
    .messages.map((message) => message.content)
    .join('\n');
  assert.match(told, /the slow answer/);
});

test('stopping the job of a call in the background cancels the call at its server', async (t) => {
  const { runtime, replies, result, server } = await setup(t, {
    tools: [{ name: 'slow', inputSchema: schema }],
    call: () => new Promise(() => {}),
  });
  runtime.mcp.autoBackgroundMs = 1;
  replies.push(calling('slow', 'slow'), assistant('waiting'));
  await runtime.harness.run('start it');
  const id = /background job (j\d+)/.exec(result('slow'))![1]!;
  await runtime.jobs.stop(id, 'user');
  assert.equal(runtime.jobs.get(id)!.status, 'stopped');
  await until(() =>
    server.requests.some(
      (request) => request.message?.method === 'notifications/cancelled',
    ),
  );
});

test('a run that cannot go on after its turn keeps the call where it was made', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { runtime, replies, result, server } = await setup(
    t,
    {
      tools: [{ name: 'slow', inputSchema: schema }],
      call: async () => {
        await gate;
        return { content: [{ type: 'text', text: 'the slow answer' }] };
      },
    },
    { headless: true },
  );
  runtime.mcp.autoBackgroundMs = 1;
  replies.push(calling('slow', 'slow'), assistant('done'));
  const turn = runtime.harness.run('start it');
  // The server has the call, and the limit has long passed by the time it answers
  await until(() => server.calls().length === 1);
  await new Promise((done) => setImmediate(done));
  release();
  await turn;
  assert.equal(result('slow'), 'the slow answer');
  assert.equal(runtime.jobs.list().length, 0);
});
