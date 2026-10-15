import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayModel } from '../src/model.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import type { Message, ModelRequest } from '../src/types.js';
import { thinkingGateway, checkpointRows } from './thinking-fixture.js';
import { rejectedParameters } from '../src/model_guard.js';

const request = (messages: Message[]): ModelRequest => ({
  system: 'system',
  messages,
  tools: [],
  signal: new AbortController().signal,
  token() {},
});
const question: Message = { id: 'user', role: 'user', content: 'question' };

test('switching endpoint, key or model strips incompatible thinking only in the next request', async (t) => {
  const gateway = await thinkingGateway();
  t.after(gateway.close);
  const home = mkdtempSync(join(tmpdir(), 'circle-thinking-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const model = (path: string, key: string, name = 'gateway') => {
    const settings = defaultSettings();
    settings.auth = {
      ...settings.auth,
      protocol: 'anthropic',
      base_url: gateway.base + path,
      model: name,
    };
    saveCredentials({ api_key: key }, home);
    return new GatewayModel(settings, home);
  };
  const original = model('/old', 'old-key');
  const reply = (await original.complete(request([question]))).message;
  const history = [
    question,
    reply,
    { ...question, id: 'next', content: 'continue' },
  ];
  const before = structuredClone(history);
  await original.complete(request(history));
  assert.deepEqual(
    gateway.requests.at(-1)!.body.messages[1].content,
    reply.provider_content,
  );
  for (const changed of [
    model('/new', 'old-key'),
    model('/old', 'new-key'),
    model('/old', 'old-key', 'other-model'),
  ]) {
    const count = gateway.requests.length;
    await changed.complete(request(history));
    assert.equal(
      gateway.requests.length,
      count + 1,
      'known incompatible history must not need a rejected request',
    );
    assert.deepEqual(gateway.requests.at(-1)!.body.messages[1].content, [
      { type: 'text', text: 'accepted' },
    ]);
  }
  assert.deepEqual(history, before, 'source history must remain unchanged');
});

test('legacy history recovers once on explicit signature rejection and keeps tool blocks and fresh signatures', async (t) => {
  const gateway = await thinkingGateway();
  t.after(gateway.close);
  const home = mkdtempSync(join(tmpdir(), 'circle-thinking-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  saveCredentials({ api_key: 'key' }, home);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    protocol: 'anthropic',
    base_url: gateway.base,
    model: 'claude-fixture',
  };
  const model = new GatewayModel(settings, home);
  const legacy: Message = {
    id: 'legacy',
    role: 'assistant',
    content: 'old answer',
    thinking: 'old reasoning',
    provider_content: [
      { type: 'thinking', thinking: 'old reasoning', signature: 'foreign' },
      { type: 'redacted_thinking', data: 'foreign' },
      { type: 'text', text: 'old answer' },
      {
        type: 'tool_use',
        id: 'call',
        name: 'read_file',
        input: { file_path: 'a' },
      },
    ],
    tool_calls: [{ id: 'call', name: 'read_file', args: { file_path: 'a' } }],
  };
  const history: Message[] = [
    question,
    legacy,
    { id: 'result', role: 'tool', tool_call_id: 'call', content: 'file bytes' },
    { ...question, id: 'continue', content: 'continue' },
  ];
  const before = structuredClone(history);
  const notices: unknown[] = [];
  const reply = await model.complete({
    ...request(history),
    notice: (e) => notices.push(e),
  });
  assert.equal(gateway.requests.length, 2);
  assert.equal(gateway.requests[0]!.rejected, true);
  const recovered = gateway.requests[1]!.body;
  assert.deepEqual(
    recovered.messages[1].content,
    legacy.provider_content!.slice(2),
  );
  assert.equal(recovered.messages[2].content[0].type, 'tool_result');
  assert.deepEqual(
    recovered.thinking,
    { type: 'adaptive' },
    'signature errors must not disable thinking',
  );
  assert.ok(notices.some((e: any) => e.event === 'thinking_signature_retry'));
  history.push(reply.message, { ...question, id: 'third' });
  await model.complete(request(history));
  assert.equal(
    gateway.requests.length,
    3,
    'already rejected history stays projected out for this connection',
  );
  assert.deepEqual(
    gateway.requests[2]!.body.messages[3].content,
    reply.message.provider_content,
    'fresh valid thinking is still sent',
  );
  assert.deepEqual(history.slice(0, 4), before);
});

test('invalid thinking signature is not an unsupported thinking parameter', () => {
  assert.deepEqual(
    rejectedParameters({
      status: 400,
      message: 'messages.1.content.0: Invalid `signature` in `thinking` block',
    }),
    [],
  );
});

test('CLI resumes switched and legacy API history across processes without rewriting checkpoints', async (t) => {
  const { spawn } = await import('node:child_process');
  const { CheckpointStore } = await import('../src/checkpoint_store.js');
  const { saveSettings, trustFolder } = await import('../src/settings.js');
  const gateway = await thinkingGateway();
  t.after(gateway.close);
  const home = mkdtempSync(join(tmpdir(), 'circle-thinking-cli-'));
  const workspace = mkdtempSync(join(tmpdir(), 'circle-thinking-workspace-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  const configure = (path: string, key: string) => {
    const settings = trustFolder(defaultSettings(), workspace);
    settings.initialized = true;
    settings.update_check = false;
    settings.auth = {
      ...settings.auth,
      protocol: 'anthropic',
      base_url: gateway.base + path,
      model: 'claude-fixture',
    };
    saveSettings(settings, home);
    saveCredentials({ api_key: key }, home);
  };
  const run = (id: string) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/cli.ts',
          '-p',
          'continue',
          workspace,
          '--session-id',
          id,
        ],
        {
          env: {
            ...process.env,
            CIRCLE_HOME: home,
            CIRCLE_NO_MODELS_REFRESH: '1',
            CIRCLE_NO_UPDATE_CHECK: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let out = '',
        err = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (err += b));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(out) : reject(Error(err)),
      );
      child.stdin.end();
    });
  configure('/old', 'old-key');
  await run('circle-switch');
  let store = new CheckpointStore(home);
  const original = store.tree('circle-switch');
  store.close();
  const originalRows = await checkpointRows(home, 'circle-switch');
  configure('/new', 'new-key');
  await run('circle-switch');
  assert.deepEqual(
    (await checkpointRows(home, 'circle-switch')).slice(0, originalRows.length),
    originalRows,
  );
  assert.equal(gateway.requests.length, 2);
  assert.equal(gateway.requests.at(-1)!.rejected, false);
  store = new CheckpointStore(home);
  assert.deepEqual(
    store.tree('circle-switch').slice(0, original.length),
    original,
  );
  const legacy = store.create(
    workspace,
    'claude-fixture',
    'legacy',
    'circle-legacy',
  );
  const legacyMessages = original.map((c) => structuredClone(c.message));
  for (const m of legacyMessages) delete m.thinking_scope;
  store.append(legacy.id, legacyMessages);
  const legacyBefore = store.tree(legacy.id);
  store.close();
  const legacyRows = await checkpointRows(home, legacy.id);
  await run(legacy.id);
  assert.deepEqual(
    (await checkpointRows(home, legacy.id)).slice(0, legacyRows.length),
    legacyRows,
  );
  assert.equal(
    gateway.requests.length,
    4,
    'legacy request rejects once then succeeds',
  );
  assert.equal(gateway.requests[2]!.rejected, true);
  store = new CheckpointStore(home);
  assert.deepEqual(
    store.tree(legacy.id).slice(0, legacyBefore.length),
    legacyBefore,
  );
  assert.ok(
    store
      .messages(legacy.id)
      .some((m) => m.thinking_scope && m.role === 'assistant'),
  );
  store.close();
  await run(legacy.id);
  assert.equal(
    gateway.requests.length,
    6,
    'a new process can recover legacy blocks again without editing them',
  );
  assert.deepEqual(
    (await checkpointRows(home, legacy.id)).slice(0, legacyRows.length),
    legacyRows,
  );
});

for (const [label, error, signed, attempts] of [
  [
    'signature rejection after recovery',
    'messages.1.content.0: Invalid `signature` in `thinking` block',
    true,
    2,
  ],
  [
    'signature rejection without signed history',
    'messages.1.content.0: Invalid `signature` in `thinking` block',
    false,
    1,
  ],
  ['unrelated invalid request', 'invalid message structure', true, 1],
] as const)
  test(`${label} stops without disabling thinking or retrying indefinitely`, async (t) => {
    const gateway = await thinkingGateway(error);
    t.after(gateway.close);
    const home = mkdtempSync(join(tmpdir(), 'circle-thinking-error-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    saveCredentials({ api_key: 'key' }, home);
    const settings = defaultSettings();
    settings.auth = {
      ...settings.auth,
      protocol: 'anthropic',
      base_url: gateway.base,
      model: 'claude-fixture',
    };
    const history: Message[] = [
      question,
      ...(signed
        ? [
            {
              id: 'old',
              role: 'assistant' as const,
              content: 'answer',
              provider_content: [
                { type: 'thinking', thinking: 'old', signature: 'foreign' },
                { type: 'text', text: 'answer' },
              ],
            },
          ]
        : []),
    ];
    const before = structuredClone(history);
    const model = new GatewayModel(settings, home);
    await assert.rejects(
      model.complete(request(history)),
      (failure: unknown) =>
        failure instanceof Error && failure.message.includes(error),
    );
    assert.equal(gateway.requests.length, attempts);
    assert.ok(
      gateway.requests.every((r) => r.body.thinking?.type === 'adaptive'),
    );
    assert.deepEqual(history, before);
  });

test('valid legacy thinking and consecutive assistant blocks round-trip without mutating provider content', async (t) => {
  const gateway = await thinkingGateway();
  t.after(gateway.close);
  const home = mkdtempSync(join(tmpdir(), 'circle-thinking-merge-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  saveCredentials({ api_key: 'key' }, home);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    protocol: 'anthropic',
    base_url: gateway.base,
    model: 'claude-fixture',
  };
  const model = new GatewayModel(settings, home);
  const reply = (await model.complete(request([question]))).message;
  delete reply.thinking_scope;
  const history: Message[] = [
    question,
    reply,
    {
      id: 'extra',
      role: 'assistant',
      content: 'extra',
      provider_content: [{ type: 'text', text: 'extra' }],
    },
    { ...question, id: 'continue' },
  ];
  const before = structuredClone(history);
  await model.complete(request(history));
  assert.equal(gateway.requests.length, 2);
  assert.equal(gateway.requests[1]!.rejected, false);
  assert.deepEqual(gateway.requests[1]!.body.messages[1].content, [
    ...reply.provider_content!,
    { type: 'text', text: 'extra' },
  ]);
  assert.deepEqual(history, before);
});

test('signature recovery respects cancellation before its retry', async (t) => {
  const gateway = await thinkingGateway();
  t.after(gateway.close);
  const home = mkdtempSync(join(tmpdir(), 'circle-thinking-cancel-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  saveCredentials({ api_key: 'key' }, home);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    protocol: 'anthropic',
    base_url: gateway.base,
    model: 'claude-fixture',
  };
  const controller = new AbortController();
  const cancelled = Error('cancel recovery');
  const history: Message[] = [
    question,
    {
      id: 'old',
      role: 'assistant',
      content: 'old answer',
      provider_content: [
        { type: 'thinking', thinking: 'old', signature: 'foreign' },
        { type: 'text', text: 'old answer' },
      ],
    },
  ];
  await assert.rejects(
    new GatewayModel(settings, home).complete({
      ...request(history),
      signal: controller.signal,
      notice: () => controller.abort(cancelled),
    }),
    (e) => e === cancelled,
  );
  assert.equal(gateway.requests.length, 1);
});

test('foreign thinking-only messages do not become empty assistant messages', async (t) => {
  const gateway = await thinkingGateway();
  t.after(gateway.close);
  const home = mkdtempSync(join(tmpdir(), 'circle-thinking-only-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  saveCredentials({ api_key: 'key' }, home);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    protocol: 'anthropic',
    base_url: gateway.base,
    model: 'claude-fixture',
  };
  const history: Message[] = [
    question,
    {
      id: 'only',
      role: 'assistant',
      content: '',
      thinking: 'old',
      thinking_scope: 'other-api',
      provider_content: [{ type: 'redacted_thinking', data: 'foreign' }],
    },
    {
      id: 'answer',
      role: 'assistant',
      content: 'old answer',
      provider_content: [{ type: 'text', text: 'old answer' }],
    },
    { ...question, id: 'continue' },
  ];
  const before = structuredClone(history);
  await new GatewayModel(settings, home).complete(request(history));
  assert.equal(gateway.requests.length, 1);
  assert.deepEqual(gateway.requests[0]!.body.messages[1].content, [
    { type: 'text', text: 'old answer' },
  ]);
  assert.deepEqual(history, before);
});

test('a rejected message id does not suppress different valid thinking in another history', async (t) => {
  const gateway = await thinkingGateway();
  t.after(gateway.close);
  const home = mkdtempSync(join(tmpdir(), 'circle-thinking-reused-id-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  saveCredentials({ api_key: 'key' }, home);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    protocol: 'anthropic',
    base_url: gateway.base,
    model: 'claude-fixture',
  };
  const model = new GatewayModel(settings, home);
  const rejected: Message = {
    id: 'shared-id',
    role: 'assistant',
    content: 'old answer',
    provider_content: [
      { type: 'thinking', thinking: 'old', signature: 'foreign' },
      { type: 'text', text: 'old answer' },
    ],
  };
  const fresh = (
    await model.complete(
      request([question, rejected, { ...question, id: 'continue' }]),
    )
  ).message;
  const restored = { ...fresh, id: rejected.id };
  const before = structuredClone(restored);
  await model.complete(
    request([question, restored, { ...question, id: 'another-history' }]),
  );
  assert.equal(gateway.requests.length, 3);
  assert.deepEqual(
    gateway.requests.at(-1)!.body.messages[1].content,
    restored.provider_content,
    'reused ids must not strip a different valid signature',
  );
  assert.deepEqual(restored, before);
});
