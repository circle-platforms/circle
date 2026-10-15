import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { Harness } from '../src/harness.js';
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
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (request.effort === 'minimal') await this.gate;
    const content = request.effort === 'minimal' ? this.title : this.answer;
    if (content && request.effort !== 'minimal') request.token(content);
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
    model.requests.filter((request) => request.effort === 'minimal').length,
    1,
  );
  assert.equal(model.requests.filter((request) => !request.effort).length, 1);
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
    model.requests.filter((request) => request.effort === 'minimal').length,
    0,
  );
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
