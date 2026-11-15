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
import {
  mcpStub,
  type McpStub,
  type StubRequest,
  type StubTool,
} from './mcp-stub.js';

// What a long MCP call says while it runs (#554): progress notices, and the state of a call a server runs as a task
// (the 2026-07-28 tasks extension).
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
  settings.mcpServers = { files: { url: stub.url, type: 'http' } };
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model: new ScriptedModel([
      reply('', [{ id: 'call-1', name: 'mcp__files__index', args: {} }]),
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
  const call = { id: 'c', name: 'mcp__files__index', args: { path: 'src' } };
  const running = stripAnsi(
    toolRow(call, undefined, {
      width: 60,
      pending: 'running',
      progress: '2/3 · indexing the whole workspace slowly',
    }),
  );
  assert.match(running, /mcp__files__index\(.*\) {2}2\/3 · indexing/);
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

// A server on the 2026-07-28 revision that may answer a call with a task (the tasks extension). `states` are what its
// tasks/get answers in turn, the last one again and again.
const TASKS = 'io.modelcontextprotocol/tasks';
const TASK_ID = 'build-7f3a9c2e';
const declared = (request: StubRequest): boolean =>
  Boolean(
    request.message?.params?._meta?.[
      'io.modelcontextprotocol/clientCapabilities'
    ]?.extensions?.[TASKS],
  );
const task = (state: Record<string, unknown>) => ({
  taskId: TASK_ID,
  createdAt: '2026-11-14T00:00:00Z',
  lastUpdatedAt: '2026-11-14T00:00:00Z',
  ttlMs: null,
  ...state,
});
async function taskServer(
  t: Parameters<typeof scratch>[0],
  options: {
    states?: Record<string, unknown>[];
    /** The task the call is answered with. */
    first?: Record<string, unknown>;
    /** Say the server runs tasks (`extensions`); true unless false. */
    extension?: boolean;
    /** Speak 2026-07-28; true unless false. */
    modern?: boolean;
    /** Answer with a task whether or not the call said it takes one. */
    always?: boolean;
    error?: (
      request: StubRequest,
    ) => { code: number; message: string } | undefined;
    tools?: StubTool[];
  } = {},
): Promise<McpStub> {
  const states = [
    ...(options.states ?? [
      {
        status: 'completed',
        result: { content: [{ type: 'text', text: 'built as a task' }] },
      },
    ]),
  ];
  return mcpStub(t, {
    modern: options.modern ?? true,
    tools: options.tools ?? [{ name: 'build', inputSchema: schema }],
    capabilities:
      options.extension === false ? {} : { extensions: { [TASKS]: {} } },
    call: (request) =>
      declared(request) || options.always
        ? {
            resultType: 'task',
            ...task(
              options.first ?? {
                status: 'working',
                statusMessage: 'compiling',
                pollIntervalMs: 5000,
              },
            ),
          }
        : { content: [{ type: 'text', text: 'built at once' }] },
    answer: (request) => {
      const method = request.message!.method;
      if (method === 'tasks/get')
        return task(states.length > 1 ? states.shift()! : states[0]!);
      if (method === 'tasks/update' || method === 'tasks/cancel') return {};
      return undefined;
    },
    ...(options.error ? { error: options.error } : {}),
  });
}
/** A manager of an interactive session; its waits pass at once and are recorded. */
async function manager(
  t: Parameters<typeof scratch>[0],
  stub: McpStub,
  services: ConstructorParameters<typeof McpManager>[3] = {},
  entry: Record<string, unknown> = {},
) {
  const loaded = new McpManager(scratch(t), 10_000, undefined, {
    interactive: true,
    ...services,
  });
  cleanup(t, () => loaded.close());
  const waits: number[] = [];
  loaded.wait = async (ms) => {
    waits.push(ms);
  };
  await loaded.load({ ci: { url: stub.url, type: 'http', ...entry } });
  assert.equal(loaded.status[0]!.error, '', loaded.describe());
  return { loaded, waits };
}
const methods = (stub: McpStub) =>
  stub.requests.flatMap((request) =>
    request.message ? [request.message.method] : [],
  );
const sentTo = (stub: McpStub, method: string) =>
  stub.requests.filter((request) => request.message?.method === method);
const context = () => ({
  sessionId: 'one',
  signal: new AbortController().signal,
});

test("a call a server answers with a task is followed with tasks/get at the interval it says, shown on its row, and gives the task's result", async (t) => {
  const stub = await taskServer(t, {
    states: [
      { status: 'working', statusMessage: 'step 1', pollIntervalMs: 10 },
      { status: 'working', statusMessage: 'step 2', pollIntervalMs: 60_000 },
      { status: 'working', pollIntervalMs: null },
      {
        status: 'completed',
        result: { content: [{ type: 'text', text: 'built as a task' }] },
      },
    ],
  });
  const { loaded, waits } = await manager(t, stub);
  const shown: string[] = [];
  const text = await loaded.tools[0]!.run(
    {},
    { ...context(), progress: (line) => shown.push(line) },
  );
  assert.equal(String(text), 'built as a task');
  // The call said it takes a task, and so does each request about the task, which names it
  assert.ok(declared(stub.calls()[0]!));
  const gets = sentTo(stub, 'tasks/get');
  assert.equal(gets.length, 4);
  for (const get of gets) {
    assert.equal(get.message!.params!.taskId, TASK_ID);
    assert.ok(declared(get));
    assert.equal(get.headers['mcp-name'], TASK_ID);
  }
  // As far apart as the server says, between 250 ms and 30 seconds, and 2 seconds when it says nothing
  assert.deepEqual(waits, [5000, 250, 30_000, 2000]);
  assert.deepEqual(shown, [
    'task working · compiling',
    'task working · step 1',
    'task working · step 2',
    'task working',
    'task completed',
  ]);
});

test('a task that asks a question is answered once, with tasks/update, as a question in a call is', async (t) => {
  const question = {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: 'Deploy to production?',
      requestedSchema: {
        type: 'object',
        properties: { approved: { type: 'boolean', title: 'Approved' } },
        required: ['approved'],
      },
    },
  };
  const stub = await taskServer(t, {
    states: [
      { status: 'input_required', inputRequests: { confirm: question } },
      // Not taken in yet: the same question again, which is not asked twice
      { status: 'input_required', inputRequests: { confirm: question } },
      {
        status: 'completed',
        result: { content: [{ type: 'text', text: 'deployed' }] },
      },
    ],
  });
  const asked: Record<string, any>[] = [];
  const { loaded } = await manager(t, stub, {
    ask: async (args) => {
      asked.push(args);
      return JSON.stringify(['yes', 'send']);
    },
  });
  assert.equal(String(await loaded.tools[0]!.run({}, context())), 'deployed');
  assert.equal(asked.length, 1);
  assert.match(
    asked[0]!.questions[0].question,
    /^ci asks: Deploy to production\?/,
  );
  const updates = sentTo(stub, 'tasks/update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.message!.params!.taskId, TASK_ID);
  assert.deepEqual(updates[0]!.message!.params!.inputResponses, {
    confirm: { action: 'accept', content: { approved: true } },
  });
  assert.ok(declared(updates[0]!));
});

test('a task that asks what Circle does not answer is cancelled, and so is one in a state Circle does not know', async (t) => {
  const sampling = await taskServer(t, {
    states: [
      {
        status: 'input_required',
        inputRequests: {
          draft: { method: 'sampling/createMessage', params: {} },
        },
      },
    ],
  });
  const { loaded } = await manager(t, sampling);
  await assert.rejects(
    loaded.tools[0]!.run({}, context()),
    /asks for sampling\/createMessage, which Circle does not answer; Circle asked the server to cancel the task/,
  );
  await until(() => sentTo(sampling, 'tasks/cancel').length === 1);
  assert.deepEqual(
    sentTo(sampling, 'tasks/cancel')[0]!.message!.params!.taskId,
    TASK_ID,
  );
  assert.equal(sentTo(sampling, 'tasks/update').length, 0);

  const paused = await taskServer(t, { states: [{ status: 'paused' }] });
  const second = await manager(t, paused);
  await assert.rejects(
    second.loaded.tools[0]!.run({}, context()),
    /has a status Circle does not know \("paused"\); Circle asked the server to cancel it/,
  );
  await until(() => sentTo(paused, 'tasks/cancel').length === 1);
});

test("a failed or cancelled task says why: the error's message, else the status message, else a word of Circle's", async (t) => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [
      {
        status: 'failed',
        statusMessage: 'Tool execution failed',
        error: { code: -32603, message: 'API rate limit exceeded' },
      },
      /^API rate limit exceeded$/,
    ],
    [{ status: 'failed', statusMessage: 'out of disk' }, /^out of disk$/],
    [{ status: 'failed' }, /^Task failed$/],
    [{ status: 'cancelled' }, /^Task was cancelled by the server$/],
    [
      {
        status: 'completed',
        result: { content: [{ type: 'text', text: 'no' }], isError: true },
      },
      /^no$/,
    ],
  ];
  for (const [state, said] of cases) {
    const stub = await taskServer(t, { states: [state] });
    const { loaded } = await manager(t, stub);
    await assert.rejects(
      loaded.tools[0]!.run({}, context()),
      (error: Error) => {
        assert.match(error.message, said);
        return true;
      },
    );
  }
});

test('esc on a call that runs as a task sends tasks/cancel for it', async (t) => {
  const stub = await taskServer(t, { states: [{ status: 'working' }] });
  const { loaded } = await manager(t, stub);
  // The wait between status requests lasts until the call is stopped
  loaded.wait = (_ms, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    );
  const controller = new AbortController();
  const shown: string[] = [];
  const running = loaded.tools[0]!.run(
    {},
    {
      sessionId: 'one',
      signal: controller.signal,
      progress: (line) => shown.push(line),
    },
  );
  await until(() => shown.length === 1);
  controller.abort(new Error('interrupted'));
  await assert.rejects(running);
  await until(() => sentTo(stub, 'tasks/cancel').length === 1);
  const cancel = sentTo(stub, 'tasks/cancel')[0]!;
  assert.equal(cancel.message!.params!.taskId, TASK_ID);
  assert.ok(declared(cancel));
});

test("a task that runs past the call's time limit is cancelled, by the manager's clock", async (t) => {
  const stub = await taskServer(t, {
    first: { status: 'working' },
    states: [{ status: 'working' }],
  });
  // Each call of the server may take 5 seconds
  const { loaded } = await manager(t, stub, {}, { timeout: 5000 });
  let now = Date.UTC(2026, 10, 1);
  loaded.now = () => now;
  loaded.wait = async (ms) => {
    now += ms;
  };
  await assert.rejects(
    loaded.tools[0]!.run({}, context()),
    /task build-7f3a9c2e of ci ran past the call's time limit; Circle asked the server to cancel it/,
  );
  await until(() => sentTo(stub, 'tasks/cancel').length === 1);
  // Asked every 2 seconds: at 2 and 4 seconds, and at 6 the call is past its 5
  assert.equal(sentTo(stub, 'tasks/get').length, 2);
});

test('a task the server no longer knows ends the call: its outcome is unknown, and the call is not sent again', async (t) => {
  const stub = await taskServer(t, {
    // Read-only and idempotent: a call cut after it was sent would go once more, one whose task was made never does
    tools: [
      {
        name: 'build',
        inputSchema: schema,
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
    ],
    error: (request) =>
      request.message?.method === 'tasks/get'
        ? { code: -32602, message: 'Failed to retrieve task: Task not found' }
        : undefined,
  });
  const { loaded } = await manager(t, stub);
  await assert.rejects(
    loaded.tools[0]!.run({}, context()),
    /ci no longer knows task build-7f3a9c2e: its outcome is unknown/,
  );
  assert.equal(sentTo(stub, 'tasks/cancel').length, 0);
  assert.equal(stub.calls().length, 1);
});

test('a call takes no task outside the conversation of an interactive session, nor where the server does not run them', async (t) => {
  // A subagent's call
  const forSubagent = await taskServer(t);
  const subagent = await manager(t, forSubagent);
  assert.equal(
    String(
      await subagent.loaded.tools[0]!.run(
        {},
        { ...context(), identity: { sessionId: 'one', agentId: 'helper' } },
      ),
    ),
    'built at once',
  );
  assert.ok(!declared(forSubagent.calls()[0]!));
  // A run where no one is there, as print mode
  const headless = await taskServer(t);
  const quiet = await manager(t, headless, { interactive: false });
  assert.equal(
    String(await quiet.loaded.tools[0]!.run({}, context())),
    'built at once',
  );
  assert.ok(!declared(headless.calls()[0]!));
  // A server that does not say it runs tasks, and one on an earlier revision
  for (const options of [{ extension: false }, { modern: false }]) {
    const stub = await taskServer(t, options);
    const plain = await manager(t, stub);
    assert.equal(
      String(await plain.loaded.tools[0]!.run({}, context())),
      'built at once',
    );
    assert.ok(!declared(stub.calls()[0]!));
  }
  // A server that answers a call with a task though the call did not take one: the call fails
  const rude = await taskServer(t, { always: true });
  const strict = await manager(t, rude, { interactive: false });
  await assert.rejects(
    strict.loaded.tools[0]!.run({}, context()),
    /Unsupported result type 'task' for tools\/call/,
  );
  assert.equal(sentTo(rude, 'tasks/get').length, 0);
});

test('a tool the 2025-11-25 revision runs only as a task is not sent there; one that may be is called as any other', async (t) => {
  const required = await taskServer(t, {
    modern: false,
    tools: [
      {
        name: 'build',
        inputSchema: schema,
        execution: { taskSupport: 'required' },
      },
    ],
  });
  const strict = await manager(t, required);
  await assert.rejects(
    strict.loaded.tools[0]!.run({}, context()),
    /build runs only as a task of the 2025-11-25 revision, which Circle does not run; nothing was sent/,
  );
  assert.equal(required.calls().length, 0);
  const optional = await taskServer(t, {
    modern: false,
    tools: [
      {
        name: 'build',
        inputSchema: schema,
        execution: { taskSupport: 'optional' },
      },
    ],
  });
  const plain = await manager(t, optional);
  assert.equal(
    String(await plain.loaded.tools[0]!.run({}, context())),
    'built at once',
  );
  assert.equal(optional.calls()[0]!.message!.params!.task, undefined);
  assert.ok(!methods(optional).some((method) => method.startsWith('tasks/')));
});

test("the conversation's call is answered with the task's result in the model's next request", async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const stub = await taskServer(t, {
    states: [
      { status: 'working', statusMessage: 'linking' },
      {
        status: 'completed',
        result: { content: [{ type: 'text', text: 'built as a task' }] },
      },
    ],
  });
  const settings = defaultSettings();
  settings.mcpServers = { ci: { url: stub.url, type: 'http' } };
  const model = new ScriptedModel([
    reply('', [{ id: 'call-1', name: 'mcp__ci__build', args: {} }]),
    reply('done'),
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  runtime.mcp.wait = async () => {};
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  const seen: unknown[] = [];
  runtime.bus.subscribe((event) => {
    if (event.kind === 'tool_progress') seen.push(event.payload.text);
  });
  await runtime.harness.run('build it');
  assert.ok(declared(stub.calls()[0]!));
  assert.deepEqual(seen, [
    'task working · compiling',
    'task working · linking',
    'task completed',
  ]);
  const result = model.requests[1]!.messages.find(
    (message) => message.tool_call_id === 'call-1',
  )!;
  assert.equal(result.content, 'built as a task');
});

test('a call that runs as a task goes on as a background job like any other, and stopping the job cancels the task', async (t) => {
  const root = scratch(t);
  mkdirSync(join(root, 'workspace'));
  const stub = await taskServer(t, { states: [{ status: 'working' }] });
  const settings = defaultSettings();
  settings.mcpServers = { ci: { url: stub.url, type: 'http' } };
  const model = new ScriptedModel([
    reply('', [{ id: 'call-1', name: 'mcp__ci__build', args: {} }]),
    reply('waiting'),
  ]);
  const runtime = new AgentRuntime({
    home: join(root, 'home'),
    workspace: join(root, 'workspace'),
    userHome: join(root, 'user'),
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  runtime.mcp.autoBackgroundMs = 1;
  // The task works on until the call is stopped: Circle waits to ask how it stands until then
  let following = false;
  runtime.mcp.wait = (_ms, signal) => {
    following = true;
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    );
  };
  await runtime.harness.run('build it');
  const said = runtime.harness.messages.find(
    (message) => message.tool_call_id === 'call-1',
  )!.content;
  const id = /background job (j\d+)/.exec(said)![1]!;
  await until(() => following);
  assert.equal(runtime.jobs.get(id)!.status, 'running');
  assert.equal(sentTo(stub, 'tasks/cancel').length, 0);
  await runtime.jobs.stop(id, 'user');
  await until(() => sentTo(stub, 'tasks/cancel').length === 1);
  assert.equal(
    sentTo(stub, 'tasks/cancel')[0]!.message!.params!.taskId,
    TASK_ID,
  );
});

test("the notice of a task's call that went on in the background gives its whole result, through the same size limit", async (t) => {
  const root = scratch(t);
  mkdirSync(join(root, 'workspace'));
  const big = 'z'.repeat(60_000);
  const stub = await taskServer(t, {
    states: [
      {
        status: 'completed',
        result: { content: [{ type: 'text', text: big }] },
      },
    ],
  });
  const settings = defaultSettings();
  settings.mcpServers = { ci: { url: stub.url, type: 'http' } };
  const model = new ScriptedModel([
    reply('', [{ id: 'call-1', name: 'mcp__ci__build', args: {} }]),
    reply('waiting'),
    reply('read it'),
  ]);
  const runtime = new AgentRuntime({
    home: join(root, 'home'),
    workspace: join(root, 'workspace'),
    userHome: join(root, 'user'),
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  runtime.mcp.autoBackgroundMs = 1;
  // The task is asked about once the call went on in the background
  let release!: () => void;
  const moved = new Promise<void>((resolve) => (release = resolve));
  runtime.mcp.wait = () => moved;
  await runtime.harness.run('build it');
  const said = runtime.harness.messages.find(
    (message) => message.tool_call_id === 'call-1',
  )!.content;
  const id = /background job (j\d+)/.exec(said)![1]!;
  release();
  await until(() => runtime.jobs.get(id)!.status !== 'running');
  assert.equal(runtime.jobs.get(id)!.status, 'done');
  await runtime.harness.run('anything new?');
  const told = model.requests
    .at(-1)!
    .messages.map((message) => message.content)
    .join('\n');
  assert.match(
    told,
    /The result of mcp__ci__build is too large to give here \(60000 characters, about \d+ tokens\), so it was kept in full in \/large_tool_results\/[0-9a-f]+\.txt/,
  );
  assert.ok(!told.includes(big));
});
