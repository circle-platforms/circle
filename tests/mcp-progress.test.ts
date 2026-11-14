import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { jsonEvent } from '../src/headless.js';
import { McpManager } from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { toolRow } from '../src/tui/tool_rows.js';
import { stripAnsi } from '../src/ink/string_width.js';
import type { Message, ModelResponse } from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';
import { mcpStub, type McpStub, type StubRequest } from './mcp-stub.js';

// What a long MCP call says while it runs (#554): progress notices, and the state of a call run as a task.
const schema = { type: 'object', properties: {} };
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
const progressNotice = (
  request: StubRequest,
  progress: number,
  message?: string,
) => ({
  method: 'notifications/progress',
  params: {
    progressToken: request.message!.params!._meta!.progressToken,
    progress,
    total: 3,
    ...(message ? { message } : {}),
  },
});

test("a server's progress notices show on the call's row while it runs, and the result is as before", async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const stub = await mcpStub(t, {
    tools: [{ name: 'index', inputSchema: schema }],
    before: (request) =>
      request.message?.method === 'tools/call'
        ? [
            progressNotice(request, 1, 'reading\u001b[31m files'),
            progressNotice(request, 2, 'indexing'),
            progressNotice(request, 3),
          ]
        : undefined,
  });
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'files', url: stub.url, transport: 'streamable_http' },
  ];
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model: new ScriptedModel([
      reply('', [{ id: 'call-1', name: 'files_index', args: {} }]),
      reply('done'),
    ]),
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  const seen: { id: unknown; text: unknown }[] = [];
  const lines: unknown[] = [];
  runtime.bus.subscribe((event) => {
    if (event.kind !== 'tool_progress') return;
    seen.push({ id: event.payload.id, text: event.payload.text });
    lines.push(jsonEvent(event));
  });
  await runtime.harness.run('index it');

  // The call asked for them
  const call = stub.calls()[0]!;
  assert.equal(typeof call.message!.params!._meta!.progressToken, 'number');
  // Each on one line, with no control characters from the server
  assert.deepEqual(seen, [
    { id: 'call-1', text: '1/3 · reading [31m files' },
    { id: 'call-1', text: '2/3 · indexing' },
    { id: 'call-1', text: '3/3' },
  ]);
  assert.deepEqual(lines.at(-1), {
    type: 'tool_progress',
    id: 'call-1',
    text: '3/3',
  });
  // The model reads the result as before, and nothing of the progress
  const result = runtime.harness.messages.find(
    (message) => message.tool_call_id === 'call-1',
  )!;
  assert.match(result.content, /ran index/);
  assert.doesNotMatch(result.content, /indexing/);
});

test("a running call's row shows its progress after its text, cut to fit, and not once it has a result", () => {
  const call = { id: 'c', name: 'files_index', args: { path: 'src' } };
  const running = stripAnsi(
    toolRow(call, undefined, {
      width: 60,
      pending: 'running',
      progress: '2/3 · indexing the whole workspace slowly',
    }),
  );
  assert.match(running, /files_index\(.*\) {2}2\/3 · indexing/);
  assert.ok(running.trimEnd().endsWith('…'), running);
  assert.equal(running.length, 60);
  const done = stripAnsi(
    toolRow(
      call,
      { id: 'r', role: 'tool', content: 'ok', tool_call_id: 'c' } as Message,
      { width: 60, progress: '2/3 · indexing' },
    ),
  );
  assert.doesNotMatch(done, /indexing/);
});

// A server that runs tool calls as tasks (2025-11-25)
async function taskServer(
  t: Parameters<typeof scratch>[0],
  options: {
    support: 'required' | 'optional';
    tasks?: boolean;
    states?: string[];
  },
): Promise<McpStub> {
  const states = [...(options.states ?? ['working', 'completed'])];
  const task = (status: string) => ({
    taskId: 'task-1',
    status,
    ttl: null,
    createdAt: '2026-11-14T00:00:00Z',
    lastUpdatedAt: '2026-11-14T00:00:00Z',
    pollInterval: 1,
    ...(status === 'working' ? { statusMessage: 'step 1' } : {}),
  });
  return mcpStub(t, {
    tools: [
      {
        name: 'build',
        inputSchema: schema,
        execution: { taskSupport: options.support },
      },
    ],
    capabilities:
      options.tasks === false
        ? {}
        : { tasks: { cancel: {}, requests: { tools: { call: {} } } } },
    call: (request) =>
      request.message!.params!.task
        ? { task: task('working') }
        : { content: [{ type: 'text', text: 'ran build at once' }] },
    answer: (request) => {
      const method = request.message!.method;
      if (method === 'tasks/get') return task(states.shift() ?? 'working');
      if (method === 'tasks/result')
        return { content: [{ type: 'text', text: 'built as a task' }] };
      if (method === 'tasks/cancel') return task('cancelled');
      return undefined;
    },
  });
}
async function manager(t: Parameters<typeof scratch>[0], stub: McpStub) {
  const loaded = new McpManager(scratch(t));
  cleanup(t, () => loaded.close());
  await loaded.load([
    { name: 'ci', url: stub.url, transport: 'streamable_http' },
  ]);
  return loaded;
}
const methods = (stub: McpStub) =>
  stub.requests.flatMap((request) =>
    request.message ? [request.message.method] : [],
  );

test('a tool that must run as a task is made a task, followed until it ends, and gives its result', async (t) => {
  const stub = await taskServer(t, { support: 'required' });
  const loaded = await manager(t, stub);
  const shown: string[] = [];
  const text = await loaded.tools[0]!.run(
    {},
    {
      sessionId: 'one',
      signal: new AbortController().signal,
      progress: (line) => shown.push(line),
    },
  );
  assert.match(String(text), /built as a task/);
  assert.deepEqual(stub.calls()[0]!.message!.params!.task, {});
  assert.deepEqual(shown, ['task working · step 1', 'task completed']);
  assert.deepEqual(
    methods(stub).filter((method) => method.startsWith('tasks/')),
    ['tasks/get', 'tasks/get', 'tasks/result'],
  );
});

test('esc cancels a task on the server', async (t) => {
  const stub = await taskServer(t, {
    support: 'optional',
    states: Array(1000).fill('working'),
  });
  const loaded = await manager(t, stub);
  const controller = new AbortController();
  const running = loaded.tools[0]!.run(
    {},
    { sessionId: 'one', signal: controller.signal },
  );
  await until(() => methods(stub).includes('tasks/get'), { timeout: 10_000 });
  controller.abort(new Error('interrupted'));
  await assert.rejects(running);
  await until(() => methods(stub).includes('tasks/cancel'), {
    timeout: 10_000,
  });
  const cancel = stub.requests.find(
    (request) => request.message?.method === 'tasks/cancel',
  )!;
  assert.deepEqual(cancel.message!.params, { taskId: 'task-1' });
});

test('without the server running tasks, a tool that must be one is not sent, and one that may be is called at once', async (t) => {
  const required = await taskServer(t, { support: 'required', tasks: false });
  const strict = await manager(t, required);
  await assert.rejects(
    strict.tools[0]!.run(
      {},
      { sessionId: 'one', signal: new AbortController().signal },
    ),
    /build runs only as a task, and ci does not say it runs tool calls as tasks; nothing was sent/,
  );
  assert.equal(required.calls().length, 0);
  const optional = await taskServer(t, { support: 'optional', tasks: false });
  const plain = await manager(t, optional);
  assert.match(
    String(
      await plain.tools[0]!.run(
        {},
        { sessionId: 'one', signal: new AbortController().signal },
      ),
    ),
    /ran build at once/,
  );
  assert.equal(optional.calls()[0]!.message!.params!.task, undefined);
});
