import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/i18n/index.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import { LiveRuntime } from '../src/model/live.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type {
  RuntimeCommand,
  RuntimeReply,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol.ts';
import {
  botIdentityKey,
  classifyRemoteBotFailure,
  deliveryText,
  formatRemoteBotNotice,
  isHubConnected,
  mergeDeliveryStates,
  nextBotRetryDelay,
  shouldOpenInitialConnectionModal,
  stripInvokeErrorPrefix,
  translateBotTransferError,
} from '../src/model/remote-bot.ts';

test('isHubConnected matches only a connected Hub entry', () => {
  assert.equal(isHubConnected({ mcp: [] }), false);
  assert.equal(
    isHubConnected({
      mcp: [
        {
          id: 'hub',
          name: 'Hub',
          url: 'https://127.0.0.1:7420/mcp',
          transport: 'streamable_http',
          command: '',
          args: '',
          enabled: true,
          status: 'not connected',
          tools: [],
        },
      ],
    }),
    false,
  );
  assert.equal(
    isHubConnected({
      mcp: [
        {
          id: 'hub',
          name: 'Hub',
          url: 'https://127.0.0.1:7420/mcp',
          transport: 'streamable_http',
          command: '',
          args: '',
          enabled: true,
          status: 'connected',
          tools: [],
        },
      ],
    }),
    true,
  );
});

test('mergeDeliveryStates combines message and attachment delivery states', () => {
  assert.deepEqual(
    mergeDeliveryStates({
      deliveries: [{ id: 'ev-1', state: 'sent' }],
      fileDeliveries: [
        { id: 'ev-1', slot: 0, state: 'queued' },
        { id: 'ev-2', slot: 1, state: 'unknown' },
      ],
    }),
    {
      'ev-1': 'sent',
      'ev-1:0': 'queued',
      'ev-2:1': 'unknown',
    },
  );
});

test('deliveryText translates known delivery states in zh-CN and keeps English keys', (context) => {
  context.after(() => setLanguage('en'));
  assert.equal(deliveryText(null), null);
  assert.equal(deliveryText('other'), null);
  setLanguage('en');
  assert.equal(deliveryText('sent'), 'private chat acknowledged');
  assert.equal(deliveryText('unknown'), 'private chat delivery unknown');
  setLanguage('zh-CN');
  assert.equal(deliveryText('sent'), '企微已确认接收');
  assert.equal(deliveryText('unknown'), '企微送达未知');
  assert.equal(deliveryText('refused'), '企微未送达');
  assert.equal(deliveryText('unbound'), '尚未绑定企微身份');
  assert.equal(deliveryText('queued'), '等待企微送达');
});

test('botIdentityKey distinguishes bindings, bot ids and conversations', () => {
  const a = botIdentityKey({ binding: 'b1', id: 'bot', current: 'c1' });
  const b = botIdentityKey({ binding: 'b1', id: 'bot', current: 'c2' });
  assert.notEqual(a, b);
});

test('stripInvokeErrorPrefix strips Electron IPC invoke prefix', () => {
  assert.equal(
    stripInvokeErrorPrefix(
      "Error invoking remote method 'circle:attach-bot-files': Error: select up to eight files",
    ),
    'select up to eight files',
  );
  assert.equal(
    stripInvokeErrorPrefix(
      "Error invoking remote method 'circle:save-bot-file': file unavailable",
    ),
    'file unavailable',
  );
  assert.equal(stripInvokeErrorPrefix('plain error'), 'plain error');
});

test('nextBotRetryDelay uses bounded exponential backoff from 1s to 30s', () => {
  assert.equal(nextBotRetryDelay(0), 1000);
  assert.equal(nextBotRetryDelay(1000), 2000);
  assert.equal(nextBotRetryDelay(2000), 4000);
  assert.equal(nextBotRetryDelay(4000), 8000);
  assert.equal(nextBotRetryDelay(8000), 16000);
  assert.equal(nextBotRetryDelay(16000), 30000);
  assert.equal(nextBotRetryDelay(30000), 30000);
});

test('classifyRemoteBotFailure maps distinct titles, causes, actions, and retryability in en and zh-CN', (t) => {
  t.after(() => setLanguage('en'));
  const makeErr = (
    status: number | undefined,
    code: string | undefined,
    message: string,
    detail?: string,
  ) => Object.assign(new Error(message), { status, code, detail });

  for (const lang of ['en', 'zh-CN'] as const) {
    setLanguage(lang);
    const nonTransientCases = [
      {
        err: makeErr(409, 'BOT_VERSION_MISMATCH', 'client too old'),
        kind: 'version-mismatch',
        retryable: false,
      },
      {
        err: makeErr(400, 'BOT_VERSION_INVALID', 'bad version'),
        kind: 'version-invalid',
        retryable: false,
      },
      {
        err: makeErr(503, 'BOT_DISABLED', 'disabled by admin'),
        kind: 'disabled',
        retryable: false,
      },
      {
        err: makeErr(403, 'BOT_CLIENT_FORBIDDEN', 'oauth client forbidden'),
        kind: 'oauth-forbidden',
        retryable: false,
      },
      {
        err: makeErr(401, 'BOT_UNAUTHENTICATED', 'token revoked'),
        kind: 'auth',
        retryable: false,
      },
    ] as const;

    const renderedTitles = new Set<string>();
    const renderedCauses = new Set<string>();
    const renderedActions = new Set<string>();
    for (const c of nonTransientCases) {
      const classified = classifyRemoteBotFailure(c.err);
      assert.equal(classified.kind, c.kind);
      assert.equal(classified.retryable, c.retryable);
      assert.ok(classified.title.length > 0);
      assert.ok(classified.cause.length > 0);
      assert.ok(classified.action.length > 0);
      renderedTitles.add(classified.title);
      renderedCauses.add(classified.cause);
      renderedActions.add(classified.action);
    }
    assert.equal(renderedTitles.size, nonTransientCases.length);
    assert.equal(renderedCauses.size, nonTransientCases.length);
    assert.equal(renderedActions.size, nonTransientCases.length);

    // Status 401 always takes precedence over BOT_CLIENT_FORBIDDEN code.
    const authWithForbiddenCode = classifyRemoteBotFailure(
      makeErr(401, 'BOT_CLIENT_FORBIDDEN', 'expired session'),
    );
    assert.equal(authWithForbiddenCode.kind, 'auth');
    assert.equal(authWithForbiddenCode.retryable, false);

    // 403 BOT_CLIENT_FORBIDDEN action honestly instructs adding Bearer token in settings.json.
    const forbidden = classifyRemoteBotFailure(
      makeErr(403, 'BOT_CLIENT_FORBIDDEN', 'oauth client token rejected'),
    );
    assert.match(forbidden.action, /settings\.json/);
    assert.match(forbidden.action, /Authorization|Bearer/);

    // Transient codes/statuses including 408, 429 BOT_BUSY, 500, 502, 503, 504, undefined.
    for (const transientErr of [
      makeErr(408, 'BOT_REQUEST_TIMEOUT', 'timed out'),
      makeErr(429, 'BOT_BUSY', 'queue full'),
      makeErr(500, undefined, 'internal error'),
      makeErr(502, undefined, 'remote bot unavailable'),
      makeErr(503, undefined, 'temporarily unavailable'),
      makeErr(504, undefined, 'gateway timeout'),
      makeErr(undefined, undefined, 'network failure'),
    ]) {
      const classified = classifyRemoteBotFailure(transientErr);
      assert.equal(classified.kind, 'transient');
      assert.equal(classified.retryable, true);
    }

    // Request/resource non-retryable failures.
    assert.equal(
      classifyRemoteBotFailure(
        makeErr(413, 'BOT_QUOTA_EXCEEDED', 'quota exceeded'),
      ).retryable,
      false,
    );
    assert.equal(
      classifyRemoteBotFailure(
        makeErr(404, 'BOT_NOT_FOUND', 'conversation not found'),
      ).retryable,
      false,
    );
    assert.equal(
      classifyRemoteBotFailure(
        makeErr(409, 'BOT_CONFLICT', 'duplicate request id conflict'),
      ).retryable,
      false,
    );
    const integrity = classifyRemoteBotFailure(
      makeErr(422, 'BOT_INVALID_REQUEST', 'attachment_integrity_failed'),
    );
    assert.equal(integrity.kind, 'other');
    assert.equal(integrity.retryable, false);

    if (lang === 'zh-CN') {
      assert.equal(authWithForbiddenCode.title, '机器人登录已过期');
      assert.match(forbidden.action, /settings\.json.*headers\.Authorization/);
      assert.equal(
        classifyRemoteBotFailure(makeErr(429, 'BOT_BUSY', 'busy')).title,
        '机器人请求繁忙',
      );
      assert.equal(
        classifyRemoteBotFailure(makeErr(503, 'BOT_DISABLED', 'disabled'))
          .title,
        '我的机器人已停用',
      );
      assert.equal(integrity.title, '附件完整性校验失败');
    }
  }
});

test('R1: formatRemoteBotNotice translates all 23 notice codes and English fallbacks', (t) => {
  t.after(() => setLanguage('en'));
  const codes = [
    [
      'help',
      'send text or files to chat with your personal bot. send /new for a new conversation, or /stop to cancel the active reply.',
    ],
    ['conversation_started', 'started a new conversation'],
    ['stop_requested', 'requested stop for active reply'],
    ['stop_idle', 'no active reply to stop'],
    [
      'disabled_queued',
      'bot model is disabled; queued message was not executed',
    ],
    ['bot_disabled_aborted', 'bot model was disabled; active reply stopped'],
    ['credential_blocked', 'message cannot contain bot credentials'],
    ['reply_stopped', 'reply stopped'],
    [
      'host_restarted_queued',
      'host restarted while queued; message not executed',
    ],
    [
      'host_restarted_interrupted',
      'host restarted; previous request outcome unknown',
    ],
    ['bot_not_enabled', 'bot model is not enabled'],
    ['model_invalid_question', 'model did not provide a valid question'],
    ['model_credentials_blocked', 'model reply contained credentials'],
    ['model_empty_reply', 'model returned an empty reply'],
    ['model_auth_failed', 'model endpoint rejected credentials'],
    ['model_id_unavailable', 'model id is unavailable'],
    ['model_not_found', 'endpoint or model not found'],
    ['model_unreachable', 'model endpoint unreachable or timed out'],
    ['model_invalid_reply', 'model did not return a valid reply'],
    ['attachment_integrity_failed', 'attachment integrity check failed'],
    ['invalid_attachment_digest', 'invalid attachment digest'],
    ['attachment_unavailable', 'attachment could not be read'],
    ['reply_interrupted', 'model reply interrupted; outcome unknown'],
  ] as const;

  setLanguage('zh-CN');
  for (const [code, fallback] of codes) {
    const byCode = formatRemoteBotNotice(code, 'custom raw text');
    const byFallback = formatRemoteBotNotice(undefined, fallback);
    assert.equal(byCode, byFallback);
    assert.notEqual(byCode, fallback);
    assert.notEqual(byCode, 'custom raw text');
  }
  assert.equal(
    formatRemoteBotNotice(undefined, 'unrecognized notice'),
    'unrecognized notice',
  );
});

test('S11/S12: translateBotTransferError localizes transfer errors, HTTP metadata, and partial batches', (t) => {
  t.after(() => setLanguage('en'));
  setLanguage('zh-CN');

  assert.equal(
    translateBotTransferError(new Error('remote bot unavailable'), 'fallback'),
    '远程机器人暂不可用',
  );
  assert.equal(
    translateBotTransferError(new Error('fetch failed'), 'fallback'),
    '网络请求失败',
  );
  assert.equal(
    translateBotTransferError(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
      'fallback',
    ),
    '操作因超时已中止',
  );
  assert.equal(
    translateBotTransferError(
      Object.assign(new Error('forbidden'), {
        status: 403,
        code: 'BOT_CLIENT_FORBIDDEN',
      }),
      'fallback',
    ),
    'Hub 拒绝了 OAuth 登录令牌，请先在 settings.json 的 Hub 配置 headers.Authorization 中填入成员直接访问令牌后再重试',
  );
  assert.equal(
    translateBotTransferError(
      Object.assign(new Error('too big'), { status: 413 }),
      'fallback',
    ),
    '机器人请求无效',
  );
  assert.equal(
    translateBotTransferError(
      Object.assign(
        new Error('Uploaded 2 of 5 files; failed on c.txt: fetch failed'),
        {
          name: 'PartialBatchUploadError',
        },
      ),
      'fallback',
    ),
    '已上传 2/5 个文件；c.txt 上传失败：网络请求失败',
  );
});

test('LiveRuntime.request forwards structured errorStatus and errorCode across IPC', async () => {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const host = {
    runtimeState: async () => update,
    onRuntime: () => () => {},
    onTerminalEvent: () => () => {},
    onBrowserEvent: () => () => {},
    onAction: () => () => {},
    setTheme: async () => {},
    browserState: async () => ({ sessionId: 'none' }),
    runtimeCommand: async (command: RuntimeCommand): Promise<RuntimeReply> => ({
      id: command.id,
      ok: false,
      error: 'oauth token rejected',
      errorStatus: 403,
      errorCode: 'BOT_CLIENT_FORBIDDEN',
    }),
  } as unknown as DesktopBridge;
  const runtime = new LiveRuntime(host, update);
  await assert.rejects(
    () => runtime.request('remote-bot', { action: 'discover' }),
    (error: unknown) => {
      const meta = error as Error & {
        status?: number;
        code?: string;
        cause?: { status?: number; code?: string };
      };
      return (
        error instanceof Error &&
        (meta.status === 403 || meta.cause?.status === 403) &&
        (meta.code === 'BOT_CLIENT_FORBIDDEN' ||
          meta.cause?.code === 'BOT_CLIENT_FORBIDDEN')
      );
    },
  );
});

test('C24a: shouldOpenInitialConnectionModal ignores disconnected or non-connected Hub entries', () => {
  const disconnectedHub = {
    mcp: [
      {
        id: 'Hub',
        name: 'Hub',
        url: 'http://127.0.0.1:7420/mcp',
        transport: 'streamable_http' as const,
        command: '',
        args: '',
        enabled: true,
        status: 'not connected' as const,
        tools: [],
      },
    ],
  };
  const connectedHub = {
    mcp: [{ ...disconnectedHub.mcp[0]!, status: 'connected' as const }],
  };
  assert.equal(
    shouldOpenInitialConnectionModal({
      mode: 'live',
      configured: false,
      snapshot: { mcp: [] },
      pathname: '/session/s1',
    }),
    true,
  );
  assert.equal(
    shouldOpenInitialConnectionModal({
      mode: 'live',
      configured: false,
      snapshot: disconnectedHub,
      pathname: '/session/s1',
    }),
    true,
  );
  assert.equal(
    shouldOpenInitialConnectionModal({
      mode: 'live',
      configured: false,
      snapshot: connectedHub,
      pathname: '/session/s1',
    }),
    false,
  );
  assert.equal(
    shouldOpenInitialConnectionModal({
      mode: 'live',
      configured: false,
      snapshot: { mcp: [] },
      pathname: '/page/remote-bot',
    }),
    false,
  );
  assert.equal(
    shouldOpenInitialConnectionModal({
      mode: 'preview',
      configured: false,
      snapshot: { mcp: [] },
      pathname: '/session/s1',
    }),
    false,
  );
});
