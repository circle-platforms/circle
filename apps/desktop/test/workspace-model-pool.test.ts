import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '../../../src/runtime.js';
import { wrapModelCompletion } from '../../../src/model_wrapper.js';
import { ScriptedModel } from '../../../src/testing.js';
import { ModelCatalog } from '../../../src/model_catalog.js';
import {
  defaultSettings,
  saveSettings,
  saveCredentials,
  trustFolder,
} from '../../../src/settings.js';
import {
  emptyUsage,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from '../../../src/types.js';
import {
  CollaborationResources,
  CollaborationScheduler,
} from '../src/workspace/collaboration.js';
import { createAgentTaskExecutor } from '../src/workspace/task-executor.js';
import { cleanup, scratch } from '../../../tests/helpers.js';
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function message(content: string, tool_calls?: Message['tool_calls']): Message {
  return {
    id: randomUUID(),
    role: 'assistant',
    content,
    ...(tool_calls ? { tool_calls } : {}),
  };
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('model pool fixture did not settle');
}
function poolWrapper(
  resources: CollaborationResources,
  called?: (model: string) => void,
) {
  return (model: import('../../../src/types.js').ChatModel) =>
    wrapModelCompletion(model, (request, invoke) =>
      resources.withResource(
        'agent',
        () => {
          called?.(model.model);
          return invoke(request);
        },
        request.signal,
      ),
    );
}
async function runtime(
  t: Parameters<typeof scratch>[0],
  model: ScriptedModel,
  resources: CollaborationResources,
) {
  const home = scratch(t),
    workspace = scratch(t);
  const result = new AgentRuntime({
    home,
    workspace,
    userHome: home,
    settings: trustFolder(defaultSettings(), workspace),
    model,
    wrapModel: poolWrapper(resources),
    screenshot: false,
    bundledExtensions: false,
    headless: true,
    approve: async () => 'approve',
  });
  cleanup(t, () => result.close());
  return result;
}

test('ordinary parents and a real builtin child share one model slot without a parent-turn deadlock', async (t) => {
  const resources = new CollaborationResources({ agents: 1 });
  const release = gate();
  let active = 0,
    peak = 0;
  const entered: string[] = [];
  const reply =
    (
      name: string,
      content: string,
      calls?: Message['tool_calls'],
      hold = false,
    ) =>
    async (request: ModelRequest): Promise<ModelResponse> => {
      active++;
      peak = Math.max(peak, active);
      entered.push(name);
      try {
        if (hold)
          await Promise.race([
            release.promise,
            new Promise<never>((_resolve, reject) =>
              request.signal.addEventListener(
                'abort',
                () => reject(request.signal.reason),
                { once: true },
              ),
            ),
          ]);
        return { message: message(content, calls), usage: emptyUsage() };
      } finally {
        active--;
      }
    };
  const first = new ScriptedModel([
    reply('parent-a', '', [
      {
        id: 'child',
        name: 'task',
        args: {
          subagent_type: 'explore',
          description: 'read-only child',
        },
      },
    ]),
    reply('child-a', 'child result', undefined, true),
    reply('parent-a-finish', 'done'),
  ]);
  const second = new ScriptedModel([
    reply('parent-b', 'second result', undefined, true),
  ]);
  const a = await runtime(t, first, resources),
    b = await runtime(t, second, resources);
  const firstRun = a.harness.run('delegate'),
    secondRun = b.harness.run('work');
  cleanup(t, () => {
    release.resolve();
  });
  await until(
    () => entered.includes('child-a') || entered.includes('parent-b'),
  );
  assert.equal(active, 1);
  release.resolve();
  assert.equal((await firstRun).answer, 'done');
  assert.equal((await secondRun).answer, 'second result');
  assert.equal(peak, 1);
  assert.equal(first.requests.length, 3);
  assert.equal(second.requests.length, 1);
  assert.ok(
    a.store
      .list(a.options.workspace, true)
      .some((session) => session.parent_id === a.session.id),
  );
});

test('cancelling a queued ordinary parent removes its waiter and never contacts the underlying model', async (t) => {
  const resources = new CollaborationResources({ agents: 1 }),
    release = gate();
  let entered = false;
  const holding = new ScriptedModel([
    async () => {
      entered = true;
      await release.promise;
      return { message: message('holder'), usage: emptyUsage() };
    },
  ]);
  const waiting = new ScriptedModel([{ message: message('must not be sent') }]);
  const a = await runtime(t, holding, resources),
    b = await runtime(t, waiting, resources);
  const holder = a.harness.run('hold');
  cleanup(t, () => {
    release.resolve();
  });
  await until(() => entered);
  const queued = b.harness.run('queued');
  void queued.catch(() => {});
  await until(() => b.harness.busy);
  await delay(10);
  assert.equal(waiting.requests.length, 0);
  await b.cancel();
  await assert.rejects(queued, /Interrupted|abort/i);
  assert.equal(waiting.requests.length, 0);
  release.resolve();
  await holder;
  await delay(10);
  assert.equal(waiting.requests.length, 0);
});

async function gateway(t: Parameters<typeof scratch>[0]) {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const model = String(JSON.parse(body).model);
    requests.push(model);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [
            { index: 0, delta: { content: model }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { requests, base: `http://127.0.0.1:${address.port}/v1` };
}

test('model switches, connection replacement, offline model and new harnesses keep the wrapper', async (t) => {
  const home = scratch(t),
    workspace = scratch(t),
    endpoint = await gateway(t),
    resources = new CollaborationResources({ agents: 1 });
  const settings = trustFolder(defaultSettings(), workspace);
  settings.initialized = true;
  settings.auth.base_url = endpoint.base;
  settings.auth.model = 'initial';
  saveCredentials({ api_key: 'synthetic-model-pool' }, home);
  saveSettings(settings, home);
  const calls: string[] = [];
  const agent = new AgentRuntime({
    home,
    workspace,
    userHome: home,
    settings,
    model: new ScriptedModel([{ message: message('scripted') }]),
    wrapModel: poolWrapper(resources, (model) => calls.push(model)),
    screenshot: false,
    bundledExtensions: false,
    headless: true,
    approve: async () => 'approve',
    catalog: new ModelCatalog(home, { env: { CIRCLE_NO_MODELS_REFRESH: '1' } }),
  });
  cleanup(t, () => agent.close());
  await agent.harness.run('initial');
  agent.setModel('selected');
  assert.equal((await agent.harness.run('selected')).answer, 'selected');
  const refreshed = structuredClone(settings);
  refreshed.auth.model = 'refreshed';
  saveSettings(refreshed, home);
  agent.refreshConnection(refreshed);
  await agent.harness.run('refreshed');
  agent.refreshConnection(defaultSettings());
  await assert.rejects(agent.harness.run('offline'), /connect an API/);
  await agent.newSession();
  await assert.rejects(agent.harness.run('offline again'), /connect an API/);
  assert.deepEqual(calls, [
    'scripted',
    'selected',
    'refreshed',
    'not connected',
    'not connected',
  ]);
  assert.deepEqual(endpoint.requests, ['selected', 'refreshed']);
});

test('integration reload and a custom model child cannot escape completion wrapping', async (t) => {
  const home = scratch(t),
    workspace = scratch(t),
    endpoint = await gateway(t),
    resources = new CollaborationResources({ agents: 1 });
  const settings = trustFolder(defaultSettings(), workspace);
  settings.initialized = true;
  settings.auth.base_url = endpoint.base;
  settings.auth.model = 'main';
  saveSettings(settings, home);
  saveCredentials({ api_key: 'synthetic-model-pool' }, home);
  const extension = join(home, 'extensions', 'custom');
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, 'extension.mjs'),
    `export function register(api){api.registerSubagent({name:'custom',description:'custom fixture',system_prompt:'inspect only',model:'child-special'},['read_file']);}`,
  );
  const calls: string[] = [];
  const model = new ScriptedModel([
    {
      message: message('', [
        {
          id: 'custom',
          name: 'task',
          args: {
            subagent_type: 'custom',
            description: 'inspect',
          },
        },
      ]),
    },
    { message: message('finished') },
    { message: message('after reload') },
  ]);
  const agent = new AgentRuntime({
    home,
    workspace,
    userHome: home,
    settings,
    model,
    wrapModel: poolWrapper(resources, (model) => calls.push(model)),
    screenshot: false,
    bundledExtensions: false,
    headless: false,
    approve: async () => 'approve',
    catalog: new ModelCatalog(home, { env: { CIRCLE_NO_MODELS_REFRESH: '1' } }),
  });
  cleanup(t, () => agent.close());
  assert.equal((await agent.harness.run('custom child')).answer, 'finished');
  await agent.reloadIntegrations();
  assert.equal(
    (await agent.harness.run('after reload')).answer,
    'after reload',
  );
  assert.deepEqual(calls, [
    'scripted',
    'child-special',
    'scripted',
    'scripted',
  ]);
  assert.deepEqual(endpoint.requests, ['child-special']);
});

test(
  'scheduled task already holding the agent lease can use the same model wrapper',
  { timeout: 5000 },
  async (t) => {
    const home = scratch(t),
      workspace = scratch(t),
      data = scratch(t),
      resources = new CollaborationResources({ agents: 1 });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
    git('init', '--initial-branch=main');
    await writeFile(join(workspace, 'source.txt'), 'source');
    git('add', 'source.txt');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Create fixture',
    );
    const model = new ScriptedModel([{ message: message('completed') }]);
    const scheduler = new CollaborationScheduler({
      dataDir: data,
      resources,
      executor: createAgentTaskExecutor({
        createRuntime: async (_task, ctx) =>
          new AgentRuntime({
            home,
            workspace: ctx.worktree,
            userHome: home,
            settings: trustFolder(defaultSettings(), ctx.worktree),
            model,
            wrapModel: poolWrapper(resources),
            headless: true,
            bundledExtensions: false,
            screenshot: false,
          }),
      }),
    });
    cleanup(t, () => scheduler.close());
    await scheduler.enqueue(
      [
        {
          id: 'scheduled',
          workspace,
          access: 'readonly',
          prompt: 'inspect',
          acceptanceCriteria: ['inspect source'],
        },
      ],
      { operationId: 'scheduled' },
    );
    scheduler.start();
    await scheduler.waitForIdle();
    assert.equal(model.requests.length, 1);
    assert.equal(scheduler.get('scheduled')!.state, 'needs_review');
  },
);
