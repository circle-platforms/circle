import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { EventBus, type CircleEvent } from '../src/events.js';
import { Harness } from '../src/harness.js';
import { priceCall } from '../src/pricing.js';
import { ScriptedModel } from '../src/testing.js';
import { TurnStatus } from '../src/tui/turn_status.js';
import type { ToolModelCall, Usage } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const price = (model: string, usage: Usage) =>
  priceCall(
    {
      model,
      contextWindow: 4096,
      windowKnown: true,
      windowSource: 'settings',
      provider: 'fixture',
      priceProvider: 'fixture',
      rates: { input: 1, output: 2 },
    },
    usage,
  );

for (const fails of [false, true])
  test(`a ${fails ? 'failed' : 'successful'} search counts its helper tokens in the shared turn line and keeps the hosted fee unknown`, async (t) => {
    const root = scratch(t);
    const store = new CheckpointStore(root);
    cleanup(t, () => store.close());
    const session = store.create(root, 'scripted');
    const firstUsage = {
      input_tokens: 11,
      output_tokens: 2,
      cache_read_tokens: 0,
    };
    const lastUsage = {
      input_tokens: 17,
      output_tokens: 3,
      cache_read_tokens: 0,
    };
    const helperUsage = {
      input_tokens: 13,
      output_tokens: 5,
      cache_read_tokens: 0,
    };
    const helper: ToolModelCall = {
      model: 'actual-helper',
      usage: helperUsage,
      cost: { ...price('actual-helper', helperUsage), tool_fee_unknown: true },
      search_requests: 1,
    };
    const model = new ScriptedModel([
      {
        message: {
          id: 'search-call',
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'search', name: 'websearch', args: {} }],
        },
        usage: firstUsage,
      },
      {
        message: { id: 'answer', role: 'assistant', content: 'done' },
        usage: lastUsage,
      },
    ]);
    const bus = new EventBus(session.id);
    const turns = new TurnStatus();
    const results: CircleEvent[] = [];
    const harness = new Harness({
      model,
      store,
      session,
      bus,
      system: 'test',
      policy: new ApprovalPolicy(
        new ApprovalStore(join(root, 'approvals')),
        root,
      ),
      priceUsage: price,
      tools: [
        {
          name: 'websearch',
          description: 'synthetic search',
          parameters: { type: 'object', properties: {} },
          effect: 'read',
          async run(_args, context) {
            context.recordModelCall!(helper);
            if (fails) throw new Error('synthetic search failed');
            return 'synthetic result';
          },
        },
      ],
    });
    bus.subscribe((event) => {
      if (event.kind === 'tool_result') results.push(event);
      turns.apply(event, () => harness.messages.at(-1)?.id);
    });
    const outcome = await harness.run('search');
    const stored = store.messages(session.id).find((m) => m.role === 'tool')!;
    assert.equal(stored.status, fails ? 'error' : 'success');
    assert.deepEqual(results[0]!.payload.model_calls, stored.model_calls);
    assert.deepEqual(model.requests[1]!.messages.at(-1), stored);
    assert.equal(outcome.usage.input_tokens, 41);
    assert.equal(outcome.usage.output_tokens, 10);
    assert.equal(turns.usage.answer!.input, 41);
    assert.equal(turns.usage.answer!.output, 10);
    assert.equal(turns.usage.answer!.cost, null);
    assert.equal(turns.tokens, 10);
  });

test('shared turn accounting includes foreground helper receipts, excludes background helpers, and retains known dollar costs', () => {
  const turns = new TurnStatus();
  const bus = new EventBus('main');
  bus.subscribe((event) => turns.apply(event, () => 'answer'));
  const helperUsage = {
    input_tokens: 13,
    output_tokens: 5,
    cache_read_tokens: 0,
  };
  const helper: ToolModelCall = {
    model: 'helper',
    usage: helperUsage,
    cost: price('helper', helperUsage),
  };
  bus.emit('run_start');
  bus.emit('tool_result', {
    payload: { model_calls: [helper] },
    usage: helperUsage,
    tags: { subagent: 'foreground-child' },
  });
  // A normal non-model tool carries no usage or cost and changes neither total.
  bus.emit('tool_result', { payload: { id: 'read' } });
  bus.emit('tool_result', {
    payload: { model_calls: [{ ...helper, cost: undefined }] },
    usage: helperUsage,
    tags: { subagent: 'background-child', job_id: 'job' },
  });
  bus.emit('run_end');
  assert.equal(turns.usage.answer!.input, 13);
  assert.equal(turns.usage.answer!.output, 5);
  assert.equal(turns.usage.answer!.cost, helper.cost!.amount);
  assert.equal(turns.tokens, 5);
});
