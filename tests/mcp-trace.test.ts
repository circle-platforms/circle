import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  McpManager,
  buildMcpConnections,
  traceparent,
} from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
import { mcpStub } from './mcp-stub.js';

const TRACE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;
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

test('a trace context is version 00, sampled, with a new trace and parent id each time', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const [, trace, parent] = TRACE.exec(traceparent())!;
    assert.ok(/[^0]/.test(trace!) && /[^0]/.test(parent!));
    seen.add(trace!);
  }
  assert.equal(seen.size, 50);
});

test('a url server without a transport is reached over SSE', () => {
  const { connections } = buildMcpConnections([
    { name: 'plain', url: 'http://127.0.0.1:1/sse' },
    { name: 'unknown', url: 'http://127.0.0.1:1/sse', transport: 'grpc' },
  ]);
  assert.deepEqual(
    connections.map((connection) => connection.transport),
    ['sse', 'sse'],
  );
});

test("a configured header of Circle's own names is left out before its value is filled in, and /mcp says it is not sent", async (t) => {
  const { connections } = buildMcpConnections([
    {
      name: 'files-server',
      url: 'http://127.0.0.1:1/mcp',
      headers: {
        'CIRCLE-SESSION-ID': '${secret:NOT_SAVED}',
        TraceParent: '${env:CIRCLE_TEST_NOT_SET}',
        'X-Team': 'lab',
      },
    },
  ]);
  assert.deepEqual(connections[0]!.headers, { 'X-Team': 'lab' });
  assert.deepEqual(connections[0]!.notSent, [
    'CIRCLE-SESSION-ID',
    'TraceParent',
  ]);
  // A reference in a header that is not sent needs no secret or variable
  const stub = await mcpStub(t, {
    tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
  });
  const manager = new McpManager(scratch(t));
  cleanup(t, () => manager.close());
  await manager.load([
    {
      name: 'files-server',
      url: stub.url,
      transport: 'streamable_http',
      headers: {
        'circle-session-id': '${secret:NOT_SAVED}',
        traceparent: 'configured',
        'X-Team': 'lab',
      },
    },
  ]);
  assert.equal(manager.status[0]!.error, '', manager.describe());
  assert.ok(stub.requests.length > 0);
  for (const request of stub.requests) {
    assert.equal(request.headers['x-team'], 'lab');
    assert.notEqual(request.headers.traceparent, 'configured');
  }
  assert.match(
    manager.describe(),
    /\n {4}headers: X-Team\n {4}not sent, Circle sets them: circle-session-id, traceparent\n/,
  );
  // Only those names: a server with no other header lists none
  await manager.load([
    {
      name: 'files-server',
      url: stub.url,
      transport: 'streamable_http',
      headers: { traceparent: 'configured' },
    },
  ]);
  assert.doesNotMatch(manager.describe(), /headers:/);
  assert.match(manager.describe(), /not sent, Circle sets them: traceparent/);
});

test('every request to an HTTP or SSE server carries the session of that moment, and each tool call its own trace', async (t) => {
  const root = scratch(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const stub = await mcpStub(t, {
    tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
  });
  const settings = defaultSettings();
  settings.mcp_servers = [
    {
      name: 'http-server',
      url: stub.url,
      transport: 'streamable_http',
      // Circle's own headers: configured ones of the same names are never sent
      headers: { 'Circle-Session-Id': 'configured', traceparent: 'configured' },
    },
    { name: 'sse-server', url: stub.sseUrl },
  ];
  const calls = () =>
    reply('', [
      { id: crypto.randomUUID(), name: 'http-server_echo', args: {} },
      { id: crypto.randomUUID(), name: 'sse-server_echo', args: {} },
      { id: crypto.randomUUID(), name: 'http-server_echo', args: {} },
    ]);
  const runtime = new AgentRuntime({
    home: join(root, 'home'),
    workspace,
    settings,
    model: new ScriptedModel([calls(), reply('done'), calls(), reply('done')]),
    userHome: join(root, 'user'),
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.initialize();
  assert.deepEqual(
    runtime.mcp.status.map((row) => row.error),
    ['', ''],
  );
  const first = runtime.session.id;
  await runtime.harness.run('call both');
  const before = stub.requests.length;
  // A runtime moves to a new session as RPC new_session does
  await runtime.newSession();
  const second = runtime.session.id;
  assert.notEqual(first, second);
  runtime.policy.setYolo(second, true);
  await runtime.harness.run('call both again');
  assert.ok(stub.requests.some((request) => request.path === '/sse'));
  assert.ok(stub.requests.some((request) => request.path === '/messages'));
  stub.requests.forEach((request, index) =>
    assert.equal(
      request.headers['circle-session-id'],
      index < before ? first : second,
      `${request.method} ${request.path} ${request.message?.method ?? ''}`,
    ),
  );
  // A trace on each tool call, a new one every time, and on nothing else
  const traced = stub.requests.filter((request) => request.headers.traceparent);
  assert.deepEqual(traced, stub.calls());
  assert.equal(traced.length, 6);
  const traces = traced.map(
    (request) => TRACE.exec(String(request.headers.traceparent))![1],
  );
  assert.equal(new Set(traces).size, 6);
  assert.ok(
    traced.some((request) => request.path === '/messages') &&
      traced.some((request) => request.path === '/mcp'),
  );
});

test("the cancellation sent for an interrupted tool call carries that call's trace, however the interrupt came", async (t) => {
  let answer: (() => void) | undefined;
  const stub = await mcpStub(t, {
    tools: [{ name: 'wait', inputSchema: { type: 'object', properties: {} } }],
    // Answers only when the test ends, as a tool that waits for a login does
    call: () =>
      new Promise((resolve) => {
        answer = () =>
          resolve({ content: [{ type: 'text', text: 'too late' }] });
      }),
  });
  cleanup(t, () => answer?.());
  const manager = new McpManager(scratch(t));
  cleanup(t, () => manager.close());
  await manager.load([
    { name: 'http-server', url: stub.url, transport: 'streamable_http' },
  ]);
  const controller = new AbortController();
  const running = manager.tools[0]!.run(
    {},
    { sessionId: 'one', signal: controller.signal },
  );
  const until = async (check: () => boolean) => {
    const deadline = performance.now() + 10_000;
    while (!check()) {
      assert.ok(performance.now() < deadline, 'timed out');
      await new Promise((done) => setTimeout(done, 5));
    }
  };
  await until(() => stub.calls().length === 1);
  // From outside the call, as a key press is
  controller.abort(new Error('interrupted'));
  await assert.rejects(running);
  const cancelled = () =>
    stub.requests.find(
      (request) => request.message?.method === 'notifications/cancelled',
    );
  await until(() => cancelled() !== undefined);
  const call = stub.calls()[0]!;
  assert.match(String(call.headers.traceparent), TRACE);
  assert.equal(
    cancelled()!.message!.params!.requestId,
    call.message!.id,
    'the cancellation names the call',
  );
  assert.equal(cancelled()!.headers.traceparent, call.headers.traceparent);
});
