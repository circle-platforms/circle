import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness } from '../src/harness.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelCompletion, Tool } from '../src/types.js';
import type { CircleEvent } from '../src/events.js';
import { scratch, cleanup } from './helpers.js';

function setup(
  t: Parameters<typeof scratch>[0],
  replies: ConstructorParameters<typeof ScriptedModel>[0],
) {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const model = new ScriptedModel(replies);
  const session = store.create(root, model.model);
  const sideEffect = join(root, 'must-not-exist');
  const tool: Tool = {
    name: 'effect',
    description: 'write a sentinel',
    parameters: { type: 'object' },
    effect: 'read',
    run: async () => {
      writeFileSync(sideEffect, 'executed');
      return 'done';
    },
  };
  const harness = new Harness({
    model,
    store,
    session,
    tools: [tool],
    system: 'test',
    policy: new ApprovalPolicy(
      new ApprovalStore(join(root, 'approvals')),
      root,
    ),
  });
  const events: CircleEvent[] = [];
  harness.bus.subscribe((event) => events.push(event));
  return { root, store, model, session, harness, events, sideEffect };
}
function assistant(
  completion?: ModelCompletion,
  content = '',
  tools = false,
): Message {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content,
    ...(completion ? { completion } : {}),
    ...(tools
      ? { tool_calls: [{ id: 'call', name: 'effect', args: {} }] }
      : {}),
  };
}
const failures = [
  ['stop', 'empty_response'],
  ['length', 'output_limit'],
  ['missing', 'missing_finish'],
  ['filter', 'filtered'],
  ['pause', 'paused'],
  ['unknown', 'unknown_finish'],
] as const;
for (const [reason, code] of failures) {
  test(`${reason} fails once, preserves evidence and usage without completing`, async (t) => {
    const message = assistant(
      { reason, provider_reason: reason, output_limit: 32000 },
      reason === 'stop' ? '' : 'partial text',
    );
    message.provider_content = [
      { type: 'thinking', thinking: '', signature: 'untouched' },
    ];
    const usage = {
      input_tokens: 12,
      output_tokens: 32000,
      cache_read_tokens: 2,
    };
    const state = setup(t, [{ message, usage }]);
    await assert.rejects(state.harness.run('go'));
    assert.equal(state.model.requests.length, 1);
    assert.equal(state.events.filter((e) => e.kind === 'run_end').length, 0);
    const failure = state.events.find((e) => e.kind === 'run_error')!;
    assert.equal(failure.payload.completion_failure, code);
    assert.equal(failure.payload.completion_message_id, message.id);
    assert.deepEqual(failure.usage, usage);
    assert.deepEqual(
      state.store.messages(state.session.id).at(-1)?.completion,
      message.completion,
    );
    assert.deepEqual(
      state.store.messages(state.session.id).at(-1)?.provider_content,
      message.provider_content,
    );
    assert.equal(state.events.filter((e) => e.kind === 'llm_end').length, 1);
  });
}
for (const reason of [
  'length',
  'missing',
  'unknown',
  'filter',
  'pause',
] as const) {
  test(`${reason} prevents even valid tool arguments and repairs history without replay`, async (t) => {
    const message = assistant({ reason }, 'partial', true);
    const state = setup(t, [{ message }]);
    await assert.rejects(state.harness.run('go'));
    assert.equal(existsSync(state.sideEffect), false);
    assert.equal(state.model.requests.length, 1);
    const result = state.store.messages(state.session.id).at(-1)!;
    assert.equal(result.role, 'tool');
    assert.equal(result.tool_call_id, 'call');
    assert.equal(result.status, 'error');
    assert.match(result.content, /not run/);
    assert.equal(state.events.filter((e) => e.kind === 'tool_start').length, 0);
    // A reconstructed harness neither replays the failed request nor executes the call.
    const resumed = new Harness({
      ...state.harness.options,
      session: state.store.get(state.session.id)!,
    });
    assert.equal(resumed.messages.at(-1)?.id, result.id);
    assert.equal(state.model.requests.length, 1);
    assert.equal(existsSync(state.sideEffect), false);
  });
}
test('legacy truncated responses fail closed without inventing an output limit', async (t) => {
  const message = { ...assistant(undefined, 'partial', true), truncated: true };
  const state = setup(t, [{ message }]);
  await assert.rejects(state.harness.run('go'));
  assert.equal(existsSync(state.sideEffect), false);
  assert.equal(
    state.events.find((e) => e.kind === 'run_error')?.payload
      .completion_failure,
    'unknown_finish',
  );
  assert.equal(
    state.store.messages(state.session.id)[1]?.completion,
    undefined,
  );
});
test('old models without completion metadata remain compatible and completed tools do not replay', async (t) => {
  const state = setup(t, [
    { message: assistant(undefined, 'checking', true) },
    { message: assistant({ reason: 'length' }, 'partial') },
    { message: assistant(undefined, 'finished') },
  ]);
  await assert.rejects(state.harness.run('go'));
  assert.equal(existsSync(state.sideEffect), true);
  const firstResult = state.store
    .messages(state.session.id)
    .find((m) => m.role === 'tool');
  const result = await state.harness.run('continue');
  assert.equal(result.answer, 'finished');
  assert.equal(state.model.requests.length, 3);
  assert.equal(
    state.store.messages(state.session.id).filter((m) => m.role === 'tool')
      .length,
    1,
  );
  assert.equal(
    state.model.requests[2]!.messages.find((m) => m.role === 'tool')?.id,
    firstResult?.id,
  );
});
test('client repetition stop is incomplete even with visible text', async (t) => {
  const state = setup(t, [
    {
      message: assistant(
        { reason: 'missing', client_stop: 'repetition' },
        'repeated',
      ),
    },
  ]);
  await assert.rejects(state.harness.run('go'));
  assert.equal(
    state.events.find((e) => e.kind === 'run_error')?.payload
      .completion_failure,
    'repetition_stopped',
  );
});

test('failed completion survives a database reopen without replay or dangling tool calls', async (t) => {
  const state = setup(t, [
    {
      message: assistant(
        { reason: 'length', provider_reason: 'max_tokens' },
        '',
        true,
      ),
    },
  ]);
  await assert.rejects(state.harness.run('go'));
  const before = state.store.messages(state.session.id);
  state.store.close();
  const reopened = new CheckpointStore(state.root);
  cleanup(t, () => reopened.close());
  const resumed = new Harness({
    ...state.harness.options,
    store: reopened,
    session: reopened.get(state.session.id)!,
  });
  assert.deepEqual(resumed.messages, before);
  assert.equal(state.model.requests.length, 1);
  const { validateMessages } = await import('../src/session_graph.js');
  validateMessages(resumed.messages);
});

test('user cancellation after streaming does not save or retry a late response', async (t) => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const state = setup(t, [
    async (request) => {
      request.token('partial');
      entered();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      return {
        message: assistant({ reason: 'length' }, 'late'),
        usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0 },
      };
    },
  ]);
  const running = state.harness.run('go');
  const rejected = assert.rejects(running);
  await ready;
  await state.harness.cancel();
  await rejected;
  assert.equal(state.model.requests.length, 1);
  assert.equal(
    state.store.messages(state.session.id).filter((m) => m.role === 'assistant')
      .length,
    0,
  );
  assert.equal(state.events.filter((e) => e.kind === 'run_end').length, 0);
  assert.equal(
    state.events.find((e) => e.kind === 'run_error')?.payload.interrupted,
    true,
  );
  assert.equal(
    state.events.find((e) => e.kind === 'run_error')?.payload
      .completion_failure,
    undefined,
  );
});

test('steering aborts a late incomplete response and sends only the user steering next', async (t) => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const state = setup(t, [
    async (request) => {
      entered();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      return {
        message: assistant({ reason: 'length' }, 'late', true),
        usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0 },
      };
    },
    { message: assistant({ reason: 'stop' }, 'done') },
  ]);
  const running = state.harness.run('go');
  await ready;
  state.harness.queue('new direction');
  assert.equal(state.harness.steerNow(), true);
  assert.equal((await running).answer, 'done');
  assert.equal(state.model.requests.length, 2);
  assert.deepEqual(
    state.model.requests[1]!.messages.map((m) => m.content),
    ['go', 'new direction'],
  );
  assert.equal(existsSync(state.sideEffect), false);
  assert.equal(state.events.filter((e) => e.kind === 'run_error').length, 0);
});

test('a tool-call finish without any call cannot become a successful text answer', async (t) => {
  const state = setup(t, [
    {
      message: assistant(
        { reason: 'tool_calls', provider_reason: 'tool_use' },
        'preparing a call',
      ),
    },
  ]);
  await assert.rejects(state.harness.run('go'));
  assert.equal(
    state.events.find((e) => e.kind === 'run_error')?.payload
      .completion_failure,
    'unknown_finish',
  );
  assert.equal(state.model.requests.length, 1);
});

test('child incomplete responses propagate as task errors without child effects or repeated requests', async (t) => {
  const { AgentRuntime } = await import('../src/runtime.js');
  const { defaultSettings } = await import('../src/settings.js');
  const root = scratch(t);
  const taskCall = {
    id: 'child-task',
    name: 'task',
    args: { description: 'child work', subagent_type: 'general-purpose' },
  };
  const parent = {
    ...assistant({ reason: 'tool_calls' }),
    tool_calls: [taskCall],
  };
  const child = {
    ...assistant(
      { reason: 'length', provider_reason: 'max_tokens' },
      'child partial',
    ),
    tool_calls: [
      {
        id: 'child-write',
        name: 'write_file',
        args: { file_path: 'child-effect', content: 'must not write' },
      },
    ],
  };
  const model = new ScriptedModel([
    {
      message: parent,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0 },
    },
    {
      message: child,
      usage: { input_tokens: 3, output_tokens: 4, cache_read_tokens: 0 },
    },
    {
      message: assistant({ reason: 'stop' }, 'child failed safely'),
      usage: { input_tokens: 5, output_tokens: 6, cache_read_tokens: 0 },
    },
  ]);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
    bundledExtensions: false,
    screenshot: false,
  });
  cleanup(t, () => runtime.close());
  const events: CircleEvent[] = [];
  runtime.bus.subscribe((e) => events.push(e));
  await runtime.initialize();
  const result = await runtime.harness.run('parent work');
  assert.equal(result.answer, 'child failed safely');
  assert.equal(model.requests.length, 3);
  assert.equal(existsSync(join(root, 'child-effect')), false);
  const childFailure = events.find(
    (e) => e.kind === 'run_error' && e.tags.subagent,
  );
  assert.equal(childFailure?.payload.completion_failure, 'output_limit');
  assert.equal(
    events.filter((e) => e.kind === 'tool_start' && e.tags.subagent).length,
    0,
  );
  const taskResult = runtime.harness.messages.find(
    (m) => m.role === 'tool' && m.tool_call_id === 'child-task',
  )!;
  assert.equal(taskResult.status, 'error');
  assert.match(taskResult.content, /output limit/);
  assert.equal(
    model.requests[2]!.messages.find((m) => m.id === taskResult.id)?.content,
    taskResult.content,
  );
  const childSession = runtime.store.children(runtime.session.id)[0]!;
  const childMessages = runtime.store.messages(childSession.id);
  assert.equal(
    childMessages.find((m) => m.role === 'assistant')?.completion?.reason,
    'length',
  );
  assert.equal(childMessages.at(-1)?.status, 'error');
  assert.deepEqual(runtime.stats().usage, {
    input_tokens: 9,
    output_tokens: 12,
    cache_read_tokens: 0,
  });
});
