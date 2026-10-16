import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wrapModelCompletion } from '../src/model_wrapper.js';
import {
  emptyUsage,
  type ChatModel,
  type ModelRequest,
  type ModelResponse,
} from '../src/types.js';

class PrivateModel implements ChatModel {
  #window = 1234;
  #calls = 0;
  readonly name = 'private';
  get model() {
    return `private-${this.#window}`;
  }
  get contextWindow() {
    return this.#window;
  }
  get outputBudget() {
    return 123;
  }
  get imageInput() {
    return true;
  }
  get modelFacts() {
    return { contextWindow: this.#window, imageInput: true } as NonNullable<
      ChatModel['modelFacts']
    >;
  }
  updateWindow(value: number) {
    this.#window = value;
  }
  calls() {
    return this.#calls;
  }
  async complete(_request: ModelRequest): Promise<ModelResponse> {
    this.#calls++;
    return {
      message: { id: 'answer', role: 'assistant', content: this.model },
      usage: emptyUsage(),
    };
  }
}
function request(): ModelRequest {
  return {
    system: '',
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    token: () => {},
  };
}

test('completion wrapper preserves frozen models, dynamic capabilities, prototype and private method receivers', async () => {
  const model = Object.freeze(new PrivateModel());
  let calls = 0;
  const wrapped = wrapModelCompletion(model, async (value, invoke) => {
    calls++;
    return invoke(value);
  });
  assert.ok(wrapped instanceof PrivateModel);
  assert.equal(wrapped.constructor, PrivateModel);
  assert.ok('imageInput' in wrapped);
  assert.deepEqual(Object.keys(wrapped), Object.keys(model));
  assert.equal(wrapped.imageInput, true);
  assert.equal(wrapped.contextWindow, 1234);
  assert.equal(wrapped.outputBudget, 123);
  assert.equal(wrapped.modelFacts.contextWindow, 1234);
  assert.equal(wrapped.updateWindow, wrapped.updateWindow);
  wrapped.updateWindow(5678);
  assert.equal(wrapped.contextWindow, 5678);
  assert.equal(wrapped.modelFacts.contextWindow, 5678);
  assert.equal(wrapped.model, 'private-5678');
  const response = await wrapped.complete(request());
  assert.equal(response.message.content, 'private-5678');
  assert.equal(calls, 1);
  assert.equal(model.calls(), 1);
});
