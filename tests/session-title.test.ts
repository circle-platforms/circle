import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { test } from 'node:test';
import { join } from 'node:path';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { ExtensionHost } from '../src/extensions.js';
import { Harness } from '../src/harness.js';
import { GatewayModel } from '../src/model.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { fallbackTitle, sanitizeGeneratedTitle } from '../src/session_title.js';
import type { ChatModel, ModelRequest, ModelResponse } from '../src/types.js';
import { emptyUsage } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

test('fallback titles stay short and drop a leading please', () => {
  assert.equal(fallbackTitle('hello'), 'hello');
  assert.equal(fallbackTitle('please fix the login bug'), 'fix the login bug');
  assert.equal(fallbackTitle('请帮我看一下'), '帮我看一下');
  assert.equal(fallbackTitle('请'), '请');
  assert.equal(
    fallbackTitle('@README.md what is this'),
    'README.md what is this',
  );
  assert.equal(fallbackTitle('@README.md'), 'README.md');
  assert.equal(
    fallbackTitle('ping me at a@b.com about the login'),
    'ping me at a@b.com about the login',
  );
  assert.equal(
    fallbackTitle(
      '@README.md what is the first heading in this file and why it is there',
    ),
    'README.md what is the first heading in',
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
  assert.equal(sanitizeGeneratedTitle('   '), undefined);
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
  assert.equal(titleCalls[0]!.tools.length, 0);
  assert.equal(titleCalls[0]!.messages[0]!.content, LONG);
  assert.equal(
    model.requests.filter((request) => !request.maxTokens).length,
    1,
  );
  assert.ok(model.requests[0]!.maxTokens === undefined);
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
  await run.run('hello there');
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'hello there');
  assert.equal(
    model.requests.filter((request) => request.maxTokens === 128).length,
    0,
  );
});

test('a prompt under 24 characters does not ask for a title', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'Should not appear');
  const { harness: run, store } = harness(root, model);
  cleanup(t, () => store.close());
  const prompt = 'fix the login bug now!!';
  assert.equal(prompt.length, 23);
  await run.run(prompt);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    model.requests.filter((request) => request.maxTokens === 128).length,
    0,
  );
});

test('a refusal leaves the fallback title', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'Sorry, I cannot title this');
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const notes: string[] = [];
  run.bus.subscribe((event) => {
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push(String(notice.message));
  });
  await run.run(LONG);
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, fallbackTitle(LONG));
  assert.equal(notes[0], 'empty title');
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

const LIVE = 'Please list all the files in the workspace and explain each';

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function sse(
  response: ServerResponse,
  write: (event: (type: string, payload: unknown) => void) => void,
) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = (type: string, payload: unknown) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  write(event);
  response.end();
}

test('an anthropic title call waits out the turn and sends no thinking', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  let answerSent = false;
  const instance = createServer(async (request, response) => {
    const body = await readBody(request);
    bodies.push(body);
    const title = body.max_tokens === 128;
    if (title) assert.equal(answerSent, true);
    sse(response, (event) => {
      event('message_start', {
        type: 'message_start',
        message: {
          id: title ? 'title' : 'answer',
          type: 'message',
          role: 'assistant',
          model: 'glm-5.3',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      });
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: title ? 'Workspace file list' : 'listed',
        },
      });
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      });
      event('message_stop', { type: 'message_stop' });
    });
    if (!title) answerSent = true;
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve) => {
        instance.closeAllConnections();
        instance.close(() => resolve());
      }),
  );
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  const root = scratch(t);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    base_url: `http://127.0.0.1:${address.port}`,
    model: 'glm-5.3',
    protocol: 'anthropic',
  };
  saveCredentials({ api_key: 'test-key' }, root);
  const model = new GatewayModel(settings, root);
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  assert.notEqual(fallbackTitle(LIVE), 'Workspace file list');
  const result = await run.run(LIVE);
  assert.equal(result.answer, 'listed');
  for (let i = 0; i < 20; i++) {
    if (store.get(session.id)!.title === 'Workspace file list') break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(store.get(session.id)!.title, 'Workspace file list');
  const title = bodies.find((body) => body.max_tokens === 128);
  assert.ok(title);
  assert.equal(title!.output_config, undefined);
  assert.equal(title!.thinking, undefined);
  assert.equal(title!.model, 'glm-5.3');
  assert.equal(bodies[0]!.max_tokens === 128, false);
});

test('a thinking block with no text still becomes the session title', async (t) => {
  let answerSent = false;
  const instance = createServer(async (request, response) => {
    const body = await readBody(request);
    const title = body.max_tokens === 128;
    if (title) {
      assert.equal(answerSent, true);
      assert.equal(body.output_config, undefined);
      assert.equal(body.thinking, undefined);
    }
    sse(response, (event) => {
      event('message_start', {
        type: 'message_start',
        message: {
          id: title ? 'title' : 'answer',
          type: 'message',
          role: 'assistant',
          model: 'glm-5.3',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      });
      if (title) {
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        });
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Workspace file list' },
        });
        event('content_block_stop', { type: 'content_block_stop', index: 0 });
      } else {
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'listed' },
        });
        event('content_block_stop', { type: 'content_block_stop', index: 0 });
      }
      event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      });
      event('message_stop', { type: 'message_stop' });
    });
    if (!title) answerSent = true;
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve) => {
        instance.closeAllConnections();
        instance.close(() => resolve());
      }),
  );
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  const root = scratch(t);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    base_url: `http://127.0.0.1:${address.port}`,
    model: 'glm-5.3',
    protocol: 'anthropic',
  };
  saveCredentials({ api_key: 'test-key' }, root);
  const model = new GatewayModel(settings, root);
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const result = await run.run(LIVE);
  assert.equal(result.answer, 'listed');
  for (let i = 0; i < 20; i++) {
    if (store.get(session.id)!.title === 'Workspace file list') break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(store.get(session.id)!.title, 'Workspace file list');
});

test('the extension wrapper keeps a side request so a runtime can title', async (t) => {
  const root = scratch(t);
  const host = new ExtensionHost({
    home: root,
    workspace: root,
    trusted: false,
    bundledRoot: false,
  });
  const model = new TitleModel('done', 'Login bug fix');
  const wrapped = host.model(model);
  assert.equal(wrapped.sideRequests, true);
  const { harness: run, store, session } = harness(root, wrapped);
  cleanup(t, () => store.close());
  const result = await run.run(LONG);
  assert.equal(result.answer, 'done');
  const title = model.requests.find((request) => request.maxTokens === 128);
  assert.ok(title);
  assert.equal(title!.effort, '');
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'Login bug fix');
});

test('renaming a session does not move it above a newer one', (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const older = store.create(root, 'm', 'older');
  const stamp = older.updated;
  while (Date.now() === stamp) {
    /* The two rows need different activity times. */
  }
  const newer = store.create(root, 'm', 'newer');
  assert.equal(store.list()[0]!.id, newer.id);
  store.rename(older.id, 'renamed');
  assert.equal(store.get(older.id)!.title, 'renamed');
  assert.equal(store.get(older.id)!.updated, stamp);
  assert.equal(store.list()[0]!.id, newer.id);
  assert.equal(store.list()[1]!.id, older.id);
});
