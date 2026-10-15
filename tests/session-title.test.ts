import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { join } from 'node:path';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { Harness } from '../src/harness.js';
import { GatewayModel } from '../src/model.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import {
  fallbackTitle,
  sanitizeGeneratedTitle,
  titleFromModelReply,
} from '../src/session_title.js';
import type { ChatModel, ModelRequest, ModelResponse } from '../src/types.js';
import { emptyUsage } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

test('fallback titles stay short and drop a leading please', () => {
  assert.equal(fallbackTitle('hello'), 'hello');
  assert.equal(fallbackTitle('please fix the login bug'), 'fix the login bug');
  assert.equal(fallbackTitle('请帮我看一下'), '帮我看一下');
  assert.equal(fallbackTitle('请'), '请');
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
  assert.equal(
    sanitizeGeneratedTitle(
      '<think>planning the name</think>\nWorkspace file list',
    ),
    'Workspace file list',
  );
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
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (request.effort === 'low') await this.gate;
    const content = request.effort === 'low' ? this.title : this.answer;
    if (content && request.effort !== '') request.token(content);
    return {
      message: { id: 'reply', role: 'assistant', content },
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
  assert.equal(
    model.requests.filter((request) => request.effort === 'low').length,
    1,
  );
  assert.match(
    String(
      model.requests.find((request) => request.effort === 'low')!.messages[0]!
        .content,
    ),
    /Write the title in the same language as the user message/,
  );
  assert.equal(
    model.requests.filter((request) => request.effort === undefined).length,
    1,
  );
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'Login bug fix');
  assert.equal(
    model.requests.filter((request) => request.effort === 'low').length,
    1,
  );
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

test('a prompt past sixteen characters asks for a title', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'Login bug');
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const prompt = 'fix the login bug';
  assert.equal(prompt.length, 17);
  await run.run(prompt);
  assert.equal(
    model.requests.filter((request) => request.effort === 'low').length,
    1,
  );
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'Login bug');
});

test('a chinese prompt asks for a chinese title', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', '登录错误说明');
  const { harness: run, store } = harness(root, model);
  cleanup(t, () => store.close());
  const prompt = '请把登录失败时的五百错误改成可读的说明';
  assert.ok(prompt.length > 16);
  await run.run(prompt);
  assert.match(
    String(
      model.requests.find((request) => request.effort === 'low')!.messages[0]!
        .content,
    ),
    /Write the title in Simplified Chinese/,
  );
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
});

test('a failed title request is tried once more after the turn', async (t) => {
  const root = scratch(t);
  let attempts = 0;
  const model: ChatModel = {
    model: 'title-model',
    sideRequests: true,
    async complete(request) {
      if (request.effort === 'low') {
        attempts += 1;
        if (attempts === 1) throw new Error('gateway busy');
        return {
          message: {
            id: 'title',
            role: 'assistant',
            content: 'Login bug fix',
          },
          usage: emptyUsage(),
        };
      }
      request.token('done');
      return {
        message: { id: 'reply', role: 'assistant', content: 'done' },
        usage: emptyUsage(),
      };
    },
  };
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const result = await run.run(LONG);
  assert.equal(result.answer, 'done');
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(store.get(session.id)!.title, 'Login bug fix');
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
    model.requests.filter((request) => request.effort === 'low').length,
    0,
  );
});

test('a title call uses low effort and a short budget', async (t) => {
  const root = scratch(t);
  const requests: ModelRequest[] = [];
  const model: ChatModel = {
    model: 'glm',
    sideRequests: true,
    async complete(request) {
      requests.push(request);
      if (request.effort && request.effort !== 'low')
        throw new Error('output_config.effort is not supported');
      if (request.effort === 'low') {
        return {
          message: {
            id: 'title',
            role: 'assistant',
            content: 'Workspace file list',
          },
          usage: emptyUsage(),
        };
      }
      request.token('listed');
      return {
        message: { id: 'reply', role: 'assistant', content: 'listed' },
        usage: emptyUsage(),
      };
    },
  };
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const prompt = 'Please list all the files in the workspace and explain each';
  assert.notEqual(fallbackTitle(prompt), 'Workspace file list');
  const result = await run.run(prompt);
  assert.equal(result.answer, 'listed');
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'Workspace file list');
  const title = requests.find((request) => request.effort === 'low');
  assert.ok(title);
  assert.equal(title!.maxTokens, 4096);
  assert.equal(
    requests.filter((request) => request.effort === 'low').length,
    1,
  );
  assert.match(String(title!.messages[0]!.content), /same language/);
});

test('a thinking-only reply still replaces the fallback title', async (t) => {
  const root = scratch(t);
  const model: ChatModel = {
    model: 'glm-5.3',
    sideRequests: true,
    async complete(request) {
      if (request.effort === 'low') {
        return {
          message: {
            id: 'title',
            role: 'assistant',
            model: 'glm-5.3',
            content: '',
            thinking:
              'The user wants every file in the workspace explained.\nWorkspace file list',
          },
          usage: emptyUsage(),
        };
      }
      request.token('listed');
      return {
        message: { id: 'reply', role: 'assistant', content: 'listed' },
        usage: emptyUsage(),
      };
    },
  };
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const prompt = 'Please list all the files in the workspace and explain each';
  await run.run(prompt);
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'Workspace file list');
});

test('a title buried in a think tag replaces the fallback', () => {
  assert.equal(
    titleFromModelReply(
      '<think>\nThe user wants every file explained.\nWorkspace file list\n</think>',
    ),
    'Workspace file list',
  );
  assert.equal(
    titleFromModelReply('', 'Need a short name.\n列出工作区文件'),
    '列出工作区文件',
  );
  assert.equal(titleFromModelReply('', 'The user wants a title.'), undefined);
  assert.equal(
    titleFromModelReply(
      '',
      'The user wants every file explained. Workspace file list.',
    ),
    'Workspace file list',
  );
});

test('glm thinking-block stream is stored as the session title', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const instance = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    bodies.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type: string, payload: unknown) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    const title = body.max_tokens === 4096;
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
      // GLM-5.3: a thinking block, then end_turn, and no text block.
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_delta',
          thinking:
            'The user wants every file in the workspace explained.\nWorkspace file list',
        },
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
      usage: { output_tokens: 8 },
    });
    event('message_stop', { type: 'message_stop' });
    response.end();
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
  const prompt = 'Please list all the files in the workspace and explain each';
  const result = await run.run(prompt);
  assert.equal(result.answer, 'listed');
  for (let i = 0; i < 20; i++) {
    if (store.get(session.id)!.title === 'Workspace file list') break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(store.get(session.id)!.title, 'Workspace file list');
  const title = bodies.find((body) => body.max_tokens === 4096);
  assert.ok(title);
  assert.equal(
    (title!.output_config as { effort?: string } | undefined)?.effort,
    'low',
  );
  assert.equal(title!.model, 'glm-5.3');
});

test('a title call that the gateway rejects for effort still stores the thinking title', async (t) => {
  let rejected = 0;
  const instance = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const title = body.max_tokens === 4096;
    if (title && body.output_config) {
      rejected += 1;
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'output_config.effort is not supported',
          },
        }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type: string, payload: unknown) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
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
        delta: {
          type: 'thinking_delta',
          thinking: 'The user wants every file explained.\nWorkspace file list',
        },
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
    response.end();
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
  const result = await run.run(
    'Please list all the files in the workspace and explain each',
  );
  assert.equal(result.answer, 'listed');
  for (let i = 0; i < 20; i++) {
    if (store.get(session.id)!.title === 'Workspace file list') break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(rejected, 1);
  assert.equal(store.get(session.id)!.title, 'Workspace file list');
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
