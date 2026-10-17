import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  bindToolResource,
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
    executeTool: resources.executeTool,
    classifyTool: bindToolResource,
    screenshot: false,
    bundledExtensions: false,
    headless: true,
    approve: async () => 'approve',
  });
  cleanup(t, () => result.close());
  return result;
}

test('background nested requests retain their live lease and expired async contexts must queue again', async () => {
  const resources = new CollaborationResources({ agents: 1 });
  const nestedRelease = gate(),
    laterStart = gate(),
    competitorRelease = gate();
  let nested!: Promise<void>,
    later!: Promise<void>,
    nestedEntered = false,
    laterEntered = false,
    competitorEntered = false;
  await resources.withResource('agent', async () => {
    nested = resources.withResource('agent', async () => {
      nestedEntered = true;
      await nestedRelease.promise;
    });
    later = (async () => {
      await laterStart.promise;
      await resources.withResource('agent', async () => {
        laterEntered = true;
      });
    })();
  });
  assert.equal(nestedEntered, true);
  const competitor = resources.withResource('agent', async () => {
    competitorEntered = true;
    await competitorRelease.promise;
  });
  await delay(10);
  assert.equal(
    competitorEntered,
    false,
    'returning a job handle cannot release a live nested request',
  );
  nestedRelease.resolve();
  await nested;
  await until(() => competitorEntered);
  laterStart.resolve();
  await delay(10);
  assert.equal(
    laterEntered,
    false,
    'an expired inherited context cannot bypass a new lease owner',
  );
  competitorRelease.resolve();
  await Promise.all([competitor, later]);
  assert.equal(laterEntered, true);
  assert.equal(resources.pools.agent.active, 0);
});

test('trusted control objects bypass agent waits, browser queues do not hold agents, and cancelled waits never run', async () => {
  const resources = new CollaborationResources({ agents: 1, browsers: 1 });
  const releaseAgent = gate(),
    releaseBrowser = gate();
  const context = { sessionId: 'owner', signal: new AbortController().signal };
  const fake = {
    name: 'native_tasks_wait',
    effect: 'read' as const,
    description: '',
    parameters: {},
    run: async () => '',
  };
  const control = bindToolResource(
    { ...fake, name: 'host coordinator' },
    'control',
  );
  const browser = bindToolResource(
    { ...fake, name: 'host browser' },
    'browser',
  );
  let agentHeld = false,
    browserHeld = false,
    fakeRan = false,
    browserRan = false;
  const agent = resources.withResource('agent', async () => {
    agentHeld = true;
    await releaseAgent.promise;
  });
  await until(() => agentHeld);
  assert.equal(
    await resources.executeTool(
      control,
      {},
      context,
      async () => 'control result',
    ),
    'control result',
  );
  const blocked = resources.executeTool(fake, {}, context, async () => {
    fakeRan = true;
    return '';
  });
  await delay(10);
  assert.equal(fakeRan, false);
  releaseAgent.resolve();
  await Promise.all([agent, blocked]);
  const browserOwner = resources.withResource('browser', async () => {
    browserHeld = true;
    await releaseBrowser.promise;
  });
  await until(() => browserHeld);
  const abort = new AbortController();
  const queued = resources.executeTool(
    browser,
    {},
    { ...context, signal: abort.signal },
    async () => {
      browserRan = true;
      return '';
    },
  );
  await delay(10);
  assert.equal(
    resources.pools.agent.active,
    0,
    'waiting for a browser must not reserve an agent',
  );
  abort.abort();
  await assert.rejects(queued, /cancelled/);
  releaseBrowser.resolve();
  await browserOwner;
  assert.equal(browserRan, false);
  await assert.rejects(
    resources.executeTool(browser, {}, context, async () => '', ['agent']),
    /not granted/,
  );
});

test('a nested trusted approval yields and reacquires its own agent lease without releasing browser ownership', async () => {
  const resources = new CollaborationResources({ agents: 1, browsers: 1 });
  const approval = gate(),
    competitorRelease = gate();
  const signal = new AbortController().signal;
  const tool = bindToolResource(
    {
      name: 'host browser',
      effect: 'read' as const,
      description: '',
      parameters: {},
      run: async () => '',
    },
    'browser',
  );
  let waiting = false,
    resumed = false,
    competitorEntered = false;
  const run = resources.executeTool(
    tool,
    {},
    { sessionId: 'owner', signal },
    async () => {
      await resources.suspendResource(
        'agent',
        async () => {
          waiting = true;
          await approval.promise;
        },
        signal,
      );
      resumed = true;
      return 'resumed';
    },
  );
  await until(() => waiting);
  assert.equal(resources.pools.browser.active, 1);
  const competitor = resources.withResource('agent', async () => {
    competitorEntered = true;
    await competitorRelease.promise;
  });
  await until(() => competitorEntered);
  approval.resolve();
  await delay(10);
  assert.equal(resumed, false);
  competitorRelease.resolve();
  await competitor;
  assert.equal(await run, 'resumed');
  assert.equal(resources.pools.agent.active, 0);
  assert.equal(resources.pools.browser.active, 0);
});

test('host tool scheduling runs after approval and the prepared disk version is checked again after its wait', async (t) => {
  const home = scratch(t),
    workspace = scratch(t),
    approval = gate(),
    scheduling = gate();
  const file = join(workspace, 'actual.txt');
  await writeFile(file, 'original');
  let approved = false,
    hookEntered = false,
    actualRuns = 0;
  const model = new ScriptedModel([
    {
      message: message('', [
        { id: 'edit', name: 'versioned_fixture', args: {} },
      ]),
    },
    { message: message('checked the actual result') },
  ]);
  const app = new AgentRuntime({
    home,
    workspace,
    userHome: home,
    settings: trustFolder(defaultSettings(), workspace),
    model,
    bundledExtensions: false,
    screenshot: false,
    headless: true,
    approve: async () => {
      await approval.promise;
      approved = true;
      return 'approve';
    },
    executeTool: async (_tool, _args, _context, run) => {
      assert.equal(approved, true);
      hookEntered = true;
      await scheduling.promise;
      return run();
    },
    extraTools: [
      {
        name: 'versioned_fixture',
        effect: 'write',
        description: '',
        parameters: { type: 'object', properties: {} },
        prepare: async () => {
          const expected = await readFile(file, 'utf8');
          return async () => {
            actualRuns++;
            if ((await readFile(file, 'utf8')) !== expected)
              throw Error('actual disk version changed');
            await writeFile(file, 'agent');
            return 'saved';
          };
        },
        run: async () => {
          throw Error('prepared action must be used');
        },
      },
    ],
  });
  cleanup(t, () => app.close());
  const run = app.harness.run('edit');
  await delay(10);
  assert.equal(hookEntered, false);
  approval.resolve();
  await until(() => hookEntered);
  await writeFile(file, 'human');
  scheduling.resolve();
  await run;
  assert.equal(actualRuns, 1);
  assert.equal(await readFile(file, 'utf8'), 'human');
  assert.match(
    model.requests[1]!.messages.find((item) => item.tool_call_id === 'edit')!
      .content,
    /actual disk version changed/,
  );
});

test('a real builtin child inherits host execution scheduling and stores its actual read result under its own session', async (t) => {
  const home = scratch(t),
    workspace = scratch(t),
    resources = new CollaborationResources({ agents: 1 });
  await writeFile(join(workspace, 'actual.txt'), 'actual child source');
  const calls: { name: string; owner: string }[] = [];
  const model = new ScriptedModel([
    {
      message: message('', [
        {
          id: 'child',
          name: 'task',
          args: { subagent_type: 'explore', description: 'Read actual.txt' },
        },
      ]),
    },
    {
      message: message('', [
        { id: 'read', name: 'read_file', args: { file_path: 'actual.txt' } },
      ]),
    },
    { message: message('read child source') },
    { message: message('complete') },
  ]);
  const app = new AgentRuntime({
    home,
    workspace,
    userHome: home,
    settings: trustFolder(defaultSettings(), workspace),
    model,
    wrapModel: poolWrapper(resources),
    executeTool: (tool, args, context, run) => {
      calls.push({ name: tool.name, owner: context.sessionId });
      return resources.executeTool(tool, args, context, run);
    },
    classifyTool: bindToolResource,
    bundledExtensions: false,
    screenshot: false,
    headless: true,
    approve: async () => 'approve',
  });
  cleanup(t, () => app.close());
  await app.harness.run('delegate a read');
  const child = app.store
    .list(workspace, true)
    .find((row) => row.parent_id === app.session.id)!;
  assert.ok(child);
  assert.ok(
    calls.some((call) => call.name === 'read_file' && call.owner === child.id),
  );
  assert.match(
    app.store.messages(child.id).find((item) => item.tool_call_id === 'read')!
      .content,
    /actual child source/,
  );
  assert.equal(resources.pools.agent.active, 0);
});

test('two actual builtin children use independent agent leases while their coordinating parent waits', async (t) => {
  const resources = new CollaborationResources({ agents: 1 }),
    release = gate();
  let active = 0,
    peak = 0,
    entered = 0;
  const childReply = async (): Promise<ModelResponse> => {
    active++;
    entered++;
    peak = Math.max(peak, active);
    try {
      await release.promise;
      return { message: message('child complete'), usage: emptyUsage() };
    } finally {
      active--;
    }
  };
  const model = new ScriptedModel([
    {
      message: message(
        '',
        ['a', 'b'].map((id) => ({
          id,
          name: 'task',
          args: {
            subagent_type: 'explore',
            description: `Inspect child ${id}`,
          },
        })),
      ),
    },
    childReply,
    childReply,
    { message: message('parent complete') },
  ]);
  const app = await runtime(t, model, resources);
  cleanup(t, () => release.resolve());
  const running = app.harness.run('delegate two independent children');
  await until(() => entered === 1);
  await delay(10);
  assert.equal(peak, 1);
  assert.equal(entered, 1);
  release.resolve();
  await running;
  assert.equal(entered, 2);
  assert.equal(peak, 1);
  assert.equal(
    app.store
      .list(app.options.workspace, true)
      .filter((row) => row.parent_id === app.session.id).length,
    2,
  );
  assert.equal(model.requests.length, 4);
});

test('cancelled or rejected nested approvals do not reacquire or double-release an agent lease', async () => {
  for (const cancelled of [false, true]) {
    const resources = new CollaborationResources({ agents: 1 }),
      wait = gate(),
      competitor = gate();
    const abort = new AbortController();
    let entered = false,
      invoked = false;
    const run = resources.withResource('agent', async () => {
      await resources.suspendResource(
        'agent',
        async () => {
          entered = true;
          await wait.promise;
          if (!cancelled) throw Error('rejected');
        },
        abort.signal,
      );
      invoked = true;
    });
    const rejected = assert.rejects(run, cancelled ? /abort/i : /rejected/);
    await until(() => entered);
    let otherEntered = false;
    const other = resources.withResource('agent', async () => {
      otherEntered = true;
      await competitor.promise;
    });
    await until(() => otherEntered);
    if (cancelled) abort.abort();
    wait.resolve();
    await rejected;
    assert.equal(invoked, false);
    assert.equal(resources.pools.agent.active, 1);
    competitor.resolve();
    await other;
    assert.equal(resources.pools.agent.active, 0);
  }
});

test('fresh native runtime admission releases its agent before approval and a second task can complete with one slot', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t),
    resources = new CollaborationResources({ agents: 1 }),
    approval = gate();
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
    '-qm',
    'Baseline',
  );
  let pending = false,
    secondCalls = 0;
  const scheduler = new CollaborationScheduler({
    dataDir,
    resources,
    executor: createAgentTaskExecutor({
      createRuntime: async (task, ctx) => {
        const home = join(dataDir, task.spec.id);
        await mkdir(home);
        const model =
          task.spec.id === 'first'
            ? new ScriptedModel([
                {
                  message: message('', [
                    {
                      id: 'write',
                      name: 'write_file',
                      args: { file_path: 'actual.txt', content: 'actual' },
                    },
                  ]),
                },
                { message: message('written') },
              ])
            : new ScriptedModel([
                async () => {
                  secondCalls++;
                  return {
                    message: message('independent result'),
                    usage: emptyUsage(),
                  };
                },
              ]);
        return new AgentRuntime({
          home,
          workspace: ctx.worktree,
          userHome: home,
          settings: trustFolder(defaultSettings(), ctx.worktree),
          model,
          wrapModel: poolWrapper(resources),
          executeTool: resources.executeTool,
          classifyTool: bindToolResource,
          bundledExtensions: false,
          screenshot: false,
          headless: true,
          approve: async () => {
            pending = true;
            await approval.promise;
            return 'approve';
          },
        });
      },
      verify: async (task, ctx) => {
        if (task.spec.id === 'first')
          assert.equal(
            await readFile(join(ctx.worktree, 'actual.txt'), 'utf8'),
            'actual',
          );
        return [
          {
            criterion: 'checked',
            status: 'passed',
            source: 'inspection',
            evidence: 'Independent actual output check',
          },
        ];
      },
    }),
  });
  cleanup(t, async () => {
    approval.resolve();
    await scheduler.close();
  });
  await scheduler.enqueue(
    ['first', 'second'].map((id) => ({
      id,
      sessionId: 'owner',
      workspace,
      prompt: `Inspect ${id}`,
      access: 'write' as const,
      acceptanceCriteria: ['checked'],
    })),
    { operationId: 'two' },
  );
  scheduler.start();
  await until(() => pending && secondCalls === 1);
  assert.equal(scheduler.get('first')!.state, 'waiting');
  assert.equal(secondCalls, 1);
  approval.resolve();
  await scheduler.waitForIdle();
  assert.ok(scheduler.list().every((task) => task.state === 'succeeded'));
  assert.equal(resources.pools.agent.active, 0);
});

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
