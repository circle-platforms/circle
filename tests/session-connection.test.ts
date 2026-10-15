import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { AgentRuntime } from '../src/runtime.js';
import { TITLE_MAX_TOKENS } from '../src/session_title.js';
import { SessionRuntimeManager } from '../src/session_manager.js';
import { ScriptedModel } from '../src/testing.js';
import {
  defaultSettings,
  saveCredentials,
  clearCredentials,
  loadSettings,
  saveSettings,
} from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

async function gateway(
  t: Parameters<typeof scratch>[0],
  name: string,
  hold?: () => Promise<void>,
) {
  const requests: { model: string; authorization?: string; title?: true }[] =
    [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as { model: string; max_tokens?: number };
    requests.push({
      model: parsed.model,
      authorization: request.headers.authorization,
      ...(parsed.max_tokens === TITLE_MAX_TOKENS ? { title: true } : {}),
    });
    await hold?.();
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [
            { index: 0, delta: { content: name }, finish_reason: 'stop' },
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

test('refreshing a connection replaces every local session SDK; logout cannot reuse any cached client', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const old = await gateway(t, 'old'),
    next = await gateway(t, 'next');
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = old.base;
  settings.auth.model = 'old-model';
  saveCredentials({ api_key: 'synthetic-old' }, home);
  const sessions = new SessionRuntimeManager(
    (workspace, session) =>
      new AgentRuntime({
        workspace,
        home,
        session,
        settings: structuredClone(settings),
        model: new ScriptedModel(),
        headless: true,
        modelOverride: 'one-run-model',
      }),
  );
  cleanup(t, () => sessions.close());
  const a = sessions.create(workspace),
    b = sessions.create(workspace);
  a.setModel('old-model');
  b.setModel('old-model');
  await a.harness.run('A before login');
  await b.harness.run('B before login');
  const changed = structuredClone(settings);
  changed.auth.base_url = next.base;
  changed.auth.model = 'new-model';
  saveCredentials({ api_key: 'synthetic-next' }, home);
  for (const runtime of sessions.values()) runtime.refreshConnection(changed);
  await a.harness.run('A after login');
  await b.harness.run('B after login');
  // The sentences ask for a title. Those calls use the same connection and
  // are not the user turns this test is counting.
  const turns = (rows: { title?: true }[]) => rows.filter((row) => !row.title);
  assert.deepEqual(turns(old.requests), [
    { model: 'old-model', authorization: 'Bearer synthetic-old' },
    { model: 'old-model', authorization: 'Bearer synthetic-old' },
  ]);
  assert.deepEqual(turns(next.requests), [
    { model: 'new-model', authorization: 'Bearer synthetic-next' },
    { model: 'new-model', authorization: 'Bearer synthetic-next' },
  ]);
  for (const runtime of sessions.values()) {
    assert.equal(runtime.options.model, undefined);
    assert.equal(runtime.options.modelOverride, undefined);
  }
  clearCredentials(home);
  const disconnected = defaultSettings();
  for (const runtime of sessions.values())
    runtime.refreshConnection(disconnected);
  await assert.rejects(a.harness.run('A after logout'), /connect an API/);
  await assert.rejects(b.harness.run('B after logout'), /connect an API/);
  // Legacy core session transitions must also use the disconnected model.
  await a.newSession();
  await assert.rejects(
    a.harness.run('new session after logout'),
    /connect an API/,
  );
  assert.equal(turns(old.requests).length, 2);
  assert.equal(turns(next.requests).length, 2);
});

test('connection refresh refuses an active turn without replacing its current settings or model', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const model = new ScriptedModel([
    async (request) => {
      ready();
      await new Promise((_, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
      throw new Error('unreachable');
    },
  ]);
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const previous = runtime.options.settings;
  const running = runtime.harness.run('held').catch(() => {});
  await entered;
  assert.throws(
    () => runtime.refreshConnection(defaultSettings()),
    /a turn is running/,
  );
  assert.equal(runtime.options.settings, previous);
  assert.equal(runtime.options.model, model);
  await runtime.cancel();
  await running;
});

test('another process changing login or logout cannot send new credentials to a cached old endpoint', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const old = await gateway(t, 'old'),
    next = await gateway(t, 'next');
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = old.base;
  settings.auth.model = 'old-model';
  saveSettings(settings, home);
  saveCredentials({ api_key: 'synthetic-old' }, home);
  const a = new AgentRuntime({
    workspace,
    home,
    settings: structuredClone(settings),
    model: new ScriptedModel(),
    headless: true,
  });
  const b = new AgentRuntime({
    workspace,
    home,
    settings: structuredClone(settings),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => a.close());
  cleanup(t, () => b.close());
  a.setModel('old-model');
  b.setModel('old-model');
  await a.harness.run('A old');
  await b.harness.run('B old');
  const external = async (logout: boolean) => {
    const source = new URL('../src/settings.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
      import { saveSettingsChange,saveCredentials,clearCredentials } from ${JSON.stringify(source)};
      if (${logout}) clearCredentials(process.env.CIRCLE_HOME);
      else { saveCredentials({api_key:'synthetic-next'},process.env.CIRCLE_HOME);
        saveSettingsChange(process.env.CIRCLE_HOME,saved=>{saved.auth.base_url=${JSON.stringify(next.base)};saved.auth.model='new-model';}); }
    `,
      ],
      { env: { ...process.env, CIRCLE_HOME: home }, stdio: 'pipe' },
    );
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  };
  await external(false);
  assert.throws(
    () =>
      new AgentRuntime({
        workspace,
        home,
        settings: structuredClone(settings),
        headless: true,
      }),
    /saved connection changed/,
  );
  assert.throws(
    () => a.setModel('must-not-leak-new-key'),
    /saved connection changed/,
  );
  await assert.rejects(
    a.harness.run('A needs reconnect'),
    /saved connection changed/,
  );
  await assert.rejects(
    b.harness.run('B needs reconnect'),
    /saved connection changed/,
  );
  await assert.rejects(b.compact(), /saved connection changed/);
  assert.equal(old.requests.length, 2);
  assert.equal(next.requests.length, 0);
  for (const runtime of [a, b]) runtime.refreshConnection(loadSettings(home));
  await a.harness.run('A new');
  await b.harness.run('B new');
  assert.deepEqual(next.requests, [
    { model: 'new-model', authorization: 'Bearer synthetic-next' },
    { model: 'new-model', authorization: 'Bearer synthetic-next' },
  ]);
  await external(true);
  await assert.rejects(
    a.harness.run('A after external logout'),
    /saved connection changed/,
  );
  await assert.rejects(
    b.harness.run('B after external logout'),
    /saved connection changed/,
  );
  assert.equal(old.requests.length, 2);
  assert.equal(next.requests.length, 2);
});

test('external logout lets the in-flight cached request finish but blocks and preserves its queued follow-up', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const old = await gateway(t, 'in-flight answer', async () => {
    ready();
    await finish;
  });
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = old.base;
  settings.auth.model = 'old-model';
  saveSettings(settings, home);
  saveCredentials({ api_key: 'synthetic-old' }, home);
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings,
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.setModel('old-model');
  const running = runtime.harness.run('first turn');
  await entered;
  runtime.harness.queue('queued second turn', 'followUp');
  clearCredentials(home);
  release();
  await assert.rejects(running, /saved connection changed/);
  assert.equal(old.requests.length, 1);
  assert.equal(runtime.harness.pendingMessageCount, 1);
  assert.equal(
    runtime.store.messages(runtime.session.id).at(-1)?.content,
    'in-flight answer',
  );
  assert.equal(
    runtime.store
      .messages(runtime.session.id)
      .some((message) => message.content === 'queued second turn'),
    false,
  );
});
