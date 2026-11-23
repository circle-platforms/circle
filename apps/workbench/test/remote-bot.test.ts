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
  isHubConnected,
  mergeDeliveryStates,
  nextBotRetryDelay,
  shouldOpenInitialConnectionModal,
  stripInvokeErrorPrefix,
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
  ) => Object.assign(new Error(message), { status, code });

  for (const lang of ['en', 'zh-CN'] as const) {
    setLanguage(lang);
    const cases = [
      {
        err: makeErr(426, 'BOT_VERSION_MISMATCH', 'client too old'),
        kind: 'version-mismatch',
        retryable: false,
      },
      {
        err: makeErr(400, 'BOT_VERSION_INVALID', 'bad version'),
        kind: 'version-invalid',
        retryable: false,
      },
      {
        err: makeErr(403, 'BOT_DISABLED', 'disabled by admin'),
        kind: 'disabled',
        retryable: false,
      },
      {
        err: makeErr(403, 'BOT_CLIENT_FORBIDDEN', 'oauth client forbidden'),
        kind: 'oauth-forbidden',
        retryable: false,
      },
      {
        err: makeErr(401, undefined, 'token revoked'),
        kind: 'auth',
        retryable: false,
      },
      {
        err: makeErr(502, undefined, 'remote bot unavailable'),
        kind: 'transient',
        retryable: true,
      },
    ] as const;

    const renderedTitles = new Set<string>();
    const renderedCauses = new Set<string>();
    const renderedActions = new Set<string>();
    for (const c of cases) {
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
    assert.equal(renderedTitles.size, cases.length);
    assert.equal(renderedCauses.size, cases.length);
    assert.equal(renderedActions.size, cases.length);
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
