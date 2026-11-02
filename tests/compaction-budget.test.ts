import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageTokens } from '../src/context_middleware.js';
import { tokenLen } from '../src/middleware/tool_result_prune.js';
import {
  resolveBudget,
  requestBudget,
  BudgetExceeded,
  providerInputEstimate,
} from '../src/request_budget.js';
import { ScriptedModel } from '../src/testing.js';

test('stored Anthropic blocks do not count tool arguments twice', () => {
  const args = { command: 'x'.repeat(12000) };
  const blocks = [
    { type: 'tool_use', id: 'call', name: 'execute', input: args },
  ];
  assert.equal(
    messageTokens([
      {
        id: 'a',
        role: 'assistant',
        content: '',
        provider_content: blocks,
        tool_calls: [{ id: 'call', name: 'execute', args }],
      },
    ]),
    4 + tokenLen(JSON.stringify(blocks)),
  );
});

for (const window of [8192, 32000, 128000, 200000, 1000000]) {
  test(`summary budget reserves input, output and margin in a ${window} window`, () => {
    const model = Object.assign(new ScriptedModel(), {
      contextWindow: window,
      modelFacts: {
        contextWindow: window,
        windowKnown: true,
        windowSource: 'settings' as const,
        outputLimit: 4096,
        provider: '',
        priceProvider: '',
        model: 'scripted',
      },
    });
    const limits = resolveBudget(model);
    assert.equal(limits.output, Math.min(4096, Math.floor(window / 4)));
    const budget = requestBudget(model, {
      system: 'summarize',
      messages: [],
      tools: [],
      maxTokens: limits.output,
    });
    assert.ok(budget.input + budget.output + budget.margin <= window);
    assert.ok(budget.output <= 4096);
  });
}

test('a separate input limit constrains a large window and fixed overhead can be impossible', () => {
  const model = Object.assign(new ScriptedModel(), {
    contextWindow: 128000,
    inputLimit: 4000,
  });
  const budget = requestBudget(model, {
    system: 'x'.repeat(20000),
    messages: [],
    tools: [],
  });
  assert.equal(budget.fits, false);
  assert.throws(() => {
    if (!budget.fits) throw new BudgetExceeded(budget);
  }, /context|budget/);
});

test('media-shaped tool JSON is counted in full while actual provider media uses a bounded estimate', () => {
  const data = 'a'.repeat(40000);
  const tool = {
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool',
            name: 'store',
            input: { type: 'image', source: { type: 'base64', data } },
          },
        ],
      },
    ],
  };
  const media = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', data } }],
      },
    ],
  };
  assert.ok(providerInputEstimate(tool) > 10000);
  assert.ok(providerInputEstimate(media) < 2200);
});
