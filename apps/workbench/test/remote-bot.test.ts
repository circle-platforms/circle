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
  mcpDisplayStatus,
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
  // C3-S4: live /mcp stays visible during re-authorization or failed re-sign-in, while connect-time re-auth (mcpConnected: false) stays hidden.
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
          mcpConnected: false,
          status: 're-authorization required',
          tools: [],
        },
      ],
    }),
    false,
  );
  for (const status of [
    're-authorization required',
    'error',
    'connected',
  ] as const) {
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
            mcpConnected: true,
            status,
            error: status === 'error' ? 'sign-in failed: denied' : undefined,
            tools: [],
          },
        ],
      }),
      true,
    );
  }
});

test('C4-S2: mcpDisplayStatus aligns MCP page and Hub card status for live, waiting, and re-auth servers', () => {
  const base = {
    id: 'srv',
    name: 'srv',
    url: 'https://127.0.0.1:7420/mcp',
    transport: 'streamable_http' as const,
    command: '',
    args: '',
    enabled: true,
    tools: [],
  };
  assert.equal(mcpDisplayStatus(undefined), 'not connected');
  assert.equal(
    mcpDisplayStatus({
      ...base,
      status: 'error',
      mcpConnected: true,
      error: 'sign-in failed: denied',
    }),
    'connected',
  );
  assert.equal(
    mcpDisplayStatus({
      ...base,
      status: 'error',
      mcpConnected: false,
      error: 'ECONNREFUSED',
    }),
    'error',
  );
  assert.equal(
    mcpDisplayStatus({
      ...base,
      status: 'error',
      mcpConnected: true,
      signIn: { url: 'https://127.0.0.1:7420/authorize', code: 'ABCD-EFGH' },
    }),
    'waiting for sign-in',
  );
  assert.equal(
    mcpDisplayStatus({
      ...base,
      status: 're-authorization required',
      mcpConnected: false,
    }),
    're-authorization required',
  );
  assert.equal(
    mcpDisplayStatus({ ...base, status: 'reload required' }),
    'reload required',
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
    scope?: string,
  ) => Object.assign(new Error(message), { status, code, detail, scope });

  for (const lang of ['en', 'zh-CN'] as const) {
    setLanguage(lang);
    const nonTransientCases = [
      {
        err: makeErr(400, 'BOT_VERSION_MISMATCH', 'client too old'),
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
      {
        err: makeErr(undefined, undefined, 'MCP sign-in is required'),
        kind: 'local-credential',
        retryable: false,
      },
      {
        err: makeErr(
          undefined,
          undefined,
          'remote bot requires https or loopback http',
        ),
        kind: 'local-https',
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

    // 403 BOT_CLIENT_FORBIDDEN without manual Authorization header prompts re-login with WWW-Authenticate scope, keeping manual fallback.
    const forbidden = classifyRemoteBotFailure(
      makeErr(
        403,
        'BOT_CLIENT_FORBIDDEN',
        'oauth client token rejected',
        undefined,
        'custom-bot-scope',
      ),
    );
    assert.equal(forbidden.canReauthorize, true);
    assert.equal(forbidden.reauthorizeScope, 'custom-bot-scope');
    assert.match(forbidden.action, /settings\.json/);
    assert.match(forbidden.action, /Bearer/);

    const customSettingsPath = '/tmp/circle-data/runtime-home/settings.json';
    const forbiddenWithPath = classifyRemoteBotFailure(
      makeErr(403, 'BOT_CLIENT_FORBIDDEN', 'oauth client token rejected'),
      { settingsPath: customSettingsPath },
    );
    assert.equal(forbiddenWithPath.canReauthorize, true);
    assert.ok(forbiddenWithPath.action.includes(customSettingsPath));

    const forbiddenWithHeader = classifyRemoteBotFailure(
      makeErr(403, 'BOT_CLIENT_FORBIDDEN', 'oauth client token rejected'),
      { hasAuthorizationHeader: true, settingsPath: customSettingsPath },
    );
    assert.equal(forbiddenWithHeader.canReauthorize, undefined);
    assert.ok(forbiddenWithHeader.action.includes(customSettingsPath));
    if (lang === 'en') {
      assert.equal(forbiddenWithPath.title, 'bot access not granted');
      assert.equal(
        forbiddenWithPath.cause,
        'Sign in again, and check “Allow this client to use my bot” on the Hub confirmation page.',
      );
      assert.match(
        forbiddenWithPath.action,
        /Disconnecting removes manual headers; add them again after reconnecting\./,
      );
      assert.equal(forbiddenWithHeader.title, 'direct member token required');
      assert.equal(
        forbiddenWithHeader.cause,
        'Hub refused the OAuth sign-in token for my bot API.',
      );
      assert.match(
        forbiddenWithHeader.action,
        /Add a direct member Bearer Authorization header/,
      );
      const forbiddenConsoleEn = classifyRemoteBotFailure(
        makeErr(403, 'BOT_CLIENT_FORBIDDEN', 'console credential rejected'),
        { settingsPath: customSettingsPath },
      );
      assert.match(
        forbiddenConsoleEn.action,
        /Disconnecting removes manual headers; add them again after reconnecting\./,
      );
    }

    // 401 with hasAuthorizationHeader gives settings.json token-update instructions instead of Settings -> Extensions.
    const authFixedHeader = classifyRemoteBotFailure(
      makeErr(401, 'BOT_UNAUTHENTICATED', 'token revoked'),
      { hasAuthorizationHeader: true, settingsPath: customSettingsPath },
    );
    assert.equal(authFixedHeader.kind, 'auth');
    assert.equal(authFixedHeader.retryable, false);
    assert.ok(authFixedHeader.action.includes(customSettingsPath));
    assert.doesNotMatch(
      authFixedHeader.action,
      /Settings -> Extensions|设置 -> 扩展/,
    );

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
      makeErr(
        422,
        'BOT_INVALID_REQUEST',
        '参数无效：机器人附件完整性校验未通过。请重新上传附件后再试。',
      ),
    );
    assert.equal(integrity.kind, 'other');
    assert.equal(integrity.retryable, false);

    if (lang === 'zh-CN') {
      assert.equal(authWithForbiddenCode.title, '机器人登录已过期');
      assert.equal(
        authWithForbiddenCode.cause,
        'Hub 拒绝了当前凭据，可能已过期或被撤销。',
      );
      assert.equal(
        authWithForbiddenCode.action,
        '请在 设置 -> 扩展 中重新登录 Hub 后再重试。',
      );
      assert.equal(authFixedHeader.title, '机器人登录已过期');
      assert.equal(
        authFixedHeader.cause,
        'Hub 拒绝了当前凭据，可能已过期或被撤销。',
      );
      assert.equal(
        authFixedHeader.action,
        `请更新 ${customSettingsPath} 中 Hub 的直接成员 Bearer 令牌（格式：Bearer <令牌>），然后再重试。`,
      );

      assert.equal(forbidden.title, '未授予机器人访问权限');
      assert.equal(
        forbidden.cause,
        '重新登录，并在 Hub 的确认页勾选「允许这个客户端使用我的机器人」。',
      );
      assert.equal(
        forbidden.action,
        '也可以在 <应用数据文件夹>/runtime-home/settings.json 的 Hub 配置 headers.Authorization 中填入成员直接访问令牌（格式：Bearer <令牌>），然后再重试。断开连接会移除手工添加的请求头，重新连接后需要再次添加。',
      );
      assert.equal(forbiddenWithPath.title, '未授予机器人访问权限');
      assert.equal(
        forbiddenWithPath.cause,
        '重新登录，并在 Hub 的确认页勾选「允许这个客户端使用我的机器人」。',
      );
      assert.equal(
        forbiddenWithPath.action,
        `也可以在 ${customSettingsPath} 的 Hub 配置 headers.Authorization 中填入成员直接访问令牌（格式：Bearer <令牌>），然后再重试。断开连接会移除手工添加的请求头，重新连接后需要再次添加。`,
      );
      assert.equal(forbiddenWithHeader.title, '需要使用直接成员令牌');
      assert.equal(
        forbiddenWithHeader.cause,
        'Hub 拒绝了 OAuth 登录令牌对机器人接口的访问。',
      );
      assert.equal(
        forbiddenWithHeader.action,
        `请先在 ${customSettingsPath} 的 Hub 配置 headers.Authorization 中填入成员直接访问令牌（格式：Bearer <令牌>），然后再重试。断开连接会移除手工添加的请求头，重新连接后需要再次添加。`,
      );

      const forbiddenConsole = classifyRemoteBotFailure(
        makeErr(
          403,
          'BOT_CLIENT_FORBIDDEN',
          '禁止使用控制台登录凭据调用机器人接口',
        ),
        { settingsPath: customSettingsPath },
      );
      assert.equal(forbiddenConsole.kind, 'oauth-forbidden');
      assert.equal(forbiddenConsole.retryable, false);
      assert.equal(forbiddenConsole.title, '不能使用控制台凭据');
      assert.equal(
        forbiddenConsole.cause,
        'Hub 拒绝了控制台会话凭据对机器人接口的访问。',
      );
      assert.equal(
        forbiddenConsole.action,
        `请先在 ${customSettingsPath} 的 Hub 配置 headers.Authorization 中填入直接成员 Bearer 令牌（格式：Bearer <令牌>），然后再重试。断开连接会移除手工添加的请求头，重新连接后需要再次添加。`,
      );

      const forbiddenOrigin = classifyRemoteBotFailure(
        makeErr(403, 'BOT_CLIENT_FORBIDDEN', '请求 Origin header 不在允许列表'),
      );
      assert.equal(forbiddenOrigin.kind, 'oauth-forbidden');
      assert.equal(forbiddenOrigin.retryable, false);
      assert.equal(forbiddenOrigin.title, '请求 Host 或 Origin 被拒绝');
      assert.equal(
        forbiddenOrigin.cause,
        'Hub 拒绝了当前请求的 Host 或 Origin 请求头。',
      );
      assert.equal(
        forbiddenOrigin.action,
        '请在 设置 -> 扩展 中检查 Hub 地址或确认 Hub 允许的 Host/Origin 配置后再重试。',
      );

      const versionMismatch = classifyRemoteBotFailure(
        makeErr(400, 'BOT_VERSION_MISMATCH', '版本不匹配'),
      );
      assert.equal(versionMismatch.kind, 'version-mismatch');
      assert.equal(versionMismatch.title, '需要更新 Circle');
      assert.equal(
        versionMismatch.cause,
        'Hub 拒绝了当前 Circle 版本的机器人连接。',
      );
      assert.equal(versionMismatch.action, '请更新 Circle 桌面版后重新连接。');

      const versionInvalid = classifyRemoteBotFailure(
        makeErr(400, 'BOT_VERSION_INVALID', 'bad version'),
      );
      assert.equal(versionInvalid.kind, 'version-invalid');
      assert.equal(versionInvalid.title, '客户端版本无效');
      assert.equal(
        versionInvalid.cause,
        'Hub 无法识别当前 Circle 客户端版本头。',
      );
      assert.equal(
        versionInvalid.action,
        '请重新安装或更新 Circle 桌面版后再重试。',
      );

      const disabled = classifyRemoteBotFailure(
        makeErr(503, 'BOT_DISABLED', 'disabled'),
      );
      assert.equal(disabled.kind, 'disabled');
      assert.equal(disabled.title, '我的机器人已停用');
      assert.equal(disabled.cause, 'Hub 管理员已停用机器人功能。');
      assert.equal(disabled.action, '请联系 Hub 管理员启用后再重试。');

      const busy = classifyRemoteBotFailure(makeErr(429, 'BOT_BUSY', 'busy'));
      assert.equal(busy.kind, 'transient');
      assert.equal(busy.title, '机器人请求繁忙');
      assert.equal(busy.cause, '机器人队列已满或触发限流，请稍候。');
      assert.equal(
        busy.action,
        'Circle 将在短时间退避后自动重试，也可以立即手动重试。',
      );

      const transient = classifyRemoteBotFailure(
        makeErr(502, undefined, 'remote bot unavailable'),
      );
      assert.equal(transient.kind, 'transient');
      assert.equal(transient.title, '机器人连接中断');
      assert.equal(transient.cause, '暂时无法连接到 Hub 机器人接口。');
      assert.equal(
        transient.action,
        'Circle 将按退避间隔自动重试，也可以立即手动重试。',
      );

      const quota = classifyRemoteBotFailure(
        makeErr(413, 'BOT_QUOTA_EXCEEDED', 'quota exceeded'),
      );
      assert.equal(quota.kind, 'other');
      assert.equal(quota.title, '机器人附件配额已满');
      assert.equal(quota.cause, '当前成员的机器人附件存储已达到上限。');
      assert.equal(
        quota.action,
        '请等待旧附件过期清理后再上传，或先发送不带附件的消息。',
      );

      const notFound = classifyRemoteBotFailure(
        makeErr(404, 'BOT_NOT_FOUND', 'not found'),
      );
      assert.equal(notFound.kind, 'other');
      assert.equal(notFound.title, '未找到机器人目标资源');
      assert.equal(notFound.cause, 'Hub 未找到请求的机器人对话或文件。');
      assert.equal(notFound.action, '请新建机器人对话后重试。');

      const conflict = classifyRemoteBotFailure(
        makeErr(409, 'BOT_CONFLICT', 'conflict'),
      );
      assert.equal(conflict.kind, 'other');
      assert.equal(conflict.title, '机器人请求状态冲突');
      assert.equal(
        conflict.cause,
        '该请求与已有机器人对话或请求记录状态冲突。',
      );
      assert.equal(conflict.action, '请刷新机器人对话后重新发送请求。');

      assert.equal(integrity.title, '附件完整性校验失败');
      assert.equal(integrity.cause, '附件校验未通过，Hub 拒绝了该消息。');
      assert.equal(integrity.action, '请移除并重新附加该文件后再试。');

      const invalidReq = classifyRemoteBotFailure(
        makeErr(400, 'BOT_INVALID_REQUEST', 'bad text'),
      );
      assert.equal(invalidReq.kind, 'other');
      assert.equal(invalidReq.title, '机器人请求无效');
      assert.equal(
        invalidReq.cause,
        '请求参数或内容长度不符合要求，已被 Hub 拒绝。',
      );
      assert.equal(invalidReq.action, '请检查消息内容或附件限制后再重试。');

      const otherErr = classifyRemoteBotFailure(
        makeErr(415, undefined, 'unsupported media type'),
      );
      assert.equal(otherErr.kind, 'other');
      assert.equal(otherErr.title, '机器人请求失败');
      assert.equal(otherErr.cause, 'Hub 返回了未预期的机器人错误。');
      assert.equal(otherErr.action, '请检查 Hub 连接状态后再重试。');

      const localMissingSecret = classifyRemoteBotFailure(
        makeErr(
          undefined,
          undefined,
          'the Authorization header names ${HUB_TOKEN}, which is not set; save it with /secrets HUB_TOKEN',
        ),
        { hasAuthorizationHeader: true, settingsPath: customSettingsPath },
      );
      assert.equal(localMissingSecret.kind, 'local-credential');
      assert.equal(localMissingSecret.retryable, false);
      assert.equal(localMissingSecret.title, '缺少 Hub 授权密钥');
      assert.equal(
        localMissingSecret.cause,
        'Hub 的 Authorization 请求头引用了未设置的密钥 ${HUB_TOKEN}。',
      );
      assert.equal(
        localMissingSecret.action,
        `请在 设置 -> 变量与密钥 中保存密钥 HUB_TOKEN（或使用 /secrets HUB_TOKEN），或在 ${customSettingsPath} 中更新 headers.Authorization 后再重试。`,
      );

      const localBadBearer = classifyRemoteBotFailure(
        makeErr(undefined, undefined, 'MCP sign-in is required'),
        { hasAuthorizationHeader: true, settingsPath: customSettingsPath },
      );
      assert.equal(localBadBearer.kind, 'local-credential');
      assert.equal(localBadBearer.retryable, false);
      assert.equal(localBadBearer.title, 'Hub 授权请求头格式无效');
      assert.equal(
        localBadBearer.cause,
        'Hub 的 Authorization 请求头缺少有效的 Bearer 前缀或令牌。',
      );
      assert.equal(
        localBadBearer.action,
        `请在 ${customSettingsPath} 中将 Hub 的 headers.Authorization 修改为 Bearer <令牌> 格式后再重试。`,
      );

      const localMissingLogin = classifyRemoteBotFailure(
        makeErr(undefined, undefined, 'MCP sign-in is required'),
        { hasAuthorizationHeader: false, settingsPath: customSettingsPath },
      );
      assert.equal(localMissingLogin.kind, 'local-credential');
      assert.equal(localMissingLogin.retryable, false);
      assert.equal(localMissingLogin.title, '需要登录 Hub');
      assert.equal(
        localMissingLogin.cause,
        '当前 Hub 连接缺少有效的本地登录凭据。',
      );
      assert.equal(
        localMissingLogin.action,
        `请在 设置 -> 扩展 中登录 Hub，或在 ${customSettingsPath} 中填入直接成员 Bearer 令牌（格式：Bearer <令牌>）后再重试。`,
      );

      const localHttps = classifyRemoteBotFailure(
        makeErr(
          undefined,
          undefined,
          'remote bot requires https or loopback http',
        ),
        { settingsPath: customSettingsPath },
      );
      assert.equal(localHttps.kind, 'local-https');
      assert.equal(localHttps.retryable, false);
      assert.equal(localHttps.title, '远程机器人需要 HTTPS 连接');
      assert.equal(
        localHttps.cause,
        '远程机器人连接需要使用 https:// 地址或本机回环 http:// 地址。',
      );
      assert.equal(
        localHttps.action,
        `请在 设置 -> 扩展 或 ${customSettingsPath} 中将 Hub 地址改为 https:// 后再重试。`,
      );
    }
  }
});

test('R1/S2: formatRemoteBotNotice translates all 24 notice codes and English fallbacks', (t) => {
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
    ['message_not_processed', 'message was not processed; you can resend it'],
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
  assert.equal(
    formatRemoteBotNotice('message_not_processed', 'raw'),
    '本条消息未被处理，可以重新发送',
  );
  assert.equal(
    formatRemoteBotNotice('reply_interrupted', 'raw'),
    '模型回复已中断，结果未知',
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
    '重新登录并在 Hub 的确认页勾选「允许这个客户端使用我的机器人」，或在 settings.json 的 Hub 配置 headers.Authorization 中填入成员直接访问令牌后再重试',
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
  assert.equal(
    translateBotTransferError(
      Object.assign(
        new Error('Uploaded 1 of 3 files; failed on c: d.txt: fetch failed'),
        {
          name: 'PartialBatchUploadError',
          errorUploaded: 1,
          errorTotal: 3,
          errorFileName: 'c: d.txt',
          errorReason: 'fetch failed',
        },
      ),
      'fallback',
    ),
    '已上传 1/3 个文件；c: d.txt 上传失败：网络请求失败',
  );
  assert.equal(
    translateBotTransferError(
      Object.assign(new Error('参数无效：机器人附件完整性校验未通过。'), {
        status: 422,
        code: 'BOT_INVALID_REQUEST',
      }),
      'fallback',
    ),
    '附件完整性校验失败',
  );
  assert.equal(
    translateBotTransferError(new Error('untrusted IPC sender'), 'fallback'),
    '不受信任的窗口请求，请刷新或重新打开窗口后再试',
  );
  assert.equal(
    translateBotTransferError(new Error('MCP sign-in is required'), 'fallback'),
    '需要先完成 Hub 授权登录，或配置格式正确的 Bearer 令牌',
  );
  assert.equal(
    translateBotTransferError(
      new Error(
        'the Authorization header names ${HUB_TOKEN}, which is not set; save it with /secrets HUB_TOKEN',
      ),
      'fallback',
    ),
    '授权请求头引用的密钥 ${HUB_TOKEN} 尚未设置，请先在变量与密钥中保存 HUB_TOKEN 后再重试',
  );
  for (const [fsMsg, code, expected] of [
    [
      "ENOENT: no such file or directory, open '/Users/alice/private/secret.txt'",
      'ENOENT',
      '文件不可用',
    ],
    [
      "EACCES: permission denied, open '/Users/alice/private/secret.txt'",
      'EACCES',
      '没有文件访问权限',
    ],
    [
      "EPERM: operation not permitted, open '/Users/alice/private/secret.txt'",
      'EPERM',
      '没有文件访问权限',
    ],
    [
      "EISDIR: illegal operation on a directory, open '/Users/alice/private'",
      'EISDIR',
      '无法将文件夹当作文件操作',
    ],
  ] as const) {
    const translated = translateBotTransferError(
      Object.assign(new Error(fsMsg), { code }),
      'fallback',
    );
    assert.equal(translated, expected);
    assert.doesNotMatch(translated, /\/Users\/alice/);
  }
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
