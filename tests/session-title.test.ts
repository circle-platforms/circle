import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { ExtensionHost } from '../src/extensions.js';
import { Harness } from '../src/harness.js';
import { AgentRuntime } from '../src/runtime.js';
import {
  fallbackTitle,
  isNumberFragment,
  sanitizeGeneratedTitle,
} from '../src/session_title.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { SessionApp } from '../src/tui/session_app.js';
import type { ChatModel, ModelRequest, ModelResponse } from '../src/types.js';
import { emptyUsage } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

test('fallback titles stay short and drop a leading please', () => {
  assert.equal(fallbackTitle('hello'), 'hello');
  assert.equal(fallbackTitle('please fix the login bug'), 'fix the login bug');
  assert.equal(fallbackTitle('请帮我看一下'), '帮我看一下');
  assert.equal(fallbackTitle('请'), '请');
  assert.equal(fallbackTitle('@README.md what is this'), 'what is this');
  assert.equal(
    fallbackTitle('@README.md what is the first heading'),
    'what is the first heading',
  );
  assert.equal(
    fallbackTitle(
      '@README.md what is the first heading in this file and why it is there',
    ),
    'what is the first heading in this',
  );
  assert.equal(
    fallbackTitle(
      'I need you to write me a poem about the sea tonight please now',
    ),
    'write me a poem about the sea',
  );
  assert.equal(
    fallbackTitle(
      'please explain to me briefly in two sentences how this works today',
    ).startsWith('please'),
    false,
  );
  assert.equal(
    fallbackTitle(
      'Fix the login bug in auth. Then write a long postmortem for the on-call notes.',
    ),
    'Fix the login bug in auth',
  );
  const words = fallbackTitle(
    'investigate flaky checkout retries across regions without a clear sentence end here please',
  );
  assert.ok(words.length <= 42, words);
  assert.match(words, /^investigate flaky/);
  const cjk = fallbackTitle(
    '帮我把桌面端会话标题改成一句短摘要不要把用户的整段第一句话原样放进侧边栏里面否则看起来像一整段提示词',
  );
  assert.equal(
    cjk,
    '把桌面端会话标题改成一句短摘要不要把用户的整段第一'.slice(0, 22),
  );
  assert.equal([...cjk].length, 22);
});

test('generated titles keep one line and drop a refusal', () => {
  assert.equal(sanitizeGeneratedTitle('  "Login bug"\nextra'), 'Login bug');
  assert.equal(sanitizeGeneratedTitle('会话标题。'), '会话标题');
  assert.equal(sanitizeGeneratedTitle('Sorry, I cannot do that'), undefined);
  assert.equal(sanitizeGeneratedTitle('150'), undefined);
  assert.equal(sanitizeGeneratedTitle('1500.'), undefined);
  assert.equal(sanitizeGeneratedTitle('   '), undefined);
  const essay =
    'Write a 1500 word essay about the history of roman citizenship and the legal meaning of that status across the empire';
  const fallback = fallbackTitle(essay);
  assert.match(fallback, /1500/);
  assert.notEqual(fallback, '150');
  assert.equal(isNumberFragment('150', essay), true);
  assert.equal(isNumberFragment('about 150', essay), true);
  assert.equal(isNumberFragment('Roman citizenship', essay), false);
  const cjkNumber = fallbackTitle(
    '一二三四五六七八九十一二三四五六七八1500' + '九'.repeat(30),
  );
  assert.match(cjkNumber, /1500/);
  assert.equal(/150(?!0)/.test(cjkNumber), false);
  const long = sanitizeGeneratedTitle(
    'Refactor the session title generator so the sidebar shows a short summary of the first prompt',
  );
  assert.ok(long && long.length <= 50, long);
  assert.ok(!long!.endsWith(' '), long);
});

class TitleModel implements ChatModel {
  model = 'title-model';
  sideRequests = true;
  readonly requests: ModelRequest[] = [];
  releaseTitle: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseTitle = resolve;
  });
  constructor(
    private readonly answer: string,
    private readonly title: string,
  ) {}
  failTitle = false;
  thinking = '';
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const titleCall = request.maxTokens === 128;
    if (titleCall && this.failTitle) throw new Error('title exploded');
    if (titleCall) await this.gate;
    const content = titleCall ? this.title : this.answer;
    if (content && !titleCall) request.token(content);
    return {
      message: {
        id: 'reply',
        role: 'assistant',
        content,
        ...(titleCall && this.thinking ? { thinking: this.thinking } : {}),
      },
      usage: emptyUsage(),
    };
  }
}

function harness(root: string, model: ChatModel) {
  const store = new CheckpointStore(root);
  const session = store.create(root, model.model);
  const policy = new ApprovalPolicy(
    new ApprovalStore(join(root, 'approvals')),
    root,
  );
  return {
    store,
    session,
    harness: new Harness({
      model,
      tools: [],
      store,
      session,
      policy,
      system: 'test',
    }),
  };
}

const LONG =
  'please help me fix the login bug in the authentication service that returns 500 when the session cookie is missing';

test('a side request names the session and does not take the answer', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'Login bug fix');
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const result = await run.run(LONG);
  assert.equal(result.answer, 'done');
  assert.equal(store.get(session.id)!.title, fallbackTitle(LONG));
  const titleCalls = model.requests.filter(
    (request) => request.maxTokens === 128,
  );
  assert.equal(titleCalls.length, 1);
  assert.equal(titleCalls[0]!.effort, '');
  assert.equal(
    model.requests.filter((request) => !request.maxTokens).length,
    1,
  );
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'Login bug fix');
});

test('a rename made while the title is pending wins', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'Generated');
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  await run.run(LONG);
  store.rename(session.id, 'Custom');
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'Custom');
});

test('a short prompt keeps the fallback and skips the model', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'Should not appear');
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const notes: string[] = [];
  run.bus.subscribe((event) => {
    const notice = event.payload.model_notice as { event?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push('failed');
  });
  await run.run('hello there');
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'hello there');
  assert.equal(
    model.requests.filter((request) => request.maxTokens === 128).length,
    0,
  );
  assert.deepEqual(notes, []);
});

test('a long prompt with no side request reports title failed', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'Login bug fix');
  model.sideRequests = false;
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const notes: string[] = [];
  run.bus.subscribe((event) => {
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push(String(notice.message));
  });
  await run.run(LONG);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, fallbackTitle(LONG));
  assert.equal(
    model.requests.filter((request) => request.maxTokens === 128).length,
    0,
  );
  assert.match(notes[0] ?? '', /no side request/);
});

test('the runtime wrapper keeps side requests and can name the session', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'Login bug fix');
  const wrapped = new ExtensionHost({
    home: root,
    workspace: root,
    trusted: false,
    bundledRoot: false,
  }).model(model);
  assert.equal(wrapped.sideRequests, true);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: wrapped,
    headless: true,
    localContext: false,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  assert.equal(runtime.harness.model.sideRequests, true);
  await runtime.harness.run(LONG);
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.store.get(runtime.session.id)!.title, 'Login bug fix');
  assert.equal(
    model.requests.filter((request) => request.maxTokens === 128).length,
    1,
  );
});

test('a numeric fragment is discarded and the fallback keeps the whole number', async (t) => {
  const root = scratch(t);
  const prompt =
    'Write a 1500 word essay about the history of roman citizenship and why it mattered';
  const model = new TitleModel('partial essay', '150');
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const notes: string[] = [];
  run.bus.subscribe((event) => {
    const notice = event.payload.model_notice as { event?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push('failed');
  });
  await run.run(prompt);
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  const title = store.get(session.id)!.title;
  assert.match(title, /1500/);
  assert.notEqual(title, '150');
  assert.deepEqual(notes, []);
});

test('a refusal leaves the fallback title', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'Sorry, I cannot title this');
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  await run.run(LONG);
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, fallbackTitle(LONG));
});

test('a failed side request keeps the fallback and is reported', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'Login bug fix');
  model.failTitle = true;
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const notes: string[] = [];
  run.bus.subscribe((event) => {
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push(String(notice.message));
  });
  await run.run(LONG);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, fallbackTitle(LONG));
  assert.match(notes[0] ?? '', /title exploded/);
});

test('a title that arrives as thinking still replaces the fallback', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', '');
  model.thinking = 'Sea poem';
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  await run.run(LONG);
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'Sea poem');
});

const TITLE_EVENTS: [string, unknown][] = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'message',
        type: 'message',
        role: 'assistant',
        model: 'glm-5.3',
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  ],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
];

function anthropicStream(text: string): string {
  const events: [string, unknown][] = [
    TITLE_EVENTS[0]!,
    TITLE_EVENTS[1]!,
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    ],
    ...TITLE_EVENTS.slice(2),
  ];
  return events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join('');
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms)
      throw new Error('timed out waiting for the session title');
    await delay(20);
  }
}

test('an Anthropic title request through the terminal replaces the fallback', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  let rejectTitle = false;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'glm-5.3' }] }));
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as { max_tokens?: number; system?: string };
    bodies.push(body);
    if (body.max_tokens === 128 && rejectTitle) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'title rejected' },
        }),
      );
      return;
    }
    const answer =
      body.max_tokens === 128
        ? 'Workspace File Overview'
        : 'Here are the files.';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(anthropicStream(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = `http://127.0.0.1:${address.port}`;
  settings.auth.protocol = 'anthropic';
  settings.auth.model = 'glm-5.3';
  saveCredentials({ api_key: 'fake-title-key' }, home);
  const previousDebug = process.env.CIRCLE_DEBUG;
  const previousRefresh = process.env.CIRCLE_NO_MODELS_REFRESH;
  const logged: string[] = [];
  const errors = console.error;
  process.env.CIRCLE_DEBUG = '1';
  process.env.CIRCLE_NO_MODELS_REFRESH = '1';
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  cleanup(t, () => {
    if (previousDebug === undefined) delete process.env.CIRCLE_DEBUG;
    else process.env.CIRCLE_DEBUG = previousDebug;
    if (previousRefresh === undefined)
      delete process.env.CIRCLE_NO_MODELS_REFRESH;
    else process.env.CIRCLE_NO_MODELS_REFRESH = previousRefresh;
    console.error = errors;
  });
  const app = new SessionApp(workspace, home, settings);
  const ui = app as unknown as {
    screen: { render: () => void };
    flashTimer?: ReturnType<typeof setTimeout>;
    input: { close: () => void };
    interactions: { close: () => void };
    off?: () => void;
    offSignals?: () => void;
  };
  ui.screen.render = () => {};
  await app.attach({ workspace, home, settings, headless: true });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    ui.interactions.close();
    await app.runtime?.close();
  });
  const prompt = 'list all the files in the workspace';
  await app.submit(prompt);
  const runtime = app.runtime!;
  const first = runtime.session.id;
  await until(
    () => runtime.store.get(first)?.title === 'Workspace File Overview',
  );
  const title = bodies.find(
    (body) =>
      body.max_tokens === 128 &&
      String(body.system).includes('title generator'),
  );
  assert.ok(title, JSON.stringify(bodies.map((body) => body.max_tokens)));
  assert.match(String(title.system), /title generator/);
  assert.equal(title.output_config, undefined);
  assert.equal(title.thinking, undefined);
  assert.equal(title.max_tokens, 128);
  assert.match(logged.join('\n'), /\[circle\] title:/);
  assert.notEqual(runtime.store.get(first)?.title, fallbackTitle(prompt));
  rejectTitle = true;
  await app.submit('/new');
  const failed = 'please explain how the workspace build is wired together';
  await app.submit(failed);
  const second = app.runtime!;
  await until(() =>
    app.state.notices.some((line) => line.includes('title failed')),
  );
  assert.match(app.state.flash, /title failed/);
  assert.match(app.state.notices.join('\n'), /title failed/);
  assert.equal(
    second.store.get(second.session.id)?.title,
    fallbackTitle(failed),
  );
});
