import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeProvider } from '../src/app/context.tsx';
import { setLanguage } from '../src/i18n/index.ts';
import { PreviewRuntime } from '../src/model/state.ts';
import type { RuntimeExtension } from '../src/model/types.ts';
import { Markdown } from '../src/components/Markdown.tsx';
import { HubPage, hubSignInError } from '../src/plugins/hub.tsx';
import { shellPageTitle } from '../src/plugins/labels.ts';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const memory = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };
};

function draw(
  extension: RuntimeExtension | undefined,
  box: ReturnType<typeof memoryStorage>,
) {
  const runtime = new PreviewRuntime(box);
  if (extension)
    runtime.change((state) => {
      state.extensions = [extension];
    });
  return renderToStaticMarkup(
    createElement(RuntimeProvider, {
      runtime,
      children: createElement(HubPage, { sessionId: 'session1', storage: box }),
    }),
  );
}

const hub = (view: Record<string, unknown> | undefined): RuntimeExtension => ({
  id: 'hub',
  name: 'hub',
  version: '0.1.0',
  scope: 'bundled',
  enabled: true,
  tools: [],
  commands: ['hub'],
  events: [],
  ...(view ? { view } : {}),
});

test('the hub page keeps the last server and user, and signs in as a state', () => {
  const box = memoryStorage({
    'circle.workbench.hub.login.v1': JSON.stringify({
      url: 'http://hub.example:9',
      username: 'ada',
    }),
  });
  const signedOut = draw(
    hub({
      url: 'http://127.0.0.1:7410',
      username: '',
      scopeId: '',
      signedIn: false,
      following: [],
      tasks: [],
      recent: [],
    }),
    box,
  );
  assert.match(signedOut, /value="http:\/\/hub\.example:9"/);
  assert.match(signedOut, /value="ada"/);
  assert.match(signedOut, /type="password"/);

  const signedIn = draw(
    hub({
      url: 'http://hub.example:9',
      username: 'ada',
      scopeId: 'scp_lab',
      signedIn: true,
      following: [],
      tasks: [],
      recent: ['saved a result'],
      inbox: [
        {
          kind: 'governance',
          requestId: 'aprq_1',
          taskId: '',
          approvalId: '',
          title: 'export the register',
        },
      ],
      knowledge: {
        query: 'register',
        items: [
          {
            recordId: 'knr_1',
            snapshotId: 'knr_snap',
            title: 'the register',
          },
        ],
      },
    }),
    memoryStorage(),
  );
  assert.doesNotMatch(signedIn, /type="password"/);
  assert.match(signedIn, /sign out/);
  assert.match(signedIn, /export the register/);
  assert.match(signedIn, /search knowledge/);
  assert.match(signedIn, /the register/);
  assert.match(signedIn, /knr_snap/);
  assert.match(signedIn, /saved a result/);
});

test('the hub page title is the translated name', () => {
  const box = memoryStorage();
  setLanguage('zh-CN', box as unknown as Storage);
  try {
    assert.equal(shellPageTitle('hub'), '枢纽');
    assert.equal(shellPageTitle('sessions'), '会话');
    assert.equal(shellPageTitle('knowledge'), '知识');
    const html = draw(
      hub({
        url: 'http://hub.example:9',
        username: 'ada',
        scopeId: '',
        signedIn: true,
        following: [],
        tasks: [],
        recent: [],
        inbox: [],
      }),
      box,
    );
    assert.match(html, /<h1>枢纽<\/h1>/);
    assert.match(html, /退出/);
    assert.match(html, /收件箱/);
    assert.match(html, /没有等你处理的/);
    assert.match(html, /搜索知识/);
    assert.match(html, /hub-actions/);
    const inbox = draw(
      hub({
        url: 'http://hub.example:9',
        username: 'ada',
        scopeId: '',
        signedIn: true,
        following: [],
        tasks: [],
        recent: [],
        inbox: [
          {
            kind: 'change-set',
            requestId: 'apr_9',
            taskId: 'task_ask',
            approvalId: 'apr_9',
            title: 'Review asset change set',
            messageZh: '审核资产变更集',
            status: 'waiting-review',
          },
        ],
      }),
      box,
    );
    assert.match(inbox, /审核资产变更集/);
    assert.equal(inbox.includes('Review asset change set'), false);
    assert.match(inbox, /变更集/);
    assert.match(inbox, /待审核/);
    assert.equal(inbox.includes('change-set'), false);
    assert.equal(inbox.includes('waiting-review'), false);
    const fresh = memoryStorage();
    setLanguage('zh-CN', fresh as unknown as Storage);
    const empty = draw(hub(undefined), fresh);
    assert.match(empty, /尚未登录/);
    assert.equal(empty.includes('枢纽扩展还没有发布任何内容'), false);
    assert.equal(
      hubSignInError(
        '登录被拒绝（UNAUTHENTICATED）。请核对用户和密码，然后重新 /hub login。',
      ),
      '用户名或密码不对',
    );
    assert.equal(
      hubSignInError('无法连接服务器 http://127.0.0.1:9'),
      '无法连接服务器 http://127.0.0.1:9',
    );
  } finally {
    setLanguage('en', box as unknown as Storage);
  }
});
test('a desktop autolink stops before a fullwidth comma', () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      text: '已登录 http://127.0.0.1:7410，用户 ada',
    }),
  );
  assert.match(html, /href="http:\/\/127\.0\.0\.1:7410"/);
  assert.equal(/href="[^"]*[，用户]/.test(html), false);
  assert.match(html, /，用户 ada/);
});
