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
  acceptGeneratedTitle,
  echoesPrompt,
  fallbackTitle,
  firstUserSource,
  isNumberFragment,
  repairedTitle,
  sanitizeGeneratedTitle,
  TITLE_MAX_CHARS,
  TITLE_MAX_CJK,
  TITLE_MAX_WORDS,
  titleConversation,
  titleNeedsRefresh,
  titleUnits,
  titleWorthy,
  userPrompts,
} from '../src/session_title.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
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

test('generated titles keep one short phrase and drop a reply', () => {
  assert.equal(sanitizeGeneratedTitle('  "Login bug"\nextra'), 'Login bug');
  assert.equal(sanitizeGeneratedTitle('会话标题。'), '会话标题');
  assert.equal(sanitizeGeneratedTitle('Sorry, I cannot do that'), undefined);
  assert.equal(sanitizeGeneratedTitle('150'), undefined);
  assert.equal(sanitizeGeneratedTitle('1500.'), undefined);
  assert.equal(sanitizeGeneratedTitle('   '), undefined);
  assert.equal(
    sanitizeGeneratedTitle('First heading in README.md'),
    'First heading in README.md',
  );
  assert.equal(
    sanitizeGeneratedTitle('Fix your login page'),
    'Fix your login page',
  );
  assert.equal(sanitizeGeneratedTitle('登录故障修复'), '登录故障修复');
  const words = Array.from({ length: TITLE_MAX_WORDS }, (_, i) => `w${i}`).join(
    ' ',
  );
  assert.equal(sanitizeGeneratedTitle(words), words);
  assert.equal(sanitizeGeneratedTitle(`${words} extra`), undefined);
  const chars = 'a'.repeat(TITLE_MAX_CHARS);
  assert.equal(sanitizeGeneratedTitle(chars), chars);
  assert.equal(sanitizeGeneratedTitle(`${chars}b`), undefined);
  assert.equal(sanitizeGeneratedTitle('What is README.md?'), undefined);
  assert.equal(sanitizeGeneratedTitle('这是什么？'), undefined);
  assert.equal(sanitizeGeneratedTitle('Login bug. Write tests'), undefined);
  assert.equal(sanitizeGeneratedTitle('登录故障。请再看一眼'), undefined);
  assert.equal(sanitizeGeneratedTitle("I don't see the file"), undefined);
  assert.equal(sanitizeGeneratedTitle('Could you paste it'), undefined);
  assert.equal(sanitizeGeneratedTitle('You left out the file'), undefined);
  assert.equal(sanitizeGeneratedTitle('我看不到附件内容'), '我看不到附件内容');
  assert.equal(sanitizeGeneratedTitle('你好世界 Go 程序'), '你好世界 Go 程序');
  assert.equal(sanitizeGeneratedTitle('我的 Go 程序'), '我的 Go 程序');
  assert.equal(sanitizeGeneratedTitle('我无法生成标题'), undefined);
  assert.equal(sanitizeGeneratedTitle('尾递归解释请求'), '尾递归解释');
  assert.equal(
    sanitizeGeneratedTitle('罗马帝国介绍请求（含共和国等术语）'),
    '罗马帝国介绍',
  );
  assert.equal(
    sanitizeGeneratedTitle('hello.txt creation request'),
    'hello.txt creation request',
  );
  assert.equal(
    sanitizeGeneratedTitle('Rate limiting request'),
    'Rate limiting',
  );
  assert.equal(sanitizeGeneratedTitle('Creating hello.txt with hi'), undefined);
  assert.equal(
    sanitizeGeneratedTitle('一'.repeat(TITLE_MAX_CJK)),
    '一'.repeat(TITLE_MAX_CJK),
  );
  assert.equal(
    sanitizeGeneratedTitle('一'.repeat(TITLE_MAX_CJK + 1)),
    undefined,
  );
  assert.equal(
    titleNeedsRefresh(
      'Creating hello.txt with hi',
      'create hello.txt with hi and then leave it',
    ),
    true,
  );
  assert.equal(
    titleNeedsRefresh(
      '@README.md what is the first heading in',
      '@README.md what is the first heading in this file please',
    ),
    true,
  );
  assert.equal(
    titleNeedsRefresh(
      'hiFib demo',
      'hiFib demo of tail recursion that prints a few numbers',
    ),
    true,
  );
  assert.equal(
    titleNeedsRefresh('尾递归解释请求', '请解释一下什么是尾递归并给一个例子'),
    true,
  );
  assert.equal(
    titleNeedsRefresh('Custom name', '帮我写一个你好世界的Go程序'),
    false,
  );
  assert.equal(
    titleNeedsRefresh('罗马帝国简介', '请用大约200字介绍一下罗马帝国的兴衰'),
    false,
  );
  assert.equal(
    titleNeedsRefresh(
      'hello.txt creation request',
      'create hello.txt with hi and then leave it',
    ),
    false,
  );
  assert.equal(titleNeedsRefresh('hi', 'hi'), false);
  assert.equal(
    titleNeedsRefresh(
      'hiFib demo',
      'hiFib demonstration of tail recursion that prints a few numbers',
    ),
    true,
  );
  assert.equal(
    titleNeedsRefresh(
      'please explain to me briefly in two',
      'please explain to me briefly in two sentences how this works today',
    ),
    true,
  );
  assert.equal(
    titleNeedsRefresh('hiFib demo', 'hi', ['Fib demo of tail recursion']),
    true,
  );
  assert.equal(
    titleNeedsRefresh('please explain to me briefly in two', 'please explain', [
      'to me briefly in two sentences how this works today',
    ]),
    true,
  );
  assert.equal(
    titleNeedsRefresh('hi', 'hi', ['please explain tail recursion in detail']),
    false,
  );
  assert.deepEqual(
    userPrompts([
      {
        role: 'user',
        display: 'please explain to me briefly in two',
        content:
          'please explain to me briefly in two sentences how this works today',
      },
    ]),
    ['please explain to me briefly in two sentences how this works today'],
  );
  assert.equal(sanitizeGeneratedTitle('请提供文件内容'), undefined);
  assert.equal(sanitizeGeneratedTitle('你可以粘贴一下'), undefined);
  assert.equal(titleUnits('解释 React hooks'), 4);
  assert.equal(titleUnits('什么是 Rust'), 4);
  assert.equal(titleUnits('what is TCP'), 3);
  assert.equal(titleUnits('hi there'), 2);
  assert.equal(titleUnits('thanks'), 1);
  assert.equal(titleUnits('你好'), 2);
  assert.equal(titleWorthy('hi'), false);
  assert.equal(titleWorthy('hello there'), false);
  assert.equal(titleWorthy('hi there'), false);
  assert.equal(titleWorthy('ok'), false);
  assert.equal(titleWorthy('thanks'), false);
  assert.equal(titleWorthy('Thanks!'), false);
  assert.equal(titleWorthy('thanks a lot'), false);
  assert.equal(titleWorthy('what is TCP'), true);
  assert.equal(titleWorthy('what is TCP?'), true);
  assert.equal(titleWorthy('解释 React hooks'), true);
  assert.equal(titleWorthy('什么是 Rust'), true);
  assert.equal(titleWorthy('你好'), false);
  assert.equal(titleWorthy('你好啊'), false);
  assert.equal(echoesPrompt('What is TCP', 'what is TCP'), true);
  assert.equal(echoesPrompt('What is TCP?', 'what is TCP'), true);
  assert.equal(echoesPrompt('what is TCP!', 'what is TCP'), true);
  assert.equal(echoesPrompt('TCP overview', 'what is TCP'), false);
  assert.equal(echoesPrompt('什么是 rust', '什么是 Rust'), true);
  assert.equal(echoesPrompt('Rust 简介', '什么是 Rust'), false);
  assert.equal(
    acceptGeneratedTitle('What is TCP', 'what is TCP').reason,
    'echoes prompt',
  );
  assert.equal(
    acceptGeneratedTitle('What is TCP', 'what is TCP').title,
    undefined,
  );
  assert.equal(
    acceptGeneratedTitle('TCP overview', 'what is TCP').title,
    'TCP overview',
  );
  assert.equal(titleWorthy('一二三'), true);
  assert.equal(titleWorthy('一二三四'), true);
  assert.equal(titleWorthy('请'), false);
  assert.equal(titleWorthy('请用大约200字介绍一下罗马帝国的兴衰'), true);
  assert.equal(titleWorthy('帮我写一个你好世界的Go程序'), true);
  assert.equal(
    repairedTitle(
      'The user wants me to generate a title for a conver',
      '请用大约200字介绍一下罗马帝国的兴衰',
    ),
    fallbackTitle('请用大约200字介绍一下罗马帝国的兴衰'),
  );
  assert.equal(
    repairedTitle('150', 'Write a 1500 word essay about roman citizenship'),
    fallbackTitle('Write a 1500 word essay about roman citizenship'),
  );
  assert.equal(repairedTitle('Login bug fix', LONG), undefined);
  assert.equal(
    firstUserSource([
      { role: 'user', content: 'hidden', display: 'shown', internal: 'note' },
      { role: 'user', content: 'body', display: 'visible' },
    ]),
    'visible',
  );
  assert.equal(
    sanitizeGeneratedTitle(
      "I don't see any README.md content attached to your message. Could you paste…",
    ),
    undefined,
  );
  assert.equal(
    sanitizeGeneratedTitle('<conversation>\nLogin bug\n</conversation>'),
    undefined,
  );
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
  assert.equal(
    sanitizeGeneratedTitle(
      'Refactor the session title generator so the sidebar shows a short summary of the first prompt',
    ),
    undefined,
  );
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
  /** Title replies in order. Later calls use `title`. */
  scriptedTitles?: string[];
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const titleCall = request.maxTokens === Harness.titleOutputTokens;
    if (titleCall && this.failTitle) throw new Error('title exploded');
    if (titleCall) await this.gate;
    const content = titleCall
      ? (this.scriptedTitles?.shift() ?? this.title)
      : this.answer;
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
    (request) => request.maxTokens === Harness.titleOutputTokens,
  );
  assert.equal(titleCalls.length, 1);
  assert.equal(titleCalls[0]!.effort, '');
  assert.equal(titleCalls[0]!.messages[0]!.content, titleConversation(LONG));
  assert.match(String(titleCalls[0]!.system), /Do not answer it/);
  assert.match(String(titleCalls[0]!.system), /natural topic/);
  assert.match(String(titleCalls[0]!.system), /hello\.txt creation request/);
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
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push(String(notice.message));
  });
  await run.run('hello there');
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'hello there');
  assert.equal(
    model.requests.filter(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    ).length,
    0,
  );
  assert.deepEqual(notes, []);
});

test('a three-word question asks for a summary title', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'TCP overview');
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const notes: string[] = [];
  run.bus.subscribe((event) => {
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push(String(notice.message));
  });
  const prompt = 'what is TCP';
  assert.equal(prompt.split(' ').length, 3);
  assert.equal(titleWorthy(prompt), true);
  await run.run(prompt);
  assert.equal(store.get(session.id)!.title, 'what is TCP');
  assert.equal(
    model.requests.filter(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    ).length,
    1,
  );
  assert.equal(
    model.requests.find(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    )!.messages[0]!.content,
    titleConversation(prompt),
  );
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'TCP overview');
  assert.deepEqual(notes, []);
});

test('a capitalized copy of the prompt is retried once as a noun phrase', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'unused');
  model.scriptedTitles = ['What is TCP', 'TCP overview'];
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const notes: string[] = [];
  run.bus.subscribe((event) => {
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push(String(notice.message));
  });
  await run.run('what is TCP');
  const calls = () =>
    model.requests.filter(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    );
  assert.equal(calls().length, 1);
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls().length, 2);
  assert.match(String(calls()[1]!.system), /TCP overview/);
  assert.match(String(calls()[1]!.system), /capitalization or punctuation/);
  assert.equal(store.get(session.id)!.title, 'TCP overview');
  assert.deepEqual(notes, []);
});

test('a second near-duplicate keeps the short typed title', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'unused');
  model.scriptedTitles = ['What is TCP', 'what is TCP!'];
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const notes: string[] = [];
  run.bus.subscribe((event) => {
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push(String(notice.message));
  });
  await run.run('what is TCP');
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    model.requests.filter(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    ).length,
    2,
  );
  assert.equal(store.get(session.id)!.title, 'what is TCP');
  assert.deepEqual(notes, ['echoes prompt']);
});

test('CJK and Latin units are counted together, and a greeting is not titled', async (t) => {
  const cases = [
    { prompt: '解释 React hooks', title: 'React hooks', ask: true },
    { prompt: '什么是 Rust', title: 'Rust 简介', ask: true },
    { prompt: 'what is TCP', title: 'TCP overview', ask: true },
    { prompt: 'hi there', title: 'hi there', ask: false },
    { prompt: 'thanks', title: 'thanks', ask: false },
    { prompt: '你好', title: '你好', ask: false },
  ];
  for (const item of cases) {
    const root = scratch(t);
    const model = new TitleModel('done', item.ask ? item.title : 'unused');
    const { harness: run, store, session } = harness(root, model);
    cleanup(t, () => store.close());
    await run.run(item.prompt);
    assert.equal(
      model.requests.filter(
        (request) => request.maxTokens === Harness.titleOutputTokens,
      ).length,
      item.ask ? 1 : 0,
      item.prompt,
    );
    if (!item.ask) {
      assert.equal(store.get(session.id)!.title, item.title, item.prompt);
      continue;
    }
    model.releaseTitle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.get(session.id)!.title, item.title, item.prompt);
  }
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
    model.requests.filter(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    ).length,
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
    model.requests.filter(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    ).length,
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
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push(String(notice.message));
  });
  await run.run(prompt);
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  const title = store.get(session.id)!.title;
  assert.match(title, /1500/);
  assert.notEqual(title, '150');
  assert.deepEqual(notes, ['number fragment']);
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
  assert.equal(notes[0], 'not a title');
});

test('an answer instead of a title keeps the fallback', async (t) => {
  const root = scratch(t);
  const model = new TitleModel(
    'done',
    "I don't see any README.md content attached to your message. Could you paste…",
  );
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
  assert.equal(notes[0], 'not a title');
  assert.match(
    model.requests.find(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    )!.messages[0]!.content,
    /^<conversation>\n/,
  );
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

test('thinking text is never used as the title', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', '');
  model.thinking = 'The user wants me to generate a title for a conver';
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
  assert.match(notes[0] ?? '', /empty title/);
  assert.equal(store.get(session.id)!.title.includes('The user wants'), false);
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
    const titleCall = String(body.system ?? '').includes('title generator');
    if (titleCall && rejectTitle) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'title rejected' },
        }),
      );
      return;
    }
    const answer = titleCall
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
  const title = bodies.find((body) =>
    String(body.system).includes('title generator'),
  );
  assert.ok(title, JSON.stringify(bodies.map((body) => body.max_tokens)));
  assert.match(String(title.system), /title generator/);
  assert.match(String(title.system), /Do not answer it/);
  assert.match(JSON.stringify(title.messages), /<conversation>\\nlist all/);
  assert.match(
    JSON.stringify(title.messages),
    /in the workspace\\n<\/conversation>/,
  );
  assert.equal(title.output_config, undefined);
  assert.deepEqual(title.thinking, { type: 'disabled' });
  assert.equal(title.max_tokens, Harness.titleOutputTokens);
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

test('an Anthropic title reply that is only thinking keeps the fallback', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'glm-5.3' }] }));
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as { system?: string };
    bodies.push(body);
    const titleCall = String(body.system ?? '').includes('title generator');
    const events: [string, unknown][] = titleCall
      ? [
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
                usage: { input_tokens: 20, output_tokens: 0 },
              },
            },
          ],
          [
            'content_block_start',
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'thinking_delta',
                thinking:
                  'The user is asking about a README.md file - they want a title',
              },
            },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'sig' },
            },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          [
            'message_delta',
            {
              type: 'message_delta',
              delta: { stop_reason: 'max_tokens', stop_sequence: null },
              usage: { output_tokens: 512 },
            },
          ],
          ['message_stop', { type: 'message_stop' }],
        ]
      : [
          TITLE_EVENTS[0]!,
          TITLE_EVENTS[1]!,
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Here are the files.' },
            },
          ],
          ...TITLE_EVENTS.slice(2),
        ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      events
        .map(
          ([event, data]) =>
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        )
        .join(''),
    );
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
  const previousRefresh = process.env.CIRCLE_NO_MODELS_REFRESH;
  process.env.CIRCLE_NO_MODELS_REFRESH = '1';
  cleanup(t, () => {
    if (previousRefresh === undefined)
      delete process.env.CIRCLE_NO_MODELS_REFRESH;
    else process.env.CIRCLE_NO_MODELS_REFRESH = previousRefresh;
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
  const prompt = 'look at @README.md and tell me what the first heading is';
  await app.submit(prompt);
  const runtime = app.runtime!;
  await until(() =>
    app.state.notices.some((line) => line.includes('title failed')),
  );
  const title = bodies.find((body) =>
    String(body.system).includes('title generator'),
  );
  assert.ok(title);
  assert.deepEqual(title.thinking, { type: 'disabled' });
  assert.equal(title.max_tokens, Harness.titleOutputTokens);
  assert.equal(title.output_config, undefined);
  assert.match(String(title.system), /Do not answer it/);
  assert.match(JSON.stringify(title.messages), /<conversation>\\nlook at/);
  const stored = runtime.store.get(runtime.session.id)!.title;
  assert.equal(stored, fallbackTitle(prompt));
  assert.equal(stored.includes('The user is asking'), false);
  assert.match(app.state.notices.join('\n'), /title failed/);
});

test('Chinese prompts are titled from the model over a real HTTP server', async (t) => {
  const rome = '请用大约200字介绍一下罗马帝国的兴衰';
  const go = '帮我写一个你好世界的Go程序';
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'glm-5.3' }] }));
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as { system?: string; messages?: unknown };
    bodies.push(body);
    const titleCall = String(body.system ?? '').includes('title generator');
    const conversation = JSON.stringify(body.messages ?? '');
    const answer = !titleCall
      ? '好的。'
      : conversation.includes('你好世界')
        ? '你好世界 Go 程序'
        : '罗马帝国兴衰';
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
  const previousRefresh = process.env.CIRCLE_NO_MODELS_REFRESH;
  process.env.CIRCLE_NO_MODELS_REFRESH = '1';
  cleanup(t, () => {
    if (previousRefresh === undefined)
      delete process.env.CIRCLE_NO_MODELS_REFRESH;
    else process.env.CIRCLE_NO_MODELS_REFRESH = previousRefresh;
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
  await app.submit(rome);
  const first = app.runtime!;
  const firstId = first.session.id;
  await until(() => first.store.get(firstId)?.title === '罗马帝国兴衰');
  assert.notEqual(first.store.get(firstId)?.title, fallbackTitle(rome));
  assert.equal(first.store.get(firstId)?.title?.includes('用大约200字'), false);
  await app.submit('/new');
  await app.submit(go);
  const second = app.runtime!;
  const secondId = second.session.id;
  await until(() => second.store.get(secondId)?.title === '你好世界 Go 程序');
  assert.notEqual(second.store.get(secondId)?.title, fallbackTitle(go));
  const titles = bodies.filter((body) =>
    String(body.system).includes('title generator'),
  );
  assert.equal(titles.length, 2);
  assert.match(String(titles[0]!.system), /Chinese title/);
  assert.match(String(titles[1]!.system), /Do not answer it/);
  assert.deepEqual(titles[0]!.thinking, { type: 'disabled' });
  assert.deepEqual(titles[1]!.thinking, { type: 'disabled' });
  assert.equal(titles[0]!.max_tokens, Harness.titleOutputTokens);
  const wire = JSON.stringify(titles.map((body) => body.messages));
  assert.match(wire, /<conversation>\\n请用大约200字介绍一下罗马帝国的兴衰\\n/);
  assert.match(wire, /<conversation>\\n帮我写一个你好世界的Go程序\\n/);
  assert.equal(
    app.state.notices.some((line) => line.includes('title failed')),
    false,
  );
});

test('opening a session replaces a reasoning title and a number fragment', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  const essay =
    'Write a 1500 word essay about the history of roman citizenship and why it mattered';
  const readme = 'look at README.md and tell me what the first heading is';
  const login =
    'please help me fix the login bug in the authentication service that returns 500';
  const number = store.create(root, 'scripted');
  store.append(number.id, [{ id: 'n', role: 'user', content: essay }]);
  store.rename(number.id, '150');
  const asking = store.create(root, 'scripted');
  store.append(asking.id, [{ id: 'a', role: 'user', content: readme }]);
  store.rename(asking.id, 'The user is asking about a README.md file - they');
  const wants = store.create(root, 'scripted');
  store.append(wants.id, [
    { id: 'w', role: 'user', content: '请用大约200字介绍一下罗马帝国的兴衰' },
  ]);
  store.rename(wants.id, 'The user wants me to generate a title for a conver');
  const kept = store.create(root, 'scripted');
  store.append(kept.id, [{ id: 'k', role: 'user', content: login }]);
  store.rename(kept.id, 'Login bug fix');
  store.close();
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    session: number.id,
    headless: true,
    localContext: false,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  assert.match(runtime.store.get(number.id)!.title, /1500/);
  assert.equal(runtime.store.get(number.id)!.title, fallbackTitle(essay));
  assert.equal(runtime.session.title, fallbackTitle(essay));
  assert.equal(
    runtime.store.get(asking.id)!.title.includes('The user is asking'),
    false,
  );
  assert.equal(runtime.store.get(asking.id)!.title, fallbackTitle(readme));
  assert.equal(
    runtime.store.get(wants.id)!.title.includes('The user wants'),
    false,
  );
  assert.equal(
    runtime.store.get(wants.id)!.title,
    fallbackTitle('请用大约200字介绍一下罗马帝国的兴衰'),
  );
  assert.equal(runtime.store.get(kept.id)!.title, 'Login bug fix');
});

test('opening a finished session re-requests a title that is only the trimmed prompt', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  const prompt = '帮我写一个你好世界的Go程序';
  const finished = store.create(root, 'scripted');
  store.append(finished.id, [
    { id: 'u', role: 'user', content: prompt },
    { id: 'a', role: 'assistant', content: '好的。' },
  ]);
  store.rename(finished.id, fallbackTitle(prompt));
  const unanswered = store.create(root, 'scripted');
  store.append(unanswered.id, [{ id: 'u2', role: 'user', content: prompt }]);
  store.rename(unanswered.id, fallbackTitle(prompt));
  const chosen = store.create(root, 'scripted');
  store.append(chosen.id, [
    { id: 'u3', role: 'user', content: prompt },
    { id: 'a3', role: 'assistant', content: '好的。' },
  ]);
  store.rename(chosen.id, 'Custom name');
  const hi = store.create(root, 'scripted');
  store.append(hi.id, [
    { id: 'u4', role: 'user', content: 'hi' },
    { id: 'a4', role: 'assistant', content: 'hello' },
  ]);
  store.rename(hi.id, 'hi');
  store.close();
  const model = new TitleModel('done', 'Go 你好世界程序请求');
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    session: finished.id,
    headless: true,
    localContext: false,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  const titleCalls = () =>
    model.requests.filter(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    );
  assert.equal(titleCalls().length, 1);
  assert.match(String(titleCalls()[0]!.system), /natural topic/);
  assert.equal(runtime.store.get(finished.id)!.title, fallbackTitle(prompt));
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.store.get(finished.id)!.title, 'Go 你好世界程序');
  assert.equal(runtime.store.get(chosen.id)!.title, 'Custom name');
  assert.equal(runtime.store.get(hi.id)!.title, 'hi');
  const quiet = new TitleModel('done', 'should not be asked');
  const greeting = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: quiet,
    session: hi.id,
    headless: true,
    localContext: false,
    bundledExtensions: false,
  });
  cleanup(t, () => greeting.close());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quiet.requests.length, 0);
  assert.equal(greeting.store.get(hi.id)!.title, 'hi');
  const held = new TitleModel('done', 'should not be asked');
  const pending = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: held,
    session: unanswered.id,
    headless: true,
    localContext: false,
    bundledExtensions: false,
  });
  cleanup(t, () => pending.close());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(held.requests.length, 0);
  assert.equal(pending.store.get(unanswered.id)!.title, fallbackTitle(prompt));
});

test('opening a finished session replaces a cut-off or done-sounding title', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  const createFile = 'create hello.txt with hi and then leave it';
  const readme = '@README.md what is the first heading in this file please';
  const fib = 'hiFib demo of tail recursion that prints a few numbers';
  const making = store.create(root, 'scripted');
  store.append(making.id, [
    { id: 'u', role: 'user', content: createFile },
    { id: 'a', role: 'assistant', content: 'done' },
  ]);
  store.rename(making.id, 'Creating hello.txt with hi');
  const cut = store.create(root, 'scripted');
  store.append(cut.id, [
    { id: 'u2', role: 'user', content: readme },
    { id: 'a2', role: 'assistant', content: 'The first heading is Circle.' },
  ]);
  store.rename(cut.id, '@README.md what is the first heading in');
  const demo = store.create(root, 'scripted');
  store.append(demo.id, [
    { id: 'u3', role: 'user', content: fib },
    { id: 'a3', role: 'assistant', content: 'Here is the demo.' },
  ]);
  store.rename(demo.id, 'hiFib demo');
  const chosen = store.create(root, 'scripted');
  store.append(chosen.id, [
    { id: 'u4', role: 'user', content: createFile },
    { id: 'a4', role: 'assistant', content: 'done' },
  ]);
  store.rename(chosen.id, 'Creating hello.txt with hi', true);
  store.close();
  const open = (id: string, title: string) => {
    const model = new TitleModel('done', title);
    const runtime = new AgentRuntime({
      workspace: root,
      home: root,
      settings: defaultSettings(),
      model,
      session: id,
      headless: true,
      localContext: false,
      bundledExtensions: false,
    });
    cleanup(t, () => runtime.close());
    return { model, runtime };
  };
  const created = open(making.id, 'hello.txt creation request');
  assert.equal(
    created.model.requests.filter(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    ).length,
    1,
  );
  created.model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    created.runtime.store.get(making.id)!.title,
    'hello.txt creation request',
  );
  const heading = open(cut.id, 'README first heading');
  assert.equal(
    heading.model.requests.filter(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    ).length,
    1,
  );
  heading.model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    heading.runtime.store.get(cut.id)!.title,
    'README first heading',
  );
  const fibs = open(demo.id, 'Tail recursion demo');
  assert.equal(
    fibs.model.requests.filter(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    ).length,
    1,
  );
  fibs.model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fibs.runtime.store.get(demo.id)!.title, 'Tail recursion demo');
  const kept = open(chosen.id, 'should not be asked');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kept.model.requests.length, 0);
  assert.equal(
    kept.runtime.store.get(chosen.id)!.title,
    'Creating hello.txt with hi',
  );
});

test('opening repairs a mid-word cut, a shown cut, and a glued title', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  const fib = 'hiFib demonstration of tail recursion that prints a few numbers';
  const explain =
    'please explain to me briefly in two sentences how this works today';
  const demo = store.create(root, 'scripted');
  store.append(demo.id, [
    { id: 'u', role: 'user', content: fib },
    { id: 'a', role: 'assistant', content: 'Here is the demo.' },
  ]);
  store.rename(demo.id, 'hiFib demo');
  const shown = store.create(root, 'scripted');
  store.append(shown.id, [
    {
      id: 'u2',
      role: 'user',
      display: 'please explain to me briefly in two',
      content: explain,
    },
    { id: 'a2', role: 'assistant', content: 'Two sentences.' },
  ]);
  store.rename(shown.id, 'please explain to me briefly in two');
  const glued = store.create(root, 'scripted');
  store.append(glued.id, [
    { id: 'u3', role: 'user', content: 'hi' },
    { id: 'a3', role: 'assistant', content: 'Hello.' },
    { id: 'u4', role: 'user', content: 'Fib demo of tail recursion' },
    { id: 'a4', role: 'assistant', content: 'Here it is.' },
  ]);
  store.rename(glued.id, 'hiFib demo');
  store.close();
  for (const id of [demo.id, shown.id, glued.id]) {
    const model = new TitleModel('done', 'Tail recursion');
    const runtime = new AgentRuntime({
      workspace: root,
      home: root,
      settings: defaultSettings(),
      model,
      session: id,
      headless: true,
      localContext: false,
      bundledExtensions: false,
    });
    cleanup(t, () => runtime.close());
    assert.equal(
      model.requests.filter(
        (request) => request.maxTokens === Harness.titleOutputTokens,
      ).length,
      1,
    );
    model.releaseTitle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.store.get(id)!.title, 'Tail recursion');
  }
});

test('startup repairs a visible title and the resume line follows it', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  const explain =
    'please explain to me briefly in two sentences how this works today';
  const kept = store.create(root, 'title-model', 'older topic');
  store.append(kept.id, [
    {
      id: 'u2',
      role: 'user',
      content: 'an earlier question about the build system',
    },
    { id: 'a2', role: 'assistant', content: 'earlier' },
  ]);
  await delay(5);
  const cut = store.create(
    root,
    'title-model',
    'please explain to me briefly in two',
  );
  store.append(cut.id, [
    {
      id: 'u',
      role: 'user',
      display: 'please explain to me briefly in two',
      content: explain,
    },
    { id: 'a', role: 'assistant', content: 'Two sentences follow.' },
  ]);
  store.close();
  const settings = defaultSettings();
  const model = new TitleModel('done', 'Brief explanation');
  const app = new SessionApp(root, root, settings);
  const ui = app as unknown as {
    screen: { render: () => void };
    flashTimer?: ReturnType<typeof setTimeout>;
    input: { close: () => void };
    interactions: { close: () => void };
    off?: () => void;
    offSignals?: () => void;
  };
  ui.screen.render = () => {};
  await app.attach({
    workspace: root,
    home: root,
    settings,
    model,
    headless: true,
  });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    ui.interactions.close();
    await app.runtime?.close();
  });
  const titleCalls = () =>
    model.requests.filter(
      (request) => request.maxTokens === Harness.titleOutputTokens,
    );
  await until(() => titleCalls().length >= 1);
  assert.equal(
    app.runtime!.store.get(cut.id)!.title,
    'please explain to me briefly in two',
  );
  const order = app.runtime!.store.list().map((session) => session.id);
  assert.equal(order[0], cut.id);
  await app.submit(`/resume ${cut.id}`);
  assert.match(
    app.state.notices.at(-1) ?? '',
    /please explain to me briefly in two/,
  );
  model.releaseTitle();
  await until(
    () => app.runtime!.store.get(cut.id)!.title === 'Brief explanation',
  );
  await until(() =>
    (app.state.notices.at(-1) ?? '').includes('Brief explanation'),
  );
  assert.deepEqual(
    app.runtime!.store.list().map((session) => session.id),
    order,
  );
  assert.equal(app.runtime!.store.get(kept.id)!.title, 'older topic');
});
