import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CACHED_RESULT,
  MAX_CACHED_RESULTS,
  McpManager,
} from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse, ToolCall } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
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
];
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
  // It still asks each time: only the server is spared
  assert.equal(asked.length, 3);
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
  const convert = manager.tools.find(
    (tool) => tool.name === 'files-server_convert',
  )!;
  const context = { sessionId: 'any', signal: new AbortController().signal };
  const run = (mode: number) =>
    convert.run({ file: 'a.bin', mode: `${mode}` }, context);
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
    (tool) => tool.name === 'files-server_convert',
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
