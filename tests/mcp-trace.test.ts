import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildMcpConnections, traceparent } from '../src/mcp_loader.js';
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
