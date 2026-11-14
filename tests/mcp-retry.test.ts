import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpManager } from '../src/mcp_loader.js';
import { cleanup, scratch, until } from './helpers.js';
import { mcpStub, type McpStub, type StubRequest } from './mcp-stub.js';

// What a transport failure of a tool call does (#555): sent again when it surely never left, sent again once only
// for a tool its trusted server says is read-only, and otherwise said to have perhaps reached the server.
const schema = { type: 'object', properties: {} };
const tools = [
  { name: 'look', inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: 'write', inputSchema: schema },
];
async function connected(
  t: Parameters<typeof scratch>[0],
  stub: McpStub,
  entry: Record<string, unknown> = {},
): Promise<McpManager> {
  const manager = new McpManager(scratch(t));
  cleanup(t, () => manager.close());
  await manager.load([
    { name: 'files', url: stub.url, transport: 'streamable_http', ...entry },
  ]);
  assert.equal(manager.tools.length, 2, manager.status[0]?.error);
  return manager;
}
const run = (manager: McpManager, name: string) =>
  manager.tools
    .find((tool) => tool.name === `files_${name}`)!
    .run({}, { sessionId: 'one', signal: new AbortController().signal });
const calls = (stub: McpStub, name: string) =>
  stub.calls().filter((request) => request.message?.params?.name === name)
    .length;
const starts = (stub: McpStub) =>
  stub.requests.filter((request) => request.message?.method === 'initialize')
    .length;
/** The manager's connection to the server, closed as a server's ending program closes it. */
const serverOf = (manager: McpManager) =>
  (manager as unknown as { servers: { client: { close(): Promise<void> } }[] })
    .servers[0]!;
/** The first tools/call of each tool. */
function firstOfEach(): (request: StubRequest) => boolean {
  const seen = new Set<string>();
  return (request) => {
    if (request.message?.method !== 'tools/call') return false;
    const name = String(request.message.params?.name);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  };
}

test('a call that could not reach its server is sent again after a wait, and the server gets it once', async (t) => {
  // Each request on a connection of its own: once the server stops listening, a connection is refused, where a kept
  // one would be cut, which says nothing of whether the request arrived
  const stub = await mcpStub(t, { tools, connectionClose: true });
  const manager = await connected(t, stub);
  const waits: number[] = [];
  // The server is not listening, then is again during the second wait
  await stub.pause();
  manager.wait = async (ms) => {
    waits.push(ms);
    if (waits.length === 2) await stub.resume();
  };
  assert.match(String(await run(manager, 'write')), /ran write/);
  assert.deepEqual(waits, [500, 1000]);
  assert.equal(calls(stub, 'write'), 1);
});

test('a server that cannot be reached after the last wait: the error says the request was not sent', async (t) => {
  const stub = await mcpStub(t, { tools, connectionClose: true });
  const manager = await connected(t, stub);
  const waits: number[] = [];
  await stub.pause();
  manager.wait = async (ms) => {
    waits.push(ms);
  };
  await assert.rejects(
    run(manager, 'write'),
    /files could not be reached in 4 tries: the request was not sent/,
  );
  assert.deepEqual(waits, [500, 1000, 2000]);
  assert.equal(calls(stub, 'write'), 0);
});

test('a call cut off after it reached the server is sent again, once, only for a tool the server says is read-only', async (t) => {
  const stub = await mcpStub(t, { tools, drop: firstOfEach() });
  const manager = await connected(t, stub);
  // Read-only: sent again, on the connection, which is still open: the other calls on it go on
  assert.match(String(await run(manager, 'look')), /ran look/);
  assert.equal(calls(stub, 'look'), 2);
  assert.equal(starts(stub), 1);
  // Anything else: not sent again, and the model reads why
  await assert.rejects(
    run(manager, 'write'),
    /the connection to files ended after the call was sent: the request may have reached the server, so Circle did not send it again/,
  );
  assert.equal(calls(stub, 'write'), 1);
});

test('a read-only call cut off is not sent again when the server is not trusted with its annotations', async (t) => {
  const stub = await mcpStub(t, { tools, drop: firstOfEach() });
  const manager = await connected(t, stub, { trust_annotations: false });
  await assert.rejects(
    run(manager, 'look'),
    /the request may have reached the server/,
  );
  assert.equal(calls(stub, 'look'), 1);
});

test(
  'an answer stream that ends without the answer ends the call instead of leaving it waiting',
  {
    timeout: 30_000,
  },
  async (t) => {
    const stub = await mcpStub(t, { tools, endStream: firstOfEach() });
    const manager = await connected(t, stub);
    await assert.rejects(
      run(manager, 'write'),
      /the stream the answer was to come on ended without it · the connection to files ended after the call was sent: the request may have reached the server/,
    );
    assert.equal(calls(stub, 'write'), 1);
    // The read-only one is sent again and answered
    assert.match(String(await run(manager, 'look')), /ran look/);
    assert.equal(calls(stub, 'look'), 2);
  },
);

test('a connection that ended by itself is connected again for the next call, nothing having been sent on it', async (t) => {
  const stub = await mcpStub(t, { tools });
  const manager = await connected(t, stub);
  // As when a server's program exits
  await serverOf(manager).client.close();
  assert.match(
    manager.status[0]!.error,
    /the connection ended; the next call connects it again/,
  );
  assert.match(String(await run(manager, 'write')), /ran write/);
  assert.equal(calls(stub, 'write'), 1);
  assert.equal(starts(stub), 2);
  assert.equal(manager.status[0]!.error, '');
});

test("a server's own error is its answer: -32000 and 'terminated' in its words are not a cut connection", async (t) => {
  const stub = await mcpStub(t, {
    tools,
    error: (request) =>
      request.message?.method === 'tools/call'
        ? { code: -32000, message: 'worker terminated' }
        : undefined,
  });
  const manager = await connected(t, stub);
  await assert.rejects(run(manager, 'look'), (error: Error) => {
    assert.match(error.message, /worker terminated/);
    assert.doesNotMatch(error.message, /may have reached/);
    return true;
  });
  // Not sent again, and the connection is left as it was
  assert.equal(calls(stub, 'look'), 1);
  assert.equal(starts(stub), 1);
});

test('calls that find the connection ended connect it again once, together', async (t) => {
  const stub = await mcpStub(t, { tools });
  const manager = await connected(t, stub);
  await serverOf(manager).client.close();
  const [look, write] = await Promise.all([
    run(manager, 'look'),
    run(manager, 'write'),
  ]);
  assert.match(String(look), /ran look/);
  assert.match(String(write), /ran write/);
  assert.equal(starts(stub), 2);
});

test("a connection made again during a call carries none of that call's trace or identity", async (t) => {
  const stub = await mcpStub(t, { tools });
  const manager = await connected(t, stub);
  await serverOf(manager).client.close();
  await manager.tools
    .find((tool) => tool.name === 'files_write')!
    .run(
      {},
      {
        sessionId: 'one',
        signal: new AbortController().signal,
        identity: { sessionId: 'conversation', agentId: 'agent-1' },
      },
    );
  await until(() => starts(stub) === 2);
  const again = stub.requests.filter(
    (request) => request.message?.method === 'initialize',
  )[1]!;
  assert.equal(again.headers.traceparent, undefined);
  assert.equal(again.headers['circle-agent-id'], undefined);
  assert.notEqual(again.headers['circle-session-id'], 'conversation');
  // The call itself carries them
  assert.equal(stub.calls().at(-1)!.headers['circle-agent-id'], 'agent-1');
});
