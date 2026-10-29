import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CACHED_RESULT,
  MAX_CACHED_RESULTS,
  McpManager,
  NOT_SENT,
} from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse, ToolCall } from '../src/types.js';
import { scratch, cleanup, until } from './helpers.js';
import { mcpStub, type StubRequest, type StubTool } from './mcp-stub.js';

const fileSchema = {
  type: 'object',
  properties: {
    file: { type: 'string', contentEncoding: 'base64' },
    mode: { type: 'string' },
    options: { type: 'object' },
  },
};
const TOOLS: StubTool[] = [
  {
    name: 'convert',
    inputSchema: fileSchema,
    annotations: { idempotentHint: true },
  },
  { name: 'stamp', inputSchema: fileSchema },
  {
    name: 'lookup',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    annotations: { idempotentHint: true },
  },
  {
    name: 'flaky',
    inputSchema: fileSchema,
    annotations: { idempotentHint: true },
  },
  {
    name: 'inspect',
    inputSchema: fileSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
];
const FIXTURE = resolve('tests/fixtures/mcp-server.ts');
// A server that holds documents: what it answers says what it holds now
const DOCUMENTS: StubTool[] = [
  {
    name: 'put_document',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        file: { type: 'string', contentEncoding: 'base64' },
      },
    },
    annotations: { idempotentHint: true },
  },
  {
    name: 'get_document',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'delete_document',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: { destructiveHint: true },
  },
];
async function documents(t: TestContext) {
  const held = new Map<string, string>();
  const stub = await mcpStub(t, {
    tools: DOCUMENTS,
    call: (request: StubRequest) => {
      const name = String(request.message?.params?.name);
      const args = request.message?.params?.arguments as {
        id: string;
        file?: string;
      };
      const text = (value: string) => ({
        content: [{ type: 'text', text: value }],
      });
      if (name === 'put_document') {
        const content = Buffer.from(args.file!, 'base64').toString();
        held.set(args.id, content);
        return text(`${args.id} is now "${content}"`);
      }
      if (name === 'delete_document') {
        held.delete(args.id);
        return text(`${args.id} deleted`);
      }
      return text(
        held.has(args.id) ? `"${held.get(args.id)}"` : 'no such document',
      );
    },
  });
  return { stub, held };
}
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

// The server's answer says which of its calls it was (from 1), so a result given again shows
async function server(t: TestContext) {
  let flaky = 0;
  const stub = await mcpStub(t, {
    tools: TOOLS,
    call: (request: StubRequest) => {
      const name = String(request.message?.params?.name);
      const count = stub.calls().length;
      if (name === 'flaky' && ++flaky === 1)
        return { isError: true, content: [{ type: 'text', text: 'busy' }] };
      return { content: [{ type: 'text', text: `${name} answer ${count}` }] };
    },
  });
  return stub;
}

test('an idempotent tool given the same file contents and arguments in a session gets its earlier result, and the server is not called', async (t) => {
  const root = scratch(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'a.bin'), 'first contents');
  writeFileSync(join(workspace, 'copy.bin'), 'first contents');
  const stub = await server(t);
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'files-server', url: stub.url, transport: 'streamable_http' },
  ];
  const replies: Partial<ModelResponse>[] = [];
  const asked: ToolCall[] = [];
  const runtime = new AgentRuntime({
    home: join(root, 'home'),
    workspace,
    settings,
    model: new ScriptedModel(replies),
    userHome: join(root, 'user'),
    approve: async (call) => {
      asked.push(call);
      return 'approve';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  let count = 0;
  // One call to a tool of the server, as the model reads its result
  const call = async (tool: string, args: Record<string, unknown>) => {
    const id = `call-${++count}`;
    replies.push(
      reply('', [{ id, name: `files-server_${tool}`, args }]),
      reply('done'),
    );
    await runtime.harness.run(`call ${tool}`);
    return runtime.harness.messages.find(
      (message) => message.tool_call_id === id,
    )!.content;
  };
  const served = () => stub.calls().length;
  const first = await call('convert', {
    file: 'a.bin',
    mode: 'x',
    options: { b: 1, a: 2 },
  });
  assert.match(
    first,
    /^file: sent a\.bin \(14 bytes, sha256 [0-9a-f]{64}\)\n\nconvert answer 1$/,
  );
  assert.equal(served(), 1);
  // The same contents and the same arguments, keys in another order: the earlier result
  const again = await call('convert', {
    options: { a: 2, b: 1 },
    mode: 'x',
    file: 'a.bin',
  });
  assert.equal(
    again,
    `${CACHED_RESULT}\nfile: ${first.split('\n')[0]!.slice('file: sent '.length)}\n\nconvert answer 1`,
  );
  assert.match(again, /^cached \(same content\)/);
  // Another path to the same bytes is the same content
  assert.match(
    await call('convert', {
      file: 'copy.bin',
      mode: 'x',
      options: { a: 2, b: 1 },
    }),
    /^cached \(same content\)[^\n]*\nfile: copy\.bin \(14 bytes/,
  );
  assert.equal(served(), 1);
  // It still asks each time: only the server is spared, and the card says so
  assert.equal(asked.length, 3);
  assert.deepEqual(
    asked.map((call) => String(call.args.file).endsWith(`, ${NOT_SENT}`)),
    [false, true, true],
  );
  // Other arguments, other contents: the server again
  assert.match(
    await call('convert', {
      file: 'a.bin',
      mode: 'y',
      options: { a: 2, b: 1 },
    }),
    /convert answer 2$/,
  );
  writeFileSync(join(workspace, 'a.bin'), 'second contents');
  assert.match(
    await call('convert', {
      file: 'a.bin',
      mode: 'x',
      options: { a: 2, b: 1 },
    }),
    /convert answer 3$/,
  );
  assert.equal(served(), 3);
  // A tool that does not say it is idempotent, and a call that sends no file, always go
  await call('stamp', { file: 'a.bin' });
  await call('stamp', { file: 'a.bin' });
  await call('lookup', { q: 'z' });
  await call('lookup', { q: 'z' });
  assert.equal(served(), 7);
  // A failed call is not kept; the success after it is
  assert.match(await call('flaky', { file: 'a.bin' }), /busy/);
  assert.match(await call('flaky', { file: 'a.bin' }), /flaky answer 9$/);
  assert.match(
    await call('flaky', { file: 'a.bin' }),
    /^cached \(same content\)/,
  );
  assert.equal(served(), 9);
  // Another session starts with nothing kept
  await runtime.newSession();
  assert.match(
    await call('convert', {
      file: 'a.bin',
      mode: 'x',
      options: { a: 2, b: 1 },
    }),
    /convert answer 10$/,
  );
  assert.equal(served(), 10);
});

test('the kept results are bounded, the oldest used going first, and trust_annotations false keeps none', async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'a.bin'), 'contents');
  const stub = await server(t);
  const manager = new McpManager(root, 30_000, undefined, {
    sessionId: () => 'session-one',
  });
  cleanup(t, () => manager.close());
  await manager.load([
    { name: 'files-server', url: stub.url, transport: 'streamable_http' },
  ]);
  // A tool that only reads: its calls keep what was kept for the server
  const inspect = manager.tools.find(
    (tool) => tool.name === 'files-server_inspect',
  )!;
  const context = { sessionId: 'any', signal: new AbortController().signal };
  const run = (mode: number) =>
    inspect.run({ file: 'a.bin', mode: `${mode}` }, context);
  for (let mode = 0; mode <= MAX_CACHED_RESULTS; mode++) await run(mode);
  assert.equal(stub.calls().length, MAX_CACHED_RESULTS + 1);
  // The second is still kept, and using it makes the first the oldest, which went
  assert.match(await run(1), /^cached \(same content\)/);
  assert.equal(stub.calls().length, MAX_CACHED_RESULTS + 1);
  assert.match(await run(0), /^file: sent/);
  assert.equal(stub.calls().length, MAX_CACHED_RESULTS + 2);
  // A reload forgets every kept result
  await manager.load([
    { name: 'files-server', url: stub.url, transport: 'streamable_http' },
  ]);
  const reloaded = manager.tools.find(
    (tool) => tool.name === 'files-server_inspect',
  )!;
  assert.match(
    await reloaded.run({ file: 'a.bin', mode: '1' }, context),
    /^file: sent/,
  );
  await manager.load([
    {
      name: 'files-server',
      url: stub.url,
      transport: 'streamable_http',
      trust_annotations: false,
    },
  ]);
  const untrusted = manager.tools.find(
    (tool) => tool.name === 'files-server_convert',
  )!;
  const before = stub.calls().length;
  await untrusted.run({ file: 'a.bin', mode: '1' }, context);
  await untrusted.run({ file: 'a.bin', mode: '1' }, context);
  assert.equal(stub.calls().length, before + 2);
});

test('a call that may change what a server holds makes what was kept for it untrue: A, B, A and put, delete, put all reach the server', async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'v1.txt'), 'version one');
  writeFileSync(join(root, 'v2.txt'), 'version two');
  const { stub, held } = await documents(t);
  const manager = new McpManager(root, 30_000, undefined, {
    sessionId: () => 'session-one',
  });
  cleanup(t, () => manager.close());
  await manager.load([
    { name: 'files-server', url: stub.url, transport: 'streamable_http' },
  ]);
  const context = { sessionId: 'any', signal: new AbortController().signal };
  const run = (tool: string, args: Record<string, unknown>) =>
    manager.tools
      .find((item) => item.name === `files-server_${tool}`)!
      .run(args, context);
  const put = (id: string, file: string) => run('put_document', { id, file });
  const sent = () => stub.calls().length;
  await put('x', 'v1.txt');
  await put('x', 'v2.txt');
  assert.match(
    await put('x', 'v1.txt'),
    /^file: sent v1\.txt [^\n]*\n\nx is now "version one"$/,
  );
  assert.equal(sent(), 3);
  assert.equal(await run('get_document', { id: 'x' }), '"version one"');
  await put('y', 'v1.txt');
  await run('delete_document', { id: 'y' });
  assert.match(await put('y', 'v1.txt'), /^file: sent v1\.txt/);
  assert.equal(held.get('y'), 'version one');
  // The same call again with nothing between that may change the server: the earlier
  // result, and a call that only reads, in between, leaves it so
  const before = sent();
  assert.match(await put('y', 'v1.txt'), /^cached \(same content\)/);
  assert.equal(await run('get_document', { id: 'y' }), '"version one"');
  assert.match(await put('y', 'v1.txt'), /^cached \(same content\)/);
  assert.equal(sent(), before + 1);
});

test("nothing kept for a server outlives its connection: once the server's program has exited, a call gets no earlier result", async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'a.bin'), 'contents');
  const manager = new McpManager(root, 30_000, undefined, {
    sessionId: () => 'session-one',
  });
  cleanup(t, () => manager.close());
  await manager.load([
    { name: 'fixture', command: process.execPath, args: [FIXTURE] },
  ]);
  assert.equal(manager.status[0]!.error, '', manager.describe());
  const checksum = manager.tools.find(
    (tool) => tool.name === 'fixture_checksum',
  )!;
  const context = { sessionId: 'any', signal: new AbortController().signal };
  const first = await checksum.run({ file: 'a.bin' }, context);
  const pid = Number(/8 bytes read by (\d+)$/.exec(first)![1]);
  assert.match(await checksum.run({ file: 'a.bin' }, context), /^cached/);
  process.kill(pid);
  await until(() => manager.status[0]!.error !== '', { timeout: 10_000 });
  assert.match(manager.status[0]!.error, /the connection ended/);
  await assert.rejects(checksum.run({ file: 'a.bin' }, context));
});

test('a call whose card said it would get its earlier result is not run once another call has reached that server', async (t) => {
  const root = scratch(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'v1.txt'), 'version one');
  const { stub, held } = await documents(t);
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'files-server', url: stub.url, transport: 'streamable_http' },
  ];
  const replies: Partial<ModelResponse>[] = [];
  let between: (() => Promise<unknown>) | undefined;
  const runtime = new AgentRuntime({
    home: join(root, 'home'),
    workspace,
    settings,
    model: new ScriptedModel(replies),
    userHome: join(root, 'user'),
    approve: async () => {
      // While the card is up, another conversation's call reaches the same server
      await between?.();
      return 'approve';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  let count = 0;
  const call = async (tool: string, args: Record<string, unknown>) => {
    const id = `call-${++count}`;
    replies.push(
      reply('', [{ id, name: `files-server_${tool}`, args }]),
      reply('done'),
    );
    await runtime.harness.run(`call ${tool}`);
    return runtime.harness.messages.find(
      (message) => message.tool_call_id === id,
    )!;
  };
  await call('put_document', { id: 'x', file: 'v1.txt' });
  const remove = runtime.mcp.tools.find(
    (tool) => tool.name === 'files-server_delete_document',
  )!;
  between = () =>
    remove.run(
      { id: 'x' },
      { sessionId: 'other', signal: new AbortController().signal },
    );
  const stale = await call('put_document', { id: 'x', file: 'v1.txt' });
  assert.equal(stale.status, 'error');
  assert.match(stale.content, /^not run: /);
  assert.match(stale.content, /nothing was sent/);
  // The put the card offered as an earlier result was not sent, and the delete stands
  assert.deepEqual(
    stub.calls().map((request) => request.message?.params?.name),
    ['put_document', 'delete_document'],
  );
  assert.equal(held.has('x'), false);
  // Called again, it asks to send, and sends
  between = undefined;
  assert.match(
    (await call('put_document', { id: 'x', file: 'v1.txt' })).content,
    /^file: sent v1\.txt/,
  );
  assert.equal(held.get('x'), 'version one');
});
