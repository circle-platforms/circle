import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { GatewayModel } from '../src/model.js';
import {
  defaultSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { pairingGateway, pairingRows } from './tool-pairing-fixture.js';
import { orderModeToolResults } from '../src/tool_history.js';
import { TITLE_MAX_TOKENS } from '../src/session_title.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { cleanup, scratch } from './helpers.js';
import type { Message } from '../src/types.js';

for (const protocol of ['anthropic', 'openai'] as const)
  for (const direction of ['enter', 'exit-manual', 'exit-auto'] as const)
    test(`${protocol}: ${direction} keeps all three tool results before the mode boundary on the wire`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'circle-mode-pairing-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const workspace = join(root, 'workspace'),
        home = join(root, 'home');
      mkdirSync(workspace);
      mkdirSync(home);
      writeFileSync(join(workspace, 'a.txt'), 'alpha');
      writeFileSync(join(workspace, 'b.txt'), 'beta');
      const gateway = await pairingGateway(
        protocol,
        direction === 'enter' ? 'plan_enter' : 'plan_exit',
      );
      t.after(gateway.close);
      const settings = trustFolder(defaultSettings(), workspace);
      settings.initialized = true;
      settings.update_check = false;
      settings.default_thinking = '';
      settings.auth = {
        ...settings.auth,
        protocol,
        base_url: gateway.base,
        model: 'gateway',
      };
      saveCredentials({ api_key: 'fixture' }, home);
      saveSettings(settings, home);
      const model = new GatewayModel(settings, home);
      const runtime = new AgentRuntime({
        home,
        workspace,
        settings,
        model,
        headless: true,
        question: async () =>
          JSON.stringify([
            [
              direction === 'exit-auto'
                ? 'implement in auto mode'
                : 'implement with manual approval',
            ],
          ]),
      });
      t.after(() => runtime.close());
      if (direction !== 'enter') runtime.setMode('plan');
      const result = await runtime.harness.run(
        'change plan mode and read both files',
      );
      // The prompt asks for a session title after the turn. That request carries
      // no tool history and is not one of the turn requests counted here.
      const turns = () =>
        gateway.requests.filter(
          (r) =>
            (r.body as { max_tokens?: number }).max_tokens !== TITLE_MAX_TOKENS,
        );
      assert.equal(result.answer, 'paired response');
      assert.equal(turns().length, 2);
      assert.equal(
        runtime.mode,
        direction === 'enter'
          ? 'plan'
          : direction === 'exit-auto'
            ? 'auto'
            : 'manual',
      );
      const raw = runtime.store.messages(runtime.session.id);
      const ai = raw.findIndex((m) => m.tool_calls?.length === 3);
      assert.ok(ai >= 0);
      assert.equal(
        raw[ai + 1]!.internal,
        'mode-boundary',
        'the original transition remains at its real position',
      );
      const results = raw.filter((m) => m.role === 'tool');
      assert.equal(results.length, 3);
      assert.ok(results.every((m) => m.status === 'success'));
      assert.match(results[1]!.content, /alpha/);
      assert.match(results[2]!.content, /beta/);
      const before = runtime.store.tree(runtime.session.id);
      await runtime.harness.run('continue');
      assert.deepEqual(
        runtime.store.tree(runtime.session.id).slice(0, before.length),
        before,
      );
      assert.equal(turns().length, 3);
      assert.ok(gateway.requests.every((r) => !r.error));
      const beforeRestart = await pairingRows(home, runtime.session.id);
      const id = runtime.session.id;
      await runtime.close();
      const { spawn } = await import('node:child_process');
      const resultFromCLI = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            'src/cli.ts',
            '-p',
            'resume',
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
        let output = '',
          error = '';
        child.stdout.on('data', (b) => (output += b));
        child.stderr.on('data', (b) => (error += b));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve(output) : reject(Error(error)),
        );
        child.stdin.end();
      });
      assert.match(resultFromCLI, /paired response/);
      assert.equal(turns().length, 4);
      assert.deepEqual(
        (await pairingRows(home, id)).slice(0, beforeRestart.length),
        beforeRestart,
      );
    });

test('request projection moves only mode boundaries and never fabricates or hides missing results', () => {
  const call: Message = {
    id: 'ai',
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'a', name: 'read_file', args: {} },
      { id: 'b', name: 'read_file', args: {} },
    ],
  };
  const result = (id: string): Message => ({
    id: 'result-' + id,
    role: 'tool',
    tool_call_id: id,
    content: id,
  });
  const boundary = (id: string): Message => ({
    id,
    role: 'user',
    internal: 'mode-boundary',
    content: id,
  });
  for (const group of [
    [boundary('on'), result('a'), result('b')],
    [result('a'), boundary('off'), result('b')],
    [boundary('on'), result('a'), boundary('off'), result('b')],
  ]) {
    const raw = [call, ...group];
    const before = structuredClone(raw);
    const projected = orderModeToolResults(raw);
    assert.deepEqual(projected, [
      call,
      ...group.filter((m) => m.role === 'tool'),
      ...group.filter((m) => m.internal === 'mode-boundary'),
    ]);
    assert.deepEqual(
      orderModeToolResults(projected),
      projected,
      'projection is idempotent',
    );
    assert.deepEqual(raw, before);
  }
  const ordinary: Message = {
    id: 'person',
    role: 'user',
    content: 'real user input',
  };
  for (const group of [
    [call, boundary('on'), result('a')],
    [call, result('a'), ordinary, result('b')],
    [call, boundary('on'), result('a'), result('a'), result('b')],
    [call, boundary('on'), result('a'), result('unexpected')],
  ])
    assert.deepEqual(
      orderModeToolResults(group),
      group,
      'incomplete, duplicate or unrelated tool results remain visible',
    );
  const imported: Message = {
    id: 'import',
    role: 'assistant',
    content: '',
    provider_content: [
      { type: 'tool_use', id: 'a', name: 'read_file', input: {} },
    ],
  };
  assert.deepEqual(
    orderModeToolResults([imported, boundary('on'), result('a')]),
    [imported, result('a'), boundary('on')],
  );
});

for (const protocol of ['anthropic', 'openai'] as const)
  test(`${protocol}: hook and job notices keep tool results adjacent on the wire without rewriting history`, async (t) => {
    const home = scratch(t);
    const store = new CheckpointStore(home);
    cleanup(t, () => store.close());
    const session = store.create(home, 'gateway');
    const raw: Message[] = [
      { id: 'user', role: 'user', content: 'Read the files' },
      {
        id: 'calls',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', name: 'read_file', args: { file_path: 'a.txt' } },
          { id: 'b', name: 'read_file', args: { file_path: 'b.txt' } },
        ],
      },
      { id: 'a-result', role: 'tool', tool_call_id: 'a', content: 'alpha' },
      {
        id: 'hook',
        role: 'user',
        internal: 'hook_notice',
        content: 'Hook allowed the read',
      },
      {
        id: 'job',
        role: 'user',
        internal: 'job_notice',
        content: 'A job finished',
      },
      { id: 'b-result', role: 'tool', tool_call_id: 'b', content: 'beta' },
    ];
    store.append(session.id, raw);
    const before = await pairingRows(home, session.id);
    const gateway = await pairingGateway(protocol);
    cleanup(t, gateway.close);
    const settings = defaultSettings();
    settings.auth = {
      ...settings.auth,
      protocol,
      base_url: gateway.base,
      model: 'gateway',
    };
    saveCredentials({ api_key: 'fixture' }, home);
    const model = new GatewayModel(settings, home);
    await model.complete({
      system: 'system',
      messages: store.messages(session.id),
      tools: [],
      signal: new AbortController().signal,
      token: () => {},
    });
    assert.equal(gateway.requests.length, 1);
    assert.equal(gateway.requests[0]!.error, undefined);
    const sent = gateway.requests[0]!.body.messages;
    if (protocol === 'openai') {
      const index = sent.findIndex((message) => message.tool_calls?.length);
      assert.deepEqual(
        sent.slice(index + 1, index + 3).map((message) => message.tool_call_id),
        ['a', 'b'],
      );
    } else {
      const index = sent.findIndex(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((block: any) => block.type === 'tool_use'),
      );
      assert.deepEqual(
        sent[index + 1]!.content.slice(0, 2).map(
          (block: any) => block.tool_use_id,
        ),
        ['a', 'b'],
      );
    }
    assert.ok(JSON.stringify(sent).includes('Hook allowed the read'));
    assert.ok(JSON.stringify(sent).includes('A job finished'));
    assert.deepEqual(await pairingRows(home, session.id), before);
  });

test('request projection moves hook and job notices recorded inside a parallel batch after all of its results', () => {
  // The shape of a real session: a before_tool hook allows each call of a parallel batch
  // as it runs, so its notice lands between two results. A gateway that checks Chat
  // Completions order refused the whole history with "an assistant message with
  // 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'".
  const call: Message = {
    id: 'ai',
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'a', name: 'skill', args: {} },
      { id: 'b', name: 'hub_list_task_packs', args: {} },
      { id: 'c', name: 'read_file', args: {} },
    ],
  };
  const result = (id: string): Message => ({
    id: 'result-' + id,
    role: 'tool',
    tool_call_id: id,
    content: id,
  });
  const note = (id: string, internal: string): Message => ({
    id,
    role: 'user',
    internal,
    content: `<system-reminder data-source="circle-hooks">\n${id}\n</system-reminder>`,
  });
  const raw = [
    call,
    result('a'),
    note('hook allowed skill', 'hook_notice'),
    result('b'),
    note('job j1 ended', 'job_notice'),
    note('hook allowed read_file', 'hook_notice'),
    result('c'),
  ];
  const before = structuredClone(raw);
  const projected = orderModeToolResults(raw);
  assert.deepEqual(
    projected.map((m) => m.id),
    [
      'ai',
      'result-a',
      'result-b',
      'result-c',
      'hook allowed skill',
      'job j1 ended',
      'hook allowed read_file',
    ],
  );
  assert.deepEqual(orderModeToolResults(projected), projected);
  assert.deepEqual(raw, before, 'the stored history is not changed');
  const ordinary: Message = { id: 'person', role: 'user', content: 'steer' };
  const unanswered = [call, result('a'), note('n', 'hook_notice'), result('b')];
  assert.deepEqual(
    orderModeToolResults(unanswered),
    unanswered,
    'an incomplete batch stays as stored',
  );
  const steered = [call, result('a'), ordinary, result('b'), result('c')];
  assert.deepEqual(
    orderModeToolResults(steered),
    steered,
    'only Circle notes move; a person’s message stays where it was',
  );
});
