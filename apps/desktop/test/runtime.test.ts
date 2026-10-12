import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { emptyUsage, type Message } from '../../../src/types.ts';
import {
  saveSettings,
  loadSettings,
  trustFolder,
  defaultSettings,
} from '../../../src/settings.ts';
import { visibleMessages } from '../../workbench/src/model/state.ts';
import { createServer } from 'node:http';
import { ModelCatalog } from '../../../src/model_catalog.ts';
import type {
  RuntimeCommandName,
  RuntimeUpdate,
} from '../src/runtime-protocol.ts';

async function wait(check: () => boolean, description: string) {
  const end = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > end) throw Error(`timed out: ${description}`);
    await delay(10);
  }
}
const assistant = (
  content: string,
  calls?: Message['tool_calls'],
): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content,
  tool_calls: calls,
});
async function setup(
  t: TestContext,
  replies: ConstructorParameters<typeof ScriptedModel>[0],
  trusted = true,
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-core-desktop-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  await mkdir(join(workspace, '.git'));
  saveSettings(
    trusted ? trustFolder(defaultSettings(), workspace) : defaultSettings(),
    home,
  );
  const model = new ScriptedModel(replies);
  const updates: RuntimeUpdate[] = [];
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: (update) => updates.push(update),
  });
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ) => controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, workspace, model, controller, call, updates };
}

test('native approval waits at the core gate; stale replies do not write a file', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        {
          id: 'write-1',
          name: 'write_file',
          args: { file_path: 'result.txt', content: 'approved bytes' },
        },
      ]),
    },
    { message: assistant('written after approval') },
  ]);
  assert.equal((await f.call('prompt', { text: 'write a file' })).ok, true);
  await wait(
    () =>
      f.controller
        .snapshot()
        .interactions.some((row) => row.status === 'pending'),
    'approval',
  );
  assert.equal(existsSync(join(f.workspace, 'result.txt')), false);
  assert.equal(f.model.requests.length, 1);
  const row = f.controller
    .snapshot()
    .interactions.find((row) => row.status === 'pending')!;
  for (const [revision, sessionId] of [
    [2, row.sessionId],
    [1, 'another-session'],
  ] as const) {
    assert.equal(
      (
        await f.call(
          'answer',
          { id: row.id, revision, answer: 'approve' },
          sessionId,
        )
      ).ok,
      false,
    );
    assert.equal(existsSync(join(f.workspace, 'result.txt')), false);
  }
  assert.equal(
    (await f.call('answer', { id: row.id, revision: 1, answer: 'approve' })).ok,
    true,
  );
  await wait(
    () =>
      f.model.requests.length === 2 &&
      f.controller.snapshot().sessions[0]!.state === 'idle',
    'completed turn',
  );
  assert.equal(
    await readFile(join(f.workspace, 'result.txt'), 'utf8'),
    'approved bytes',
  );
  assert(
    f.model.requests[1]!.messages.some(
      (message) =>
        message.role === 'tool' &&
        message.status === 'success' &&
        message.content.includes('result.txt'),
    ),
  );
  const messages = visibleMessages(
    f.controller.snapshot().sessions.find((s) => s.id === row.sessionId)!,
  );
  assert(
    messages.some(
      (message) => message.role === 'user' && message.text === 'write a file',
    ),
  );
  assert(
    messages.some((message) => message.tool?.output.includes('result.txt')),
  );
  assert(messages.some((message) => message.text === 'written after approval'));
  assert.equal(
    (await f.call('answer', { id: row.id, revision: 1, answer: 'approve' })).ok,
    false,
  );
});

test('rejection reaches the next real model request without an effect', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        {
          id: 'denied',
          name: 'write_file',
          args: { file_path: 'denied.txt', content: 'never written' },
        },
      ]),
    },
    { message: assistant('not written') },
  ]);
  await f.call('prompt', { text: 'write' });
  await wait(() => f.controller.snapshot().interactions.length > 0, 'approval');
  const row = f.controller.snapshot().interactions[0]!;
  await f.call('answer', {
    id: row.id,
    revision: row.revision,
    answer: 'reject: wait for review',
  });
  await wait(() => f.model.requests.length === 2, 'rejection in model input');
  assert.equal(existsSync(join(f.workspace, 'denied.txt')), false);
  assert(
    f.model.requests[1]!.messages.some(
      (message) =>
        message.role === 'tool' &&
        message.status === 'error' &&
        message.content.includes('wait for review'),
    ),
  );
});

test('question selections and plan exit use the awaited core interaction', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        {
          id: 'question-1',
          name: 'question',
          args: {
            questions: [
              { question: 'which target?', options: ['staging', 'local'] },
            ],
          },
        },
      ]),
    },
    { message: assistant('target received') },
    { message: assistant('', [{ id: 'plan-1', name: 'plan_exit', args: {} }]) },
    { message: assistant('implementing') },
  ]);
  await f.call('prompt', { text: 'ask' });
  await wait(
    () =>
      f.controller
        .snapshot()
        .interactions.some(
          (i) => i.kind === 'question' && i.status === 'pending',
        ),
    'question',
  );
  let row = f.controller
    .snapshot()
    .interactions.find((i) => i.status === 'pending')!;
  await f.call('answer', {
    id: row.id,
    revision: 1,
    answer: JSON.stringify({ choices: ['staging'], comment: '' }),
  });
  await wait(
    () => f.controller.snapshot().sessions[0]!.state === 'idle',
    'question finish',
  );
  assert(
    f.model.requests[1]!.messages.some(
      (m) => m.role === 'tool' && m.content.includes('staging'),
    ),
  );
  await f.call('set-plan-mode', { enabled: true });
  await f.call('prompt', { text: 'implement the plan' });
  await wait(
    () =>
      f.controller.snapshot().interactions.some((i) => i.status === 'pending'),
    'plan exit',
  );
  row = f.controller
    .snapshot()
    .interactions.find((i) => i.status === 'pending')!;
  await f.call('answer', {
    id: row.id,
    revision: 1,
    answer: JSON.stringify({ choices: ['implement plan'], comment: '' }),
  });
  await wait(
    () => f.controller.snapshot().sessions[0]!.state === 'idle',
    'plan finish',
  );
  assert.equal(f.controller.snapshot().sessions[0]!.readOnly, false);
});

test('cancel aborts the model, invalidates the interaction, and preserves raw history', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        {
          id: 'pending',
          name: 'write_file',
          args: { file_path: 'pending.txt', content: 'no' },
        },
      ]),
    },
  ]);
  await f.call('prompt', { text: 'write later' });
  await wait(() => f.controller.snapshot().interactions.length > 0, 'approval');
  const row = f.controller.snapshot().interactions[0]!;
  assert.equal((await f.call('abort')).ok, true);
  assert.equal(f.controller.snapshot().sessions[0]!.state, 'idle');
  assert.equal(existsSync(join(f.workspace, 'pending.txt')), false);
  assert.equal(
    (await f.call('answer', { id: row.id, revision: 1, answer: 'approve' })).ok,
    false,
  );
  const exported = await f.call('export');
  assert.equal(exported.ok, true);
  assert(
    String((exported.data as { content: string }).content).includes(
      'write later',
    ),
  );
});

test('checkpoint branches, import and restart preserve native identities and model inputs', async (t) => {
  const f = await setup(t, [
    { message: assistant('first answer') },
    { message: assistant('second answer') },
  ]);
  await f.call('prompt', { text: 'first question' });
  await wait(
    () => f.controller.snapshot().sessions[0]!.state === 'idle',
    'first',
  );
  const firstId = f.controller.snapshot().activeSessionId;
  await f.call('prompt', { text: 'second question' });
  await wait(
    () => f.controller.snapshot().sessions[0]!.state === 'idle',
    'second',
  );
  const oldSession = f.controller
    .snapshot()
    .sessions.find((s) => s.id === firstId)!;
  const point = oldSession.messages.find((m) => m.text === 'second question')!;
  const fork = await f.call('fork', { messageId: point.id });
  assert.equal(fork.ok, true);
  const newId = f.controller.snapshot().activeSessionId;
  assert.notEqual(newId, firstId);
  assert.deepEqual(
    visibleMessages(
      f.controller.snapshot().sessions.find((s) => s.id === newId)!,
    )
      .filter((m) => m.text)
      .map((m) => m.text),
    ['first question', 'first answer'],
  );
  const exportReply = await f.call('export');
  const bundle = (exportReply.data as { content: string }).content;
  await f.call('import', { content: bundle });
  assert.notEqual(f.controller.snapshot().activeSessionId, newId);
  const importId = f.controller.snapshot().activeSessionId;
  await f.controller.close();
  const restart = new RuntimeController({
    home: f.home,
    model: new ScriptedModel([{ message: assistant('after restart') }]),
    userHome: f.home,
    emit: () => {},
  });
  assert.equal(restart.snapshot().activeSessionId, importId);
  assert(
    visibleMessages(
      restart.snapshot().sessions.find((s) => s.id === importId)!,
    ).some((m) => m.text === 'first answer'),
  );
  assert.equal(restart.snapshot().sessions[0]!.auto, false);
  await restart.close();
});

test('untrusted workspaces cannot load project context, extensions or execute prompts', async (t) => {
  const f = await setup(t, [{ message: assistant('trusted now') }], false);
  await writeFile(join(f.workspace, 'AGENTS.md'), 'private instruction marker');
  await writeFile(join(f.workspace, 'MEMORY.md'), 'private memory marker');
  await mkdir(join(f.workspace, '.circle/extensions/test'), {
    recursive: true,
  });
  await writeFile(
    join(f.workspace, '.circle/extensions/test/extension.mjs'),
    'throw Error("must not load before trust")',
  );
  assert.equal((await f.call('prompt', { text: 'hello' })).ok, false);
  assert.equal(f.model.requests.length, 0);
  assert.equal((await f.call('trust', { enabled: true })).ok, true);
  await f.call('prompt', { text: 'hello' });
  await wait(() => f.model.requests.length > 0, 'trusted request');
  assert(f.model.requests[0]!.system.includes('private instruction marker'));
});

test('configuration secrets never appear in snapshots or events', async (t) => {
  const f = await setup(t, []);
  const secret = 'fixture-key-private-9279';
  assert.equal(
    (
      await f.call('configure', {
        endpoint: 'http://127.0.0.1:45678/v1',
        protocol: 'openai',
        model: 'fixture-model',
        apiKey: secret,
      })
    ).ok,
    true,
  );
  assert.equal(JSON.stringify(f.controller.snapshot()).includes(secret), false);
  assert.equal(JSON.stringify(f.updates).includes(secret), false);
  assert(
    (await readFile(join(f.home, 'credentials.json'), 'utf8')).includes(secret),
  );
  await f.call('logout');
  assert.equal(JSON.stringify(f.controller.snapshot()).includes(secret), false);
  assert.equal(
    (await readFile(join(f.home, 'credentials.json'), 'utf8')).includes(secret),
    false,
  );
});

test('masked secret replies write the target through core collection without entering model input', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        {
          id: 'secret-call',
          name: 'question',
          args: {
            questions: [
              {
                question: 'API token',
                secret: true,
                key: 'API_TOKEN',
                target_file: '.env',
              },
            ],
          },
        },
      ]),
    },
    { message: assistant('secret received privately') },
  ]);
  await f.call('prompt', { text: 'collect credential' });
  await wait(
    () =>
      f.controller.snapshot().interactions.some((row) => row.kind === 'secret'),
    'masked secret',
  );
  const row = f.controller
    .snapshot()
    .interactions.find((row) => row.kind === 'secret')!;
  const secret = 'private-test-value-8305';
  assert.equal(
    (await f.call('answer', { id: row.id, revision: 1, answer: secret })).ok,
    true,
  );
  await wait(() => f.model.requests.length === 2, 'secret result');
  assert.equal(
    await readFile(join(f.workspace, '.env'), 'utf8'),
    `API_TOKEN=${secret}\n`,
  );
  assert.equal(JSON.stringify(f.model.requests).includes(secret), false);
  assert.equal(JSON.stringify(f.updates).includes(secret), false);
});

test('selectively removing queued input preserves other input and actual following model requests', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await setup(t, [
    async (request) => {
      await gate;
      request.signal.throwIfAborted();
      return { message: assistant('initial answer'), usage: emptyUsage() };
    },
    { message: assistant('follow-up answer') },
  ]);
  await f.call('prompt', { text: 'initial' });
  await wait(() => f.model.requests.length === 1, 'first request');
  await f.call('prompt', { text: 'remove this', kind: 'follow-up' });
  await f.call('prompt', { text: 'keep this', kind: 'follow-up' });
  assert.equal(
    (
      await f.call('remove-queued', {
        kind: 'follow-up',
        index: 0,
        text: 'stale text',
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await f.call('remove-queued', {
        kind: 'follow-up',
        index: 0,
        text: 'remove this',
      })
    ).ok,
    true,
  );
  assert.deepEqual(
    f.controller.snapshot().sessions[0]!.queue.map((entry) => entry.text),
    ['keep this'],
  );
  release();
  await wait(
    () =>
      f.model.requests.length === 2 &&
      f.controller.snapshot().sessions[0]!.state === 'idle',
    'follow-up',
  );
  assert(
    f.model.requests[1]!.messages.some(
      (m) => m.role === 'user' && m.content === 'keep this',
    ),
  );
  assert.equal(JSON.stringify(f.model.requests).includes('remove this'), false);
});

test('shell execution is real, shares output according to core semantics and respects plan mode', async (t) => {
  const f = await setup(t, [{ message: assistant('shell output reviewed') }]);
  const reply = await f.call('shell', {
    command:
      process.platform === 'win32'
        ? 'echo native-shell'
        : 'printf native-shell',
  });
  assert.equal(reply.ok, true);
  assert.equal(
    (reply.data as { output: string }).output.trim(),
    'native-shell',
  );
  await f.call('prompt', { text: 'review my shell output' });
  await wait(() => f.model.requests.length === 1, 'shell in model input');
  assert(
    f.model.requests[0]!.messages.some((m) =>
      m.shell?.output.includes('native-shell'),
    ),
  );
  await wait(
    () => f.controller.snapshot().sessions[0]!.state === 'idle',
    'review finish',
  );
  await f.call('set-plan-mode', { enabled: true });
  assert.equal((await f.call('shell', { command: 'echo blocked' })).ok, false);
});

test('subagent interaction remains bound to its actual parent and child sessions', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        {
          id: 'task-parent',
          name: 'task',
          args: {
            description: 'ask which target',
            subagent_type: 'general-purpose',
          },
        },
      ]),
    },
    {
      message: assistant('', [
        {
          id: 'question-child',
          name: 'question',
          args: {
            questions: [{ question: 'Child target?', options: ['local'] }],
          },
        },
      ]),
    },
    { message: assistant('child done') },
    { message: assistant('parent received child') },
  ]);
  await f.call('prompt', { text: 'delegate this question' });
  await wait(
    () =>
      f.controller
        .snapshot()
        .interactions.some((row) => row.status === 'pending'),
    'child interaction',
  );
  const row = f.controller
    .snapshot()
    .interactions.find((row) => row.status === 'pending')!;
  assert.equal(row.sessionId, f.controller.snapshot().activeSessionId);
  assert(row.origin?.agent);
  assert.notEqual(row.origin.agent, row.sessionId);
  await f.call('answer', { id: row.id, revision: 1, answer: 'local' });
  await wait(
    () =>
      f.model.requests.length === 4 &&
      f.controller.snapshot().sessions[0]!.state === 'idle',
    'parent finish',
  );
  assert(
    f.controller
      .snapshot()
      .agents.some(
        (agent) =>
          agent.id === row.origin!.agent &&
          agent.messages.some((m) => m.text === 'child done'),
      ),
  );
  assert(
    f.model.requests[3]!.messages.some(
      (m) => m.role === 'tool' && m.content.includes('child done'),
    ),
  );
});

test('saved API configuration, model selection and effort produce actual local gateway requests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-desktop-gateway-'));
  const home = join(root, 'home');
  await mkdir(home);
  const requests: {
    model: string;
    reasoning_effort?: string;
    messages: unknown[];
    auth?: string;
  }[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          data: [{ id: 'fixture-one' }, { id: 'fixture-two' }],
        }),
      );
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    requests.push({ ...data, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', model: data.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'local gateway answer' }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', model: data.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const controller = new RuntimeController({
    home,
    userHome: home,
    catalog: (path) =>
      new ModelCatalog(path, { env: { CIRCLE_NO_MODELS_REFRESH: '1' } }),
    emit: () => {},
  });
  t.after(async () => {
    await controller.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
  ) =>
    controller.dispatch({
      id: randomUUID(),
      name,
      sessionId: controller.snapshot().activeSessionId,
      payload,
    });
  const port = (server.address() as { port: number }).port;
  assert.equal((await call('prompt', { text: 'before setup' })).ok, false);
  assert.equal(
    (
      await call('configure', {
        endpoint: `http://127.0.0.1:${port}/v1`,
        protocol: 'openai',
        model: 'fixture-one',
        apiKey: 'local-fixture-secret',
      })
    ).ok,
    true,
  );
  assert.equal((await call('discover-models')).ok, true);
  assert(
    controller.snapshot().models.some((model) => model.id === 'fixture-two'),
  );
  assert.equal((await call('set-model', { modelId: 'fixture-two' })).ok, true);
  assert.equal((await call('set-effort', { effort: 'high' })).ok, true);
  assert.equal(
    (await call('prompt', { text: 'use the selected model' })).ok,
    true,
  );
  await wait(
    () =>
      requests.length === 1 &&
      controller.snapshot().sessions[0]!.state === 'idle',
    'gateway answer',
  );
  assert.equal(requests[0]!.auth, 'Bearer local-fixture-secret');
  assert.equal(requests[0]!.model, 'fixture-two');
  assert.equal(requests[0]!.reasoning_effort, 'high');
  assert(
    controller
      .snapshot()
      .sessions[0]!.messages.some((m) => m.text === 'local gateway answer'),
  );
  await call('logout');
  assert.equal((await call('prompt', { text: 'after logout' })).ok, false);
  assert.equal((await call('compact')).ok, false);
  assert.equal(requests.length, 1);
});

test('the connection form probes endpoints as setup does, lists only the saved endpoint models and never sends a key to another host', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-desktop-probe-'));
  const home = join(root, 'home');
  await mkdir(home);
  // Three local endpoints, each recording what reached it: OpenAI-style models under /v1
  // only, an Anthropic-style path that takes x-api-key, and one that answers 404 to all.
  const seen = {
    openai: [] as string[],
    anthropic: [] as string[],
    none: [] as string[],
  };
  let anthropicDown = false;
  const endpoint = async (
    name: keyof typeof seen,
    answer: (req: import('node:http').IncomingMessage) => unknown,
  ) => {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req);
      seen[name].push(
        [
          req.method,
          req.url,
          req.headers.authorization,
          req.headers['x-api-key'],
        ]
          .filter(Boolean)
          .join(' '),
      );
      const body = answer(req);
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body ?? { error: 'not here' }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const openai = await endpoint('openai', (req) =>
    req.url === '/v1/models'
      ? { data: [{ id: 'open-one' }, { id: 'open-two' }] }
      : undefined,
  );
  const anthropic = await endpoint('anthropic', (req) =>
    !anthropicDown &&
    req.url === '/apps/anthropic/v1/models' &&
    req.headers['x-api-key'] === 'key-b'
      ? { data: [{ id: 'claude-fixture' }, { id: 'claude-other' }] }
      : undefined,
  );
  const none = await endpoint('none', () => undefined);
  const updates: RuntimeUpdate[] = [];
  const controller = new RuntimeController({
    home,
    userHome: home,
    catalog: (path) =>
      new ModelCatalog(path, { env: { CIRCLE_NO_MODELS_REFRESH: '1' } }),
    emit: (update) => updates.push(update),
  });
  const replies: unknown[] = [];
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = async (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
  ) => {
    const reply = await controller.dispatch({
      id: randomUUID(),
      name,
      sessionId: controller.snapshot().activeSessionId,
      payload,
    });
    replies.push(reply);
    return reply;
  };
  const models = () => controller.snapshot().models.map((model) => model.id);
  // Nothing saved: a key is needed before anything is asked
  const keyless = await call('probe-connection', {
    endpoint: openai,
    apiKey: '',
  });
  assert.equal(keyless.ok, false);
  assert.equal(keyless.error, 'enter the API key for this endpoint');
  assert.deepEqual(seen.openai, []);
  // OpenAI-style, listed only under /v1: that URL is the one to save
  const first = await call('probe-connection', {
    endpoint: openai + '/',
    apiKey: 'key-a',
  });
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.data, {
    status: 'discovered',
    protocol: 'openai',
    models: ['open-one', 'open-two'],
    baseUrl: `${openai}/v1`,
    inferred: false,
    summary: 'discovered 2 models (openai)',
    detail: '',
  });
  assert.deepEqual(seen.openai, [
    'GET /models Bearer key-a',
    'GET /v1/models Bearer key-a',
  ]);
  // Probing saves nothing
  assert.equal(existsSync(join(home, 'credentials.json')), false);
  assert.equal(loadSettings(home).auth.base_url, '');
  const saved = await call('configure', {
    endpoint: `${openai}/v1`,
    protocol: 'openai',
    model: 'open-one',
    apiKey: 'key-a',
  });
  assert.equal(saved.ok, true, saved.error);
  assert.deepEqual(
    models()
      .filter((id) => id.startsWith('open-'))
      .sort(),
    ['open-one', 'open-two'],
  );
  assert.equal(
    (
      await call('save-settings', {
        settings: { enabledModels: ['open-two'] },
      })
    ).ok,
    true,
  );
  assert.deepEqual(controller.snapshot().settings.enabledModels, ['open-two']);
  // The same host keeps the saved key when none is typed, on another path too
  seen.openai.length = 0;
  const again = await call('probe-connection', {
    endpoint: `${openai}/v1`,
    apiKey: '',
  });
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(seen.openai, ['GET /v1/models Bearer key-a']);
  // Another host does not get it: the probe and the save are refused, nothing is sent
  for (const name of ['probe-connection', 'configure'] as const) {
    const refused = await call(name, {
      endpoint: `${anthropic}/apps/anthropic`,
      protocol: 'anthropic',
      model: 'claude-fixture',
      apiKey: '',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'enter the API key for this endpoint');
  }
  assert.deepEqual(seen.anthropic, []);
  assert.equal(loadSettings(home).auth.base_url, `${openai}/v1`);
  // Anthropic-style: the URL names it, so it is asked first, with x-api-key
  const second = await call('probe-connection', {
    endpoint: `${anthropic}/apps/anthropic`,
    apiKey: 'key-b',
  });
  assert.equal(second.ok, true, second.error);
  assert.deepEqual(second.data, {
    status: 'discovered',
    protocol: 'anthropic',
    models: ['claude-fixture', 'claude-other'],
    baseUrl: `${anthropic}/apps/anthropic`,
    inferred: false,
    summary: 'discovered 2 models (anthropic)',
    detail: '',
  });
  assert.deepEqual(seen.anthropic, ['GET /apps/anthropic/v1/models key-b']);
  assert.equal(
    (
      await call('configure', {
        endpoint: `${anthropic}/apps/anthropic`,
        protocol: 'anthropic',
        model: 'claude-fixture',
        apiKey: 'key-b',
      })
    ).ok,
    true,
  );
  // Only the new endpoint's models: the old ones and their ctrl+p scope are gone
  assert(models().includes('claude-other'));
  assert(!models().some((id) => id.startsWith('open-')), models().join());
  assert.deepEqual(controller.snapshot().settings.enabledModels, []);
  assert.deepEqual(loadSettings(home).enabled_models, []);
  assert.equal(
    controller.snapshot().settings.endpoint,
    `${anthropic}/apps/anthropic`,
  );
  assert.equal(controller.snapshot().settings.protocol, 'anthropic');
  // A refresh that fails is an answer, not an error; the list stays as it was
  anthropicDown = true;
  const refresh = await call('discover-models');
  assert.equal(refresh.ok, true, refresh.error);
  assert.deepEqual(refresh.data, {
    status: 'failed',
    models: [],
    detail: 'http 404',
  });
  assert(models().includes('claude-other'));
  anthropicDown = false;
  assert.deepEqual((await call('discover-models')).data, {
    status: 'discovered',
    models: ['claude-fixture', 'claude-other'],
    detail: '',
  });
  // An endpoint that lists nothing (as an Anthropic-style path without GET /v1/models):
  // failed, with the kind of API its URL suggests, and saved as typed
  const third = await call('probe-connection', {
    endpoint: `${none}/apps/anthropic`,
    apiKey: 'key-c',
  });
  assert.equal(third.ok, true, third.error);
  assert.deepEqual(third.data, {
    status: 'failed',
    protocol: 'anthropic',
    models: [],
    baseUrl: `${none}/apps/anthropic`,
    inferred: true,
    summary: 'model discovery failed; protocol is unverified (http 404)',
    detail: 'http 404',
  });
  assert(seen.none.length > 0);
  assert.equal(
    (
      await call('configure', {
        endpoint: `${none}/apps/anthropic`,
        protocol: 'anthropic',
        model: 'typed-model',
        apiKey: 'key-c',
      })
    ).ok,
    true,
  );
  assert(models().includes('typed-model'));
  assert(!models().includes('claude-other'), models().join());
  assert.deepEqual(loadSettings(home).auth, {
    protocol: 'anthropic',
    base_url: `${none}/apps/anthropic`,
    model: 'typed-model',
    api_key_ref: 'api_key',
  });
  // No key ever reached another host, a reply, a snapshot or an event
  assert(!seen.anthropic.some((line) => /key-a|key-c/.test(line)));
  assert(!seen.none.some((line) => /key-a|key-b/.test(line)));
  assert(!seen.openai.some((line) => /key-b|key-c/.test(line)));
  for (const key of ['key-a', 'key-b', 'key-c'])
    for (const shown of [replies, updates, controller.snapshot()])
      assert.equal(JSON.stringify(shown).includes(key), false, key);
});

test('a retried native command cannot create duplicate sessions or change its bound input', async (t) => {
  const f = await setup(t, []);
  const command = {
    id: randomUUID(),
    name: 'new-session',
    sessionId: f.controller.snapshot().activeSessionId,
    payload: {},
  };
  const [first, second] = await Promise.all([
    f.controller.dispatch(command),
    f.controller.dispatch(command),
  ]);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(f.controller.snapshot().sessions.length, 2);
  assert.equal(
    (
      await f.controller.dispatch({
        ...command,
        name: 'delete-session',
        payload: { id: command.sessionId },
      })
    ).ok,
    false,
  );
  assert.equal(f.controller.snapshot().sessions.length, 2);
});

test('saved command templates expand real shell output into the next model request', async (t) => {
  const f = await setup(t, [{ message: assistant('template executed') }]);
  const shell =
    process.platform === 'win32'
      ? 'echo shell-template'
      : 'printf shell-template';
  assert.equal(
    (
      await f.call('save-command', {
        name: 'inspect-local',
        scope: 'project',
        description: 'inspect',
        template: `Review $ARGUMENTS: !\`${shell}\``,
      })
    ).ok,
    true,
  );
  assert(
    f.controller
      .snapshot()
      .commands.some((command) => command.name === 'inspect-local'),
  );
  assert.equal(
    (
      await f.call('custom-command', {
        name: 'inspect-local',
        args: 'the project',
      })
    ).ok,
    true,
  );
  await wait(() => f.model.requests.length === 1, 'template model request');
  assert(
    f.model.requests[0]!.messages.some((m) =>
      m.content.includes('Review the project: shell-template'),
    ),
  );
});

test('cancelling a secret ends the pending callback without creating its target', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        {
          id: 'secret-cancel',
          name: 'question',
          args: {
            questions: [
              {
                question: 'Token?',
                secret: true,
                key: 'TOKEN',
                target_file: '.env',
              },
            ],
          },
        },
      ]),
    },
    { message: assistant('request cancelled') },
  ]);
  await f.call('prompt', { text: 'ask for a secret' });
  await wait(
    () => f.controller.snapshot().interactions.some((i) => i.kind === 'secret'),
    'secret',
  );
  const row = f.controller
    .snapshot()
    .interactions.find((i) => i.kind === 'secret')!;
  assert.equal(
    (
      await f.call('answer', {
        id: row.id,
        revision: row.revision,
        cancel: true,
      })
    ).ok,
    true,
  );
  await wait(
    () =>
      f.model.requests.length === 2 &&
      f.controller.snapshot().sessions[0]!.state === 'idle',
    'cancelled secret turn',
  );
  assert.equal(existsSync(join(f.workspace, '.env')), false);
  assert.equal(
    f.controller.snapshot().interactions.some((i) => i.status === 'pending'),
    false,
  );
});

test('MCP configuration saves preserve private fields and show pending reload honestly', async (t) => {
  const f = await setup(t, []);
  const settings = loadSettings(f.home);
  settings.mcp_servers = [
    {
      id: 'stable-server',
      name: 'fixture',
      transport: 'stdio',
      command: 'unused-fixture',
      args: ['--path', 'folder with spaces'],
      env: { MCP_SECRET: 'fixture-private-env' },
      enabled: false,
    },
  ];
  saveSettings(settings, f.home);
  const draft = f.controller.snapshot().mcp;
  assert.equal(draft[0]!.status, 'reload required');
  assert.equal(
    (await f.call('save-settings', { settings: {}, mcp: draft })).ok,
    true,
  );
  const saved = loadSettings(f.home).mcp_servers[0]!;
  assert.deepEqual(saved.args, ['--path', 'folder with spaces']);
  assert.deepEqual(saved.env, { MCP_SECRET: 'fixture-private-env' });
  assert.equal(saved.id, 'stable-server');
  assert.equal(
    JSON.stringify(f.controller.snapshot()).includes('fixture-private-env'),
    false,
  );
  assert.equal(f.controller.snapshot().mcp[0]!.status, 'reload required');
});

test('attached pictures go as mentioned ones do: a large PNG is scaled down and both sizes named, and a text-only model gets none', async (t) => {
  const { PNG } = await import('pngjs');
  const picture = (width: number, height: number) => {
    const image = new PNG({ width, height });
    image.data.fill(180);
    return PNG.sync.write(image).toString('base64');
  };
  const f = await setup(t, [
    { message: assistant('seen') },
    { message: assistant('seen as text') },
  ]);
  await f.call('prompt', {
    text: 'look at these',
    attachments: [
      { content: picture(3000, 2000), mime: 'image/png', name: 'wide.png' },
      { content: picture(40, 30), mime: 'image/png', name: 'small.png' },
    ],
  });
  await wait(
    () =>
      f.model.requests.length === 1 &&
      f.controller.snapshot().sessions[0]!.state === 'idle',
    'first answer',
  );
  const user = f.model.requests[0]!.messages.find((m) => m.role === 'user')!;
  const sizes = user.attachments!.map((item) => {
    const image = PNG.sync.read(Buffer.from(item.data, 'base64'));
    return `${image.width}×${image.height}`;
  });
  assert.deepEqual(sizes, ['1313×875', '40×30']);
  assert.equal(
    user.content,
    'look at these\n\n[Scaled down to send: wide.png 3000×2000, sent as 1313×875]',
  );
  // A model known not to read images gets the text only
  Object.assign(f.model, { imageInput: false });
  await f.call('prompt', {
    text: 'and this',
    attachments: [
      { content: picture(40, 30), mime: 'image/png', name: 'small.png' },
    ],
  });
  await wait(() => f.model.requests.length === 2, 'second request');
  const second = f.model.requests[1]!.messages.at(-1)!;
  assert.equal(second.content, 'and this');
  assert.equal(second.attachments, undefined);
});

test('a failed turn stays in the conversation after the message it followed, and a later turn goes below it', async (t) => {
  const f = await setup(t, [
    async () => {
      throw new Error('the gateway answered 500');
    },
    { message: assistant('second time lucky') },
  ]);
  await f.call('prompt', { text: 'first try' });
  await wait(
    () =>
      f.model.requests.length === 1 &&
      f.controller.snapshot().sessions[0]!.state === 'idle',
    'failed turn',
  );
  const rows = () => {
    const session = f.controller.snapshot().sessions[0]!;
    return visibleMessages(session).map((m) => `${m.role}: ${m.text}`);
  };
  assert.deepEqual(rows(), [
    'user: first try',
    'notice: ✖ the gateway answered 500',
  ]);
  await f.call('prompt', { text: 'again' });
  await wait(
    () =>
      f.model.requests.length === 2 &&
      f.controller.snapshot().sessions[0]!.state === 'idle',
    'second turn',
  );
  assert.deepEqual(rows(), [
    'user: first try',
    'notice: ✖ the gateway answered 500',
    'user: again',
    'assistant: second time lucky',
  ]);
  // The model never reads the notice
  assert.equal(
    JSON.stringify(f.model.requests[1]!.messages).includes('✖'),
    false,
  );
});

test('a message may carry pictures of several megabytes, scaled down by the core; other commands stay small', async (t) => {
  const { PNG } = await import('pngjs');
  // Noise does not compress: about 10 MB, over the 5 MB other commands may carry
  const image = new PNG({ width: 2000, height: 1500 });
  let seed = 7;
  for (let at = 0; at < image.data.length; at++)
    image.data[at] =
      at % 4 === 3 ? 255 : (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  const content = PNG.sync.write(image).toString('base64');
  assert.ok(content.length > 5_000_000);
  const f = await setup(t, [{ message: assistant('a big one') }]);
  const sent = await f.call('prompt', {
    text: 'look at the big one',
    attachments: [{ content, mime: 'image/png', name: 'screen.png' }],
  });
  assert.equal(sent.ok, true, sent.error);
  await wait(
    () =>
      f.model.requests.length === 1 &&
      f.controller.snapshot().sessions[0]!.state === 'idle',
    'answer',
  );
  const user = f.model.requests[0]!.messages.find((m) => m.role === 'user')!;
  const sentImage = PNG.sync.read(
    Buffer.from(user.attachments![0]!.data, 'base64'),
  );
  assert.ok(sentImage.width * sentImage.height <= 1_150_000);
  assert.match(
    user.content,
    /\[Scaled down to send: screen\.png 2000×1500, sent as \d+×\d+\]$/,
  );
  const renamed = await f.call('rename-session', {
    id: f.controller.snapshot().activeSessionId,
    title: 'x'.repeat(6_000_000),
  });
  assert.equal(renamed.ok, false);
  assert.match(String(renamed.error), /invalid runtime payload/);
  const huge = await f.call('prompt', { text: 'x'.repeat(65_000_000) });
  assert.equal(huge.ok, false);
  assert.match(String(huge.error), /over 64 MB; remove some pictures or PDFs/);
});

const activeSession = (f: { controller: RuntimeController }) => {
  const snapshot = f.controller.snapshot();
  return snapshot.sessions.find((row) => row.id === snapshot.activeSessionId)!;
};

test('accept-edits edits without asking, keeps call order, and shows the diff and the change', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        { id: 'read', name: 'read_file', args: { file_path: 'calc.py' } },
      ]),
    },
    {
      message: assistant('', [
        {
          id: 'edit',
          name: 'edit_file',
          args: {
            file_path: 'calc.py',
            old_string: 'a - b',
            new_string: 'a + b',
          },
        },
        { id: 'run', name: 'execute', args: { command: 'touch ran.txt' } },
      ]),
      usage: { ...emptyUsage(), input_tokens: 120, output_tokens: 30 },
    },
    {
      message: assistant('done'),
      usage: { ...emptyUsage(), input_tokens: 150, output_tokens: 5 },
    },
  ]);
  await writeFile(
    join(f.workspace, 'calc.py'),
    'def add(a, b):\n    return a - b\n',
  );
  assert.equal((await f.call('set-mode', { mode: 'sometimes' })).ok, false);
  assert.equal((await f.call('set-mode', { mode: 'accept-edits' })).ok, true);
  assert.equal(activeSession(f).mode, 'accept-edits');
  assert.equal((await f.call('prompt', { text: 'fix add' })).ok, true);
  await wait(
    () =>
      f.controller
        .snapshot()
        .interactions.some((row) => row.status === 'pending'),
    'the command approval',
  );
  // The edit ran without a request; only the command waits.
  assert.equal(
    await readFile(join(f.workspace, 'calc.py'), 'utf8'),
    'def add(a, b):\n    return a + b\n',
  );
  const pending = f.controller
    .snapshot()
    .interactions.filter((row) => row.status === 'pending');
  assert.deepEqual(
    pending.map((row) => row.tool),
    ['execute'],
  );
  const session = activeSession(f);
  assert.equal(session.turn?.verb.length ? true : false, true);
  const tools = session.messages.filter((row) => row.tool);
  assert.deepEqual(
    tools.map((row) => [row.tool!.name, row.tool!.status]),
    [
      ['read_file', 'success'],
      ['edit_file', 'success'],
      ['execute', 'waiting'],
    ],
  );
  const diff = tools[1]!.tool!.diff!;
  assert.equal(diff.summary, '+1 -1');
  assert.ok(
    diff.rows.some(
      (row) => row.tone === 'added' && row.text.includes('return a + b'),
    ),
  );
  assert.ok(
    diff.rows.some(
      (row) => row.tone === 'removed' && row.text.includes('return a - b'),
    ),
  );
  assert.deepEqual(
    session.changes?.map((change) => [
      change.path.endsWith('calc.py'),
      change.kind,
      change.diff.summary,
    ]),
    [[true, 'modified', '+1 -1']],
  );
  const row = pending[0]!;
  assert.equal(
    (
      await f.call(
        'answer',
        { id: row.id, revision: row.revision, answer: 'reject' },
        row.sessionId,
      )
    ).ok,
    true,
  );
  await wait(() => activeSession(f).state === 'idle', 'the turn end');
  assert.equal(existsSync(join(f.workspace, 'ran.txt')), false);
  const done = activeSession(f);
  assert.equal(done.turn, undefined);
  assert.equal(done.meters?.input, 270);
  assert.equal(done.meters?.output, 35);
  // The scripted model has no price: as the terminal says it.
  assert.equal(done.meters?.cost, 'N/A');
  assert.equal(done.meters?.contextInput, 150, 'the last answer, not a sum');
});

test('an approval for a new file carries its diff', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        {
          id: 'write',
          name: 'write_file',
          args: { file_path: 'notes.txt', content: 'one\ntwo\n' },
        },
      ]),
    },
    { message: assistant('done') },
  ]);
  assert.equal(activeSession(f).mode, 'manual');
  assert.equal((await f.call('prompt', { text: 'write notes' })).ok, true);
  await wait(
    () =>
      f.controller
        .snapshot()
        .interactions.some((row) => row.status === 'pending'),
    'the write approval',
  );
  const row = f.controller
    .snapshot()
    .interactions.find((row) => row.status === 'pending')!;
  assert.equal(row.diff?.summary, 'new file, 2 lines');
  assert.deepEqual(
    row.diff?.rows.filter((line) => line.tone === 'added').length,
    2,
  );
  await f.call(
    'answer',
    { id: row.id, revision: row.revision, answer: 'approve' },
    row.sessionId,
  );
  await wait(() => activeSession(f).state === 'idle', 'the turn end');
  assert.equal(
    await readFile(join(f.workspace, 'notes.txt'), 'utf8'),
    'one\ntwo\n',
  );
  assert.deepEqual(
    activeSession(f).changes?.map((change) => change.kind),
    ['added'],
  );
});
