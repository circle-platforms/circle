import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { ModelCatalog } from '../src/model_catalog.js';
import { AgentRuntime } from '../src/runtime.js';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import {
  defaultSettings,
  loadCredentials,
  saveCredentials,
  saveSettings,
} from '../src/settings.js';
import {
  emptyUsage,
  type ModelRequest,
  type ModelResponse,
} from '../src/types.js';
import { cancellationFixture, cleanup, scratch } from './helpers.js';

const answer = (content: string): ModelResponse => ({
  message: { id: crypto.randomUUID(), role: 'assistant', content },
  usage: emptyUsage(),
});
function held(text: string) {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    reply: async (request: ModelRequest) => {
      request.token(text);
      await Promise.race([
        wait,
        new Promise<never>((_, reject) =>
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          ),
        ),
      ]);
      request.signal.throwIfAborted();
      return answer(text);
    },
  };
}
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out');
    await delay(5);
  }
}
async function appFor(
  t: Parameters<typeof scratch>[0],
  replies: ConstructorParameters<typeof ScriptedModel>[0],
) {
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = defaultSettings();
  const model = new ScriptedModel(replies);
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  app.terminal = {
    platform: process.platform,
    write: () => {},
    input: () => {},
    kill: () => {},
  };
  await app.attach({ workspace, home, settings, model, headless: true });
  cleanup(t, () => app.close());
  const key = (key: string, char = '') => ui.handle({ type: 'key', key, char });
  const choose = async (id: string) => {
    const picker = app.state.picker!;
    picker.focus = picker.matches().findIndex((item) => item.key === id);
    assert(picker.focus >= 0);
    key('enter');
    await until(() => app.runtime?.session.id === id);
  };
  return { app, ui, home, workspace, model, key, choose };
}

test('TUI new/resume/continue move the view while both session requests remain in flight', async (t) => {
  const aReply = held('answer A');
  const bReply = held('answer B');
  const { app, ui, model } = await appFor(t, [aReply.reply, bReply.reply]);
  const a = app.runtime!;
  const turnA = app.submit('prompt A');
  await until(() => model.requests.length === 1);
  ui.composer.paste('A draft\n'.repeat(25));
  const draftA = app.state.draft;
  app.state.scroll = 7;
  app.state.showTools = true;
  await app.command('new', '');
  const b = app.runtime!;
  assert.notEqual(a, b);
  assert(a.busy);
  assert.equal(app.state.draft, '');
  const turnB = app.submit('prompt B');
  await until(() => model.requests.length === 2);
  assert(a.busy && b.busy, 'both model requests are in flight');
  assert.equal(app.state.streaming, 'answer B');
  ui.composer.paste('draft B');
  await app.command('resume', a.session.id);
  assert.equal(app.runtime, a);
  assert.equal(app.state.draft, draftA);
  assert.equal(ui.composer.modelText(draftA), 'A draft\n'.repeat(25));
  assert.equal(app.state.scroll, 7);
  assert.equal(app.state.showTools, true);
  assert.equal(app.state.streaming, 'answer A');
  aReply.release();
  await turnA;
  assert(b.busy);
  await app.command('continue', '');
  assert.equal(app.runtime, b);
  assert.equal(app.state.draft, 'draft B');
  bReply.release();
  await turnB;
  assert.deepEqual(
    model.requests.map((request) =>
      request.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ),
    [['prompt A'], ['prompt B']],
  );
  assert.deepEqual(
    a.store.messages(a.session.id).map((message) => message.content),
    ['prompt A', 'answer A'],
  );
  assert.deepEqual(
    b.store.messages(b.session.id).map((message) => message.content),
    ['prompt B', 'answer B'],
  );
});

test('TUI alt+s parks a live approval, runs another conversation, and restores only the source approval', async (t) => {
  const { app, ui, workspace, model, key, choose } = await appFor(t, [
    answer('earlier B'),
    {
      message: {
        id: 'write-request',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'approval-A',
            name: 'write_file',
            args: { file_path: 'approved.txt', content: 'A approved bytes' },
          },
        ],
      },
    },
    answer('B continues'),
    answer('A complete'),
  ]);
  const b = app.runtime!;
  await app.submit('B first');
  await app.command('new', '');
  const a = app.runtime!;
  const turnA = app.submit('A writes');
  await until(() => Boolean(app.state.dialog));
  const approval = app.state.dialog;
  key('alt+s');
  await until(() => Boolean(app.state.picker));
  assert.equal(app.state.dialog, undefined);
  ui.handle({ type: 'paste', text: 'earlier B' });
  assert.equal(app.state.picker!.query, 'earlier B');
  assert.equal(
    app.state.dialog,
    undefined,
    'paste searches the list without resurrecting its parked card',
  );
  key('escape');
  assert.equal(app.state.picker!.query, '');
  key('escape');
  await until(() => !app.state.picker);
  assert.equal(
    app.state.dialog,
    approval,
    'escape restores the unanswered card',
  );
  key('alt+s');
  await until(() => Boolean(app.state.picker));
  await choose(b.session.id);
  assert.equal(app.state.dialog, undefined);
  assert(a.busy);
  assert.equal(existsSync(join(workspace, 'approved.txt')), false);
  await app.submit('B second');
  assert.equal(app.state.dialog, undefined);
  assert(
    app.state.otherSessions?.some(
      (session) => session.id === a.session.id && session.waiting,
    ),
  );
  key('alt+s');
  await until(() => Boolean(app.state.picker));
  await choose(a.session.id);
  assert.equal(app.state.dialog, approval);
  key('enter');
  await turnA;
  assert.equal(
    readFileSync(join(workspace, 'approved.txt'), 'utf8'),
    'A approved bytes',
  );
  assert(
    !b.harness.messages.some(
      (message) => message.tool_call_id === 'approval-A',
    ),
  );
  assert.equal(
    model.requests
      .at(-1)!
      .messages.find((message) => message.tool_call_id === 'approval-A')
      ?.status,
    'success',
  );
});

test('TUI confirmed deletion stops only the selected owner and selects the latest saved session', async (t) => {
  const running = held('still running');
  const { app, ui, model, key } = await appFor(t, [
    answer('old'),
    running.reply,
  ]);
  const previous = app.runtime!;
  await app.submit('previous');
  await app.command('new', '');
  const deleted = app.runtime!;
  const deletedId = deleted.session.id;
  const turn = app.submit('running session');
  await until(() => model.requests.length === 2);
  await app.command('resume', '');
  const picker = app.state.picker!;
  picker.focus = picker.matches().findIndex((item) => item.key === deletedId);
  key('ctrl+d');
  await until(() => Boolean(app.state.picker?.asking));
  assert(deleted.busy, 'asking does not stop the session');
  key('enter');
  await until(() => app.runtime === previous);
  await turn;
  assert.equal(previous.store.get(deletedId), undefined);
  assert.equal(ui.sessions.lifecycle(deletedId), 'deleted');
  assert.equal(deleted.busy, false);
  assert(!previous.isClosing);
  await assert.rejects(ui.changeSession(deletedId), /delet/);
});

test('TUI background approval arrivals never take focus and deletion cancels their actual tool effect', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bReply = held('B still working');
  const { app, ui, workspace, model } = await appFor(t, [
    async () => {
      await gate;
      return {
        message: {
          id: 'pending-background',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'late-write',
              name: 'write_file',
              args: { file_path: 'never.txt', content: 'should not exist' },
            },
          ],
        },
        usage: emptyUsage(),
      };
    },
    bReply.reply,
  ]);
  const a = app.runtime!;
  const turnA = app.submit('A waits');
  await until(() => model.requests.length === 1);
  await app.command('new', '');
  const b = app.runtime!;
  const turnB = app.submit('B works');
  await until(() => model.requests.length === 2);
  release();
  await until(() => ui.views.get(a).interactions.pendingCount === 1);
  ui.repaint();
  assert.equal(app.runtime, b);
  assert.equal(app.state.dialog, undefined);
  assert(
    app.state.otherSessions?.some(
      (session) => session.id === a.session.id && session.waiting,
    ),
  );
  await ui.deleteSession(a.session.id);
  await turnA;
  assert.equal(app.runtime, b);
  assert(b.busy);
  assert.equal(b.store.get(a.session.id), undefined);
  assert.equal(existsSync(join(workspace, 'never.txt')), false);
  bReply.release();
  await turnB;
  assert.equal(
    b.store.get(a.session.id),
    undefined,
    'late cleanup never resurrects history',
  );
});

test('TUI deleting a background session reaps its real descendant without stopping the selected model', async (t) => {
  const bReply = held('B running');
  const { app, ui, workspace, model } = await appFor(t, [bReply.reply]);
  const a = app.runtime!;
  const fixture = await cancellationFixture(t, workspace);
  const job = a.jobs.startShell(fixture.command, {
    sessionId: a.session.id,
    startedBy: 'user',
  });
  await fixture.ready();
  await app.command('new', '');
  const b = app.runtime!;
  const turnB = app.submit('B remains alive');
  await until(() => model.requests.length === 1);
  await ui.deleteSession(a.session.id);
  assert.equal(
    await fixture.release(),
    'closed',
    'the owned descendant exits before deletion resolves',
  );
  assert.equal(a.jobs.get(job.id)?.status, 'stopped');
  assert.equal(b.store.get(a.session.id), undefined);
  assert.equal(existsSync(join(workspace, 'late')), false);
  assert.equal(app.runtime, b);
  assert(b.busy);
  bReply.release();
  await turnB;
});

test('TUI delayed model discovery and cycling stay attached to the requesting conversation', async (t) => {
  let release!: () => void;
  let requested = false;
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (_request, response) => {
    requested = true;
    await gate;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ data: [{ id: 'scripted' }, { id: 'other' }] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const { app, ui, home } = await appFor(t, []);
  app.settings.auth.base_url = `http://127.0.0.1:${address.port}/v1`;
  app.settings.auth.model = 'scripted';
  app.runtime!.options.settings.auth = structuredClone(app.settings.auth);
  saveCredentials({ api_key: 'synthetic-local-only' }, home);
  const a = app.runtime!;
  const models = app.command('models', '');
  await until(() => requested);
  await app.command('new', '');
  const b = app.runtime!;
  release();
  await models;
  assert.equal(app.runtime, b);
  assert.equal(app.state.picker, undefined, 'late picker does not appear on B');
  await ui.changeSession(a.session.id);
  assert.equal(ui.views.get(a).state.picker?.title, 'Model');
  app.state.picker = undefined;
  // A second delayed lookup for cycling must change only A after another switch to B.
  requested = false;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  ui.knownModels = undefined;
  const cycle = ui.cycleModel();
  await until(() => requested);
  await ui.changeSession(b.session.id);
  release();
  await cycle;
  assert.equal(a.harness.model.model, 'other');
  assert.equal(b.harness.model.model, 'scripted');
});

test('TUI deletion completion preserves a newer user selection during slow cleanup', async (t) => {
  const { app, ui } = await appFor(t, []);
  const a = app.runtime!;
  await app.command('new', '');
  const b = app.runtime!;
  await app.command('new', '');
  await ui.changeSession(a.session.id);
  const close = a.jobs.close.bind(a.jobs);
  let release!: () => void;
  let cleaning = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  a.jobs.close = async () => {
    cleaning = true;
    await gate;
    return close();
  };
  const deletion = ui.deleteSession(a.session.id);
  await until(() => cleaning);
  await ui.changeSession(b.session.id);
  release();
  await deletion;
  assert.equal(app.runtime, b);
  assert.equal(b.store.get(a.session.id), undefined);
});

test('TUI deletion skips a most-recent session owned by another terminal', async (t) => {
  const { app, ui, home, workspace } = await appFor(t, []);
  const a = app.runtime!;
  const foreign = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => foreign.close());
  await ui.deleteSession(a.session.id);
  assert.notEqual(app.runtime!.session.id, a.session.id);
  assert.notEqual(app.runtime!.session.id, foreign.session.id);
  assert.equal(foreign.isClosing, false);
});

test('TUI preserves a background error and its undo history when switching views', async (t) => {
  let fail!: () => void;
  const gate = new Promise<void>((resolve) => {
    fail = resolve;
  });
  const { app, ui, model } = await appFor(t, [
    async () => {
      await gate;
      throw new Error('source-only failure');
    },
  ]);
  const a = app.runtime!;
  const turn = app.submit('A fails later');
  await until(() => model.requests.length === 1);
  await app.command('new', '');
  const b = app.runtime!;
  fail();
  await turn;
  assert.equal(app.runtime, b);
  assert(
    !app.state.notices.some((notice) => notice.includes('source-only failure')),
  );
  await ui.changeSession(a.session.id);
  assert(
    app.state.notices.some((notice) => notice.includes('source-only failure')),
  );
  const notices = [...app.state.notices];
  await ui.changeSession(b.session.id);
  await ui.changeSession(a.session.id);
  assert.deepEqual(app.state.notices, notices);
  await app.command('undo', '');
  assert.equal(app.state.messages.length, 0);
});

async function localGateway(t: Parameters<typeof scratch>[0], name: string) {
  const requests: { model: string; key: string }[] = [];
  let modelsRelease: (() => void) | undefined;
  let holdModels = false;
  let modelRequested = false;
  let holdReply = false;
  let heldResponse: ServerResponse | undefined;
  const finish = (response: ServerResponse) =>
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { content: name + ' answer' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      modelRequested = true;
      if (holdModels)
        await new Promise<void>((resolve) => {
          modelsRelease = resolve;
        });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: name + '-model' }] }));
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({
      model: JSON.parse(body).model,
      key: String(request.headers.authorization),
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (holdReply) {
      heldResponse = response;
      response.write(
        'data: ' +
          JSON.stringify({
            choices: [
              { index: 0, delta: { content: 'held' }, finish_reason: null },
            ],
          }) +
          '\n\n',
      );
    } else finish(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => {
    modelsRelease?.();
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    base: `http://127.0.0.1:${address.port}/v1`,
    requests,
    holdModels() {
      holdModels = true;
    },
    modelsRequested: () => modelRequested,
    releaseModels: () => {
      modelsRelease?.();
    },
    holdReply() {
      holdReply = true;
    },
    releaseReply: () => {
      if (heldResponse) finish(heldResponse);
    },
  };
}
async function connectedApp(t: Parameters<typeof scratch>[0], base: string) {
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = base;
  settings.auth.model = 'old-model';
  settings.update_check = false;
  saveSettings(settings, home);
  saveCredentials({ api_key: 'old-key' }, home);
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  app.terminal = {
    platform: process.platform,
    write: () => {},
    input: () => {},
    kill: () => {},
  };
  await app.attach({
    home,
    workspace,
    settings,
    headless: true,
    catalog: new ModelCatalog(home, { env: { CIRCLE_NO_MODELS_REFRESH: '1' } }),
  });
  cleanup(t, () => app.close());
  const key = (key: string) => ui.handle({ type: 'key', key, char: '' });
  const loginUntilModels = async (target: string) => {
    await app.command('login', '');
    key('enter');
    await until(() => Boolean(app.state.picker?.asking));
    key('ctrl+u');
    ui.handle({ type: 'paste', text: target });
    key('enter');
    await until(() => Boolean(app.state.picker?.asking));
    ui.handle({ type: 'paste', text: 'new-key' });
    key('enter');
  };
  return { app, ui, home, key, loginUntilModels };
}

test('TUI sign in updates every idle runtime and sign out prevents cached SDK reuse including newly created sessions', async (t) => {
  const old = await localGateway(t, 'old');
  const next = await localGateway(t, 'new');
  const { app, ui, key, loginUntilModels } = await connectedApp(t, old.base);
  const a = app.runtime!;
  await app.submit('before change');
  await app.command('new', '');
  const b = app.runtime!;
  await ui.changeSession(a.session.id);
  await loginUntilModels(next.base);
  await until(() =>
    Boolean(app.state.picker?.items.some((item) => item.key === 'new-model')),
  );
  key('enter');
  await until(
    () =>
      a.options.settings.auth.model === 'new-model' &&
      b.options.settings.auth.model === 'new-model',
  );
  await app.submit('A new connection');
  await ui.changeSession(b.session.id);
  await app.submit('B new connection');
  assert.deepEqual(old.requests, [
    { model: 'old-model', key: 'Bearer old-key' },
  ]);
  assert.deepEqual(next.requests, [
    { model: 'new-model', key: 'Bearer new-key' },
    { model: 'new-model', key: 'Bearer new-key' },
  ]);
  await app.command('logout', '');
  await app.submit('must not reach the saved SDK');
  await ui.changeSession(a.session.id);
  await app.submit('A must also be disconnected');
  await app.command('new', '');
  await app.submit('new disconnected session');
  assert.equal(old.requests.length, 1);
  assert.equal(next.requests.length, 2);
  assert.equal(app.runtime!.harness.model.model, 'not connected');
});

test('TUI sign in completion rechecks other running conversations before replacing credentials', async (t) => {
  const old = await localGateway(t, 'old');
  const next = await localGateway(t, 'new');
  next.holdModels();
  old.holdReply();
  const { app, ui, home, key, loginUntilModels } = await connectedApp(
    t,
    old.base,
  );
  const a = app.runtime!;
  await loginUntilModels(next.base);
  await until(() => next.modelsRequested());
  await app.command('new', '');
  const b = app.runtime!;
  const turn = app.submit('B in progress');
  await until(() => old.requests.length === 1);
  next.releaseModels();
  await until(() =>
    Boolean(
      ui.views
        .get(a)
        .state.picker?.items.some(
          (item: { key: string }) => item.key === 'new-model',
        ),
    ),
  );
  await ui.changeSession(a.session.id);
  key('enter');
  await until(() =>
    app.state.notices.some((notice) =>
      notice.includes('wait for all sessions'),
    ),
  );
  assert.equal(app.settings.auth.base_url, old.base);
  assert.equal(loadCredentials(home).api_key, 'old-key');
  assert(b.busy);
  old.releaseReply();
  await turn;
});

test('TUI failed pre-delete cleanup retains the selected history and supports a confirmed retry', async (t) => {
  const { app, ui, key } = await appFor(t, [answer('keep history')]);
  const runtime = app.runtime!;
  const id = runtime.session.id;
  await app.submit('must survive failed cleanup');
  await app.command('new', '');
  const other = app.runtime!;
  await ui.changeSession(id);
  let painted = 0;
  ui.screen.render = () => {
    painted++;
  };
  const cleanup = runtime.options.beforeDelete;
  runtime.options.beforeDelete = async () => {
    throw new Error('browser cleanup failed');
  };
  await app.command('resume', '');
  key('ctrl+d');
  await until(() => Boolean(app.state.picker?.asking));
  const beforeFailure = painted;
  key('enter');
  await until(() =>
    app.state.notices.some((notice) =>
      notice.includes('browser cleanup failed'),
    ),
  );
  assert.equal(app.runtime, runtime);
  assert(
    painted > beforeFailure,
    'the retained deleting view draws its cleanup failure',
  );
  assert(runtime.store.get(id));
  assert.equal(ui.sessions.lifecycle(id), 'deleting');
  const before = runtime.store.messages(id).length;
  await app.submit('blocked while deleting');
  assert.equal(runtime.store.messages(id).length, before);
  // A retained deleting view must still let the user choose another conversation.
  await app.command('resume', '');
  const picker = app.state.picker!;
  picker.focus = picker
    .matches()
    .findIndex((item) => item.key === other.session.id);
  key('enter');
  await until(() => app.runtime === other);
  assert(other.store.get(id));
  runtime.options.beforeDelete = cleanup;
  await app.command('resume', '');
  app.state.picker!.focus = app.state
    .picker!.matches()
    .findIndex((item) => item.key === id);
  key('ctrl+d');
  await until(() => Boolean(app.state.picker?.asking));
  key('enter');
  await until(() => other.store.get(id) === undefined);
  assert.equal(app.runtime, other);
});
