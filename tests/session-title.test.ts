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
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
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
  TITLE_MAX_TOKENS,
  TITLE_MAX_WORDS,
  titleConversation,
  titleNeedsRefresh,
  titleRetrySystem,
  titleUnits,
  titleWorthy,
  userPrompts,
} from '../src/session_title.js';
import { ScriptedModel } from '../src/testing.js';
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
  assert.equal(fallbackTitle('@README.md'), '@README.md');
  assert.equal(
    fallbackTitle('ping me at a@b.com about the login'),
    'ping me at a@b.com about the login',
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
  assert.equal(sanitizeGeneratedTitle('请提供文件内容'), undefined);
  assert.equal(sanitizeGeneratedTitle('你可以粘贴一下'), undefined);
  assert.equal(titleWorthy('hi'), false);
  assert.equal(titleWorthy('hello there'), false);
  assert.equal(titleWorthy('ok'), false);
  assert.equal(titleWorthy('thanks'), false);
  assert.equal(titleWorthy('Thanks!'), false);
  assert.equal(titleWorthy('thanks a lot'), false);
  assert.equal(titleWorthy('what is TCP'), true);
  assert.equal(titleWorthy('focus test 1'), true);
  assert.equal(titleWorthy('what is TCP?'), true);
  assert.equal(titleWorthy('解释 React hooks'), true);
  assert.equal(titleWorthy('什么是 Rust'), true);
  assert.equal(titleWorthy('用Go写'), true);
  assert.equal(titleWorthy('hi there'), false);
  assert.equal(titleWorthy('你好'), false);
  assert.equal(titleUnits('你好啊'), 3);
  assert.equal(titleWorthy('你好啊'), false);
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
  /** Throw on this title call (1-based) and later, after the earlier ones return. */
  failTitleAfter = 0;
  /** Successive title replies. When empty, every title call returns `title`. */
  titles: string[] = [];
  private titleCalls = 0;
  thinking = '';
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const titleCall = request.maxTokens === TITLE_MAX_TOKENS;
    if (titleCall) {
      this.titleCalls++;
      if (this.failTitle) throw new Error('title exploded');
      if (this.failTitleAfter && this.titleCalls >= this.failTitleAfter)
        throw new Error('title exploded');
      await this.gate;
    }
    const content = titleCall
      ? (this.titles.shift() ?? this.title)
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
  assert.equal(store.get(session.id)!.title, '');
  const titleCalls = model.requests.filter(
    (request) => request.maxTokens === TITLE_MAX_TOKENS,
  );
  assert.equal(titleCalls.length, 1);
  assert.equal(titleCalls[0]!.effort, '');
  assert.equal(titleCalls[0]!.tools.length, 0);
  assert.equal(titleCalls[0]!.messages[0]!.content, titleConversation(LONG));
  assert.match(String(titleCalls[0]!.system), /Do not answer it/);
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

test('a model title is asked for three words, and a greeting stays local', () => {
  assert.equal(titleWorthy('hi'), false);
  assert.equal(titleWorthy('ok'), false);
  assert.equal(titleWorthy('thanks'), false);
  assert.equal(titleWorthy('Thanks!'), false);
  assert.equal(titleWorthy('thanks a lot'), false);
  assert.equal(titleWorthy('hello there'), false);
  assert.equal(titleWorthy('hi there'), false);
  assert.equal(titleUnits('hi there'), 2);
  assert.equal(titleWorthy('what is TCP'), true);
  assert.equal(titleUnits('what is TCP'), 3);
  assert.equal(titleWorthy('what is TCP?'), true);
  assert.equal(titleWorthy('解释 React hooks'), true);
  assert.equal(titleUnits('解释 React hooks'), 4);
  assert.equal(titleWorthy('什么是 Rust'), true);
  assert.equal(titleUnits('什么是 Rust'), 4);
  assert.equal(titleWorthy('用Go写'), true);
  assert.equal(titleUnits('用Go写'), 3);
  assert.equal(titleUnits('你好啊'), 3);
  assert.equal(titleWorthy('你好啊'), false);
  assert.equal(titleWorthy('你好'), false);
  assert.equal(titleWorthy('README.md what is this'), true);
  assert.equal(titleWorthy('@README.md what is this'), true);
  assert.equal(titleWorthy('fix the login bug now!!'), true);
  assert.equal(titleWorthy('   '), false);
  const cjk = '帮我把桌面端会话标题改成一句短摘要不要把整段提示放进侧边栏';
  assert.ok(cjk.length >= 24);
  assert.equal(cjk.split(' ').length, 1);
  assert.equal(titleWorthy(cjk), true);
  const rome = '请用大约200字介绍一下罗马帝国的兴衰';
  assert.ok(rome.length < 24);
  assert.equal(rome.split(' ').length, 1);
  assert.equal(titleWorthy(rome), true);
  assert.equal(titleWorthy('你好'), false);
  assert.equal(titleWorthy('你好世界'), true);
  assert.equal(titleWorthy('罗马帝国兴衰'), true);
  assert.equal(titleWorthy('帮我写一个你好世界的Go程序'), true);
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
  await run.run('hi');
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'hi');
  assert.equal(
    model.requests.filter((request) => request.maxTokens === TITLE_MAX_TOKENS)
      .length,
    0,
  );
  assert.deepEqual(notes, []);
});

test('a short Chinese sentence asks for a title in that language', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', '罗马帝国兴衰简介');
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const prompt = '请用大约200字介绍一下罗马帝国的兴衰';
  assert.equal(fallbackTitle(prompt), '用大约200字介绍一下罗马帝国的兴衰');
  await run.run(prompt);
  assert.equal(store.get(session.id)!.title, '');
  const title = model.requests.find(
    (request) => request.maxTokens === TITLE_MAX_TOKENS,
  );
  assert.ok(title);
  assert.equal(title.messages[0]!.content, titleConversation(prompt));
  assert.match(String(title.system), /Chinese title/);
  assert.match(String(title.system), /罗马帝国简介/);
  assert.match(String(title.system), /Go 你好世界/);
  assert.match(String(title.system), /Do not answer it/);
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, '罗马帝国兴衰简介');
});

test('a skipped or failed title is reported when debug logging is on', async (t) => {
  const previous = process.env.CIRCLE_DEBUG;
  const logged: string[] = [];
  const errors = console.error;
  delete process.env.CIRCLE_DEBUG;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  cleanup(t, () => {
    if (previous === undefined) delete process.env.CIRCLE_DEBUG;
    else process.env.CIRCLE_DEBUG = previous;
    console.error = errors;
  });
  const quiet = scratch(t);
  const quietModel = new TitleModel('done', 'unused');
  const quietRun = harness(quiet, quietModel);
  cleanup(t, () => quietRun.store.close());
  await quietRun.harness.run('hi');
  assert.equal(logged.length, 0);
  process.env.CIRCLE_DEBUG = '1';
  const root = scratch(t);
  const model = new TitleModel('done', 'Login bug fix');
  const skipped = harness(root, model);
  cleanup(t, () => skipped.store.close());
  await skipped.harness.run('hi');
  assert.match(
    logged.join('\n'),
    /\[circle\] title: skipped \(prompt too short\)/,
  );
  logged.length = 0;
  const failedRoot = scratch(t);
  const failedModel = new TitleModel('done', 'Login bug fix');
  failedModel.failTitle = true;
  const failed = harness(failedRoot, failedModel);
  cleanup(t, () => failed.store.close());
  await failed.harness.run(LONG);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(logged.join('\n'), /\[circle\] title: failed: title exploded/);
});

test('four words ask for a title even when the prompt is short', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', 'Readme heading');
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const prompt = 'README.md what is this';
  assert.ok(prompt.length < 24);
  assert.equal(prompt.split(' ').length, 4);
  await run.run(prompt);
  assert.equal(store.get(session.id)!.title, '');
  assert.equal(
    model.requests.filter((request) => request.maxTokens === TITLE_MAX_TOKENS)
      .length,
    1,
  );
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'Readme heading');
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
  assert.equal(store.get(session.id)!.title, '');
  assert.equal(
    model.requests.filter((request) => request.maxTokens === TITLE_MAX_TOKENS)
      .length,
    1,
  );
  assert.equal(
    model.requests.find((request) => request.maxTokens === TITLE_MAX_TOKENS)!
      .messages[0]!.content,
    titleConversation(prompt),
  );
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'TCP overview');
  assert.deepEqual(notes, []);
});

test('a recased question is not a title, and a noun phrase is', () => {
  const tcp = 'what is TCP';
  assert.equal(echoesPrompt('What is TCP', tcp), true);
  assert.equal(echoesPrompt('What is TCP?', tcp), true);
  assert.equal(echoesPrompt('what is TCP!', tcp), true);
  assert.equal(echoesPrompt('TCP overview', tcp), false);
  assert.equal(echoesPrompt('什么是 rust', '什么是 Rust'), true);
  assert.equal(echoesPrompt('Rust 简介', '什么是 Rust'), false);
  assert.equal(
    acceptGeneratedTitle('What is TCP', tcp).reason,
    'echoes prompt',
  );
  assert.equal(acceptGeneratedTitle('What is TCP', tcp).title, undefined);
  assert.equal(
    acceptGeneratedTitle('What is TCP?', tcp).reason,
    'echoes prompt',
  );
  assert.equal(acceptGeneratedTitle('TCP overview', tcp).title, 'TCP overview');
  assert.equal(
    acceptGeneratedTitle('Rust intro', 'what is Rust').title,
    'Rust intro',
  );
  assert.equal(
    acceptGeneratedTitle('What is Rust', 'what is Rust').reason,
    'echoes prompt',
  );
  assert.equal(
    acceptGeneratedTitle('React hooks 解释', '解释 React hooks').title,
    'React hooks 解释',
  );
  assert.equal(
    acceptGeneratedTitle('Rust 语言简介', '什么是 Rust').title,
    'Rust 语言简介',
  );
  const system = 'You are a title generator.';
  const retry = titleRetrySystem(system);
  assert.equal(retry.startsWith(`${system}\n\n`), true);
  assert.match(retry, /TCP overview/);
  assert.match(retry, /capitalization or punctuation/);
  assert.equal(
    titleNeedsRefresh(
      'Creating hello.txt with hi',
      'create hello.txt with hi and then leave it',
    ),
    true,
  );
  assert.equal(titleNeedsRefresh('hi', 'hi'), false);
  assert.equal(
    titleNeedsRefresh('Custom name', '帮我写一个你好世界的Go程序'),
    false,
  );
  assert.equal(
    titleNeedsRefresh('hiFib demo', 'hi', [
      'show a Fib demo of tail recursion',
    ]),
    true,
  );
  assert.equal(
    titleNeedsRefresh(
      'please explain to me briefly in two',
      'Please explain to me briefly, in two sentences, how this works today.',
    ),
    true,
  );
  assert.equal(
    titleNeedsRefresh(
      'please explain to me briefly in two',
      'explain to me briefly, in two sentences, how this works today',
    ),
    true,
  );
  assert.equal(
    titleNeedsRefresh('higher order functions', 'hi', [
      'show a Fib demo of tail recursion',
    ]),
    false,
  );
  assert.equal(titleNeedsRefresh('TCP overview', 'what is TCP'), false);
  assert.equal(
    titleNeedsRefresh('React hooks 解释', '解释 React hooks'),
    false,
  );
  assert.equal(titleNeedsRefresh('Rust 语言简介', '什么是 Rust'), false);
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
  assert.deepEqual(
    userPrompts([
      {
        role: 'user',
        display: 'please explain to me briefly in two',
        content:
          'Please explain to me briefly, in two sentences, how this works today.',
      },
    ]),
    ['Please explain to me briefly, in two sentences, how this works today.'],
  );
});

test('an echoed question is asked once more, then left untitled', async (t) => {
  const prompt = 'what is TCP';
  const root = scratch(t);
  const model = new TitleModel('done', 'unused');
  model.titles = ['What is TCP', 'TCP overview'];
  const { harness: run, store, session } = harness(root, model);
  cleanup(t, () => store.close());
  const notes: string[] = [];
  run.bus.subscribe((event) => {
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push(String(notice.message));
  });
  await run.run(prompt);
  assert.equal(store.get(session.id)!.title, '');
  model.releaseTitle();
  await run.finishTitle();
  const calls = model.requests.filter(
    (request) => request.maxTokens === TITLE_MAX_TOKENS,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.messages[0]!.content, titleConversation(prompt));
  assert.equal(calls[1]!.messages[0]!.content, titleConversation(prompt));
  assert.equal(calls[1]!.effort, '');
  assert.equal(calls[1]!.tools.length, 0);
  assert.match(String(calls[1]!.system), /TCP overview/);
  assert.match(String(calls[1]!.system), /capitalization or punctuation/);
  assert.equal(
    String(calls[1]!.system),
    titleRetrySystem(String(calls[0]!.system)),
  );
  assert.equal(store.get(session.id)!.title, 'TCP overview');
  assert.deepEqual(notes, []);

  const again = scratch(t);
  const echo = new TitleModel('done', 'unused');
  echo.titles = ['What is TCP', 'what is TCP?'];
  const second = harness(again, echo);
  cleanup(t, () => second.store.close());
  const quiet: string[] = [];
  second.harness.bus.subscribe((event) => {
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') quiet.push(String(notice.message));
  });
  await second.harness.run(prompt);
  echo.releaseTitle();
  await second.harness.finishTitle();
  assert.equal(second.store.get(second.session.id)!.title, '');
  assert.deepEqual(quiet, []);

  const bad = scratch(t);
  const answered = new TitleModel('done', 'unused');
  answered.titles = [
    'What is TCP',
    "I don't see any README.md content attached to your message. Could you paste the file?",
  ];
  const third = harness(bad, answered);
  cleanup(t, () => third.store.close());
  const failed: string[] = [];
  third.harness.bus.subscribe((event) => {
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') failed.push(String(notice.message));
  });
  await third.harness.run(prompt);
  answered.releaseTitle();
  await third.harness.finishTitle();
  assert.equal(third.store.get(third.session.id)!.title, fallbackTitle(prompt));
  assert.deepEqual(failed, ['not a title']);
  assert.equal(
    answered.requests.filter(
      (request) => request.maxTokens === TITLE_MAX_TOKENS,
    ).length,
    2,
  );

  const thrown = scratch(t);
  const boom = new TitleModel('done', 'What is Rust');
  boom.failTitleAfter = 2;
  const fourth = harness(thrown, boom);
  cleanup(t, () => fourth.store.close());
  const errors: string[] = [];
  fourth.harness.bus.subscribe((event) => {
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') errors.push(String(notice.message));
  });
  await fourth.harness.run('what is Rust');
  boom.releaseTitle();
  await fourth.harness.finishTitle();
  assert.equal(
    fourth.store.get(fourth.session.id)!.title,
    fallbackTitle('what is Rust'),
  );
  assert.match(errors[0] ?? '', /title exploded/);
});

test('a mixed Chinese and English prompt asks for a title', async (t) => {
  const cases = [
    ['解释 React hooks', 'React hooks'],
    ['什么是 Rust', 'Rust overview'],
    ['用Go写', 'Go program'],
  ] as const;
  for (const [prompt, title] of cases) {
    assert.ok(titleUnits(prompt) >= 3, prompt);
    assert.equal(titleWorthy(prompt), true, prompt);
    const root = scratch(t);
    const model = new TitleModel('done', title);
    const { harness: run, store, session } = harness(root, model);
    cleanup(t, () => store.close());
    const notes: string[] = [];
    run.bus.subscribe((event) => {
      const notice = event.payload.model_notice as
        { event?: string; message?: string } | undefined;
      if (notice?.event === 'title_failed') notes.push(String(notice.message));
    });
    await run.run(prompt);
    assert.equal(store.get(session.id)!.title, '', prompt);
    assert.equal(
      model.requests.filter((request) => request.maxTokens === TITLE_MAX_TOKENS)
        .length,
      1,
      prompt,
    );
    model.releaseTitle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.get(session.id)!.title, title, prompt);
    assert.deepEqual(notes, []);
  }
  for (const prompt of ['hi there', 'thanks', '你好', '你好啊'] as const) {
    assert.equal(titleWorthy(prompt), false, prompt);
    const root = scratch(t);
    const model = new TitleModel('done', 'Should not appear');
    const { harness: run, store, session } = harness(root, model);
    cleanup(t, () => store.close());
    await run.run(prompt);
    model.releaseTitle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      model.requests.filter((request) => request.maxTokens === TITLE_MAX_TOKENS)
        .length,
      0,
      prompt,
    );
    assert.notEqual(store.get(session.id)!.title, 'Should not appear', prompt);
  }
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
  assert.equal(
    model.requests.filter((request) => request.maxTokens === TITLE_MAX_TOKENS)
      .length,
    1,
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
  assert.equal(
    model.requests.filter((request) => request.maxTokens === TITLE_MAX_TOKENS)
      .length,
    1,
  );
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
    model.requests.find((request) => request.maxTokens === TITLE_MAX_TOKENS)!
      .messages[0]!.content,
    /^<conversation>\n/,
  );
  assert.equal(
    model.requests.filter((request) => request.maxTokens === TITLE_MAX_TOKENS)
      .length,
    1,
  );
});

test('thinking text is not used as the title', async (t) => {
  const root = scratch(t);
  const model = new TitleModel('done', '');
  model.thinking = 'The user is asking about a README.md file - they';
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

test('an anthropic title call waits out the turn and disables thinking', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  let answerSent = false;
  const instance = createServer(async (request, response) => {
    const body = await readBody(request);
    bodies.push(body);
    const title = body.max_tokens === TITLE_MAX_TOKENS;
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
  const title = bodies.find((body) => body.max_tokens === TITLE_MAX_TOKENS);
  assert.ok(title);
  assert.equal(title!.output_config, undefined);
  assert.deepEqual(title!.thinking, { type: 'disabled' });
  assert.equal(title!.model, 'glm-5.3');
  assert.match(String(title!.system), /Do not answer it/);
  assert.match(JSON.stringify(title!.messages), /<conversation>\\nPlease list/);
  assert.match(
    JSON.stringify(title!.messages),
    /explain each\\n<\/conversation>/,
  );
  assert.equal(bodies[0]!.max_tokens === TITLE_MAX_TOKENS, false);
});

test('a thinking-only title keeps the fallback and is reported', async (t) => {
  let answerSent = false;
  const instance = createServer(async (request, response) => {
    const body = await readBody(request);
    const title = body.max_tokens === TITLE_MAX_TOKENS;
    if (title) {
      assert.equal(answerSent, true);
      assert.equal(body.output_config, undefined);
      assert.deepEqual(body.thinking, { type: 'disabled' });
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
  const notes: string[] = [];
  run.bus.subscribe((event) => {
    const notice = event.payload.model_notice as
      { event?: string; message?: string } | undefined;
    if (notice?.event === 'title_failed') notes.push(String(notice.message));
  });
  const result = await run.run(LIVE);
  assert.equal(result.answer, 'listed');
  for (let i = 0; i < 20 && !notes.length; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, fallbackTitle(LIVE));
  assert.notEqual(fallbackTitle(LIVE), 'Workspace file list');
  assert.equal(notes[0], 'empty title');
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
  const title = model.requests.find(
    (request) => request.maxTokens === TITLE_MAX_TOKENS,
  );
  assert.ok(title);
  assert.equal(title!.effort, '');
  model.releaseTitle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(session.id)!.title, 'Login bug fix');
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
    model.requests.filter((request) => request.maxTokens === TITLE_MAX_TOKENS)
      .length,
    0,
  );
  assert.match(notes[0] ?? '', /no side request/);
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

test('Chinese prompts are titled from the model over a real HTTP server', async (t) => {
  const rome = '请用大约200字介绍一下罗马帝国的兴衰';
  const go = '帮我写一个你好世界的Go程序';
  const bodies: Record<string, unknown>[] = [];
  const instance = createServer(async (request, response) => {
    const body = await readBody(request);
    bodies.push(body);
    const title = body.max_tokens === TITLE_MAX_TOKENS;
    const conversation = JSON.stringify(body.messages ?? '');
    const text = !title
      ? '好的。'
      : conversation.includes('你好世界')
        ? '你好世界 Go 程序'
        : '罗马帝国兴衰';
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
        delta: { type: 'text_delta', text },
      });
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      });
      event('message_stop', { type: 'message_stop' });
    });
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
  const runPrompt = async (prompt: string, expected: string) => {
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
    const notes: string[] = [];
    run.bus.subscribe((event) => {
      const notice = event.payload.model_notice as
        { event?: string; message?: string } | undefined;
      if (notice?.event === 'title_failed') notes.push(String(notice.message));
    });
    const result = await run.run(prompt);
    assert.equal(result.answer, '好的。');
    for (let i = 0; i < 20; i++) {
      if (store.get(session.id)!.title === expected) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(store.get(session.id)!.title, expected);
    assert.notEqual(store.get(session.id)!.title, fallbackTitle(prompt));
    assert.deepEqual(notes, []);
  };
  await runPrompt(rome, '罗马帝国兴衰');
  await runPrompt(go, '你好世界 Go 程序');
  const titles = bodies.filter((body) => body.max_tokens === TITLE_MAX_TOKENS);
  assert.equal(titles.length, 2);
  for (const title of titles) {
    assert.equal(title.output_config, undefined);
    assert.deepEqual(title.thinking, { type: 'disabled' });
    assert.equal(title.max_tokens, TITLE_MAX_TOKENS);
    assert.match(String(title.system), /Chinese title/);
    assert.match(String(title.system), /Do not answer it/);
  }
  const wire = JSON.stringify(titles.map((body) => body.messages));
  assert.match(wire, /<conversation>\\n请用大约200字介绍一下罗马帝国的兴衰\\n/);
  assert.match(wire, /<conversation>\\n帮我写一个你好世界的Go程序\\n/);
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
