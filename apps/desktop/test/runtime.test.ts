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

test('an extension status and view reach the snapshot, and its links reach the window and the main process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-core-desktop-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, '.circle/extensions/live'), { recursive: true });
  await mkdir(join(workspace, '.git'));
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  await writeFile(
    join(workspace, '.circle/extensions/live/extension.mjs'),
    `export function register(api){api.registerTool('show','show',{type:'object',properties:{}},async()=>{api.setStatus('lab · 1 running','running');api.setView({tasks:['task_1']});await api.openUrl('https://lab.example.test/live');return 'shown'},{readOnly:true})}`,
  );
  const opened: string[] = [];
  const updates: RuntimeUpdate[] = [];
  const model = new ScriptedModel([
    { message: assistant('', [{ id: 'show', name: 'show', args: {} }]) },
    { message: assistant('done') },
  ]);
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: (update) => updates.push(update),
    openUrl: (url) => opened.push(url),
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  await controller.dispatch({
    id: randomUUID(),
    name: 'prompt',
    payload: { text: 'show it' },
    sessionId: controller.snapshot().activeSessionId,
  });
  await wait(() => opened.length > 0, 'link opened');
  assert.deepEqual(opened, ['https://lab.example.test/live']);
  await wait(
    () =>
      updates.some((update) =>
        update.snapshot.extensions.some(
          (item) => item.status?.text === 'lab · 1 running',
        ),
      ),
    'status in a snapshot',
  );
  const row = updates
    .at(-1)!
    .snapshot.extensions.find((item) => item.name === 'live')!;
  assert.deepEqual(row.status, { text: 'lab · 1 running', lamp: 'running' });
  // Its view reaches a paired interface, and the link reaches the window's browser panel.
  assert.deepEqual(row.view, { tasks: ['task_1'] });
  const request = updates.at(-1)!.snapshot.openUrl!;
  assert.equal(request.url, 'https://lab.example.test/live');
  assert.equal(request.sessionId, controller.snapshot().activeSessionId);
  assert.match(request.id, /^[0-9a-f-]{36}$/);
});
