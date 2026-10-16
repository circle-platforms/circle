import assert from 'node:assert/strict';
import test from 'node:test';
import { EventBus } from '../src/events.js';
import { jsonEvent, HeadlessProgress } from '../src/headless.js';

test('headless JSON keeps optional completion evidence and failure codes without changing legacy rows', () => {
  const bus = new EventBus();
  const completion = {
    reason: 'length',
    provider_reason: 'max_tokens',
    output_limit: 32000,
  };
  const assistant = (extra = {}) =>
    bus.emit('llm_end', {
      payload: {
        message: {
          id: 'partial',
          role: 'assistant',
          content: 'partial',
          ...extra,
        },
      },
    });
  assert.deepEqual(jsonEvent(assistant()), {
    type: 'assistant',
    id: 'partial',
    text: 'partial',
    tool_calls: [],
    usage: undefined,
  });
  assert.deepEqual(jsonEvent(assistant({ completion, truncated: true })), {
    type: 'assistant',
    id: 'partial',
    text: 'partial',
    tool_calls: [],
    usage: undefined,
    completion,
    truncated: true,
  });
  assert.deepEqual(
    jsonEvent(
      bus.emit('run_error', {
        payload: {
          message: 'model output limit reached; response incomplete',
          completion_failure: 'output_limit',
        },
      }),
    ),
    {
      type: 'error',
      message: 'model output limit reached; response incomplete',
      completion_failure: 'output_limit',
    },
  );
  assert.deepEqual(
    jsonEvent(
      bus.emit('run_error', { payload: { message: 'network failed' } }),
    ),
    {
      type: 'error',
      message: 'network failed',
    },
  );
});

test('headless progress does not add a competing completion diagnostic or double-count usage', () => {
  const lines: string[] = [];
  const progress = new HeadlessProgress(true, false, (line) =>
    lines.push(line),
  );
  const bus = new EventBus();
  bus.subscribe((event) => progress.event(event));
  bus.emit('llm_end', { usage: { input_tokens: 12, output_tokens: 32000 } });
  bus.emit('info', {
    payload: { model_notice: { event: 'output_budget_exhausted' } },
  });
  bus.emit('run_error', {
    payload: {
      message: 'model output limit reached; response incomplete',
      completion_failure: 'output_limit',
    },
  });
  assert.deepEqual(lines, []);
  assert.equal(progress.summary(), '↑ 12 · ↓ 32.0k');
});

test('headless blocked incomplete calls show their actual cause and never recommend bypassing approval', () => {
  const lines: string[] = [];
  const progress = new HeadlessProgress(true, false, (line) =>
    lines.push(line),
  );
  const bus = new EventBus();
  bus.subscribe((event) => progress.event(event));
  bus.emit('llm_end', {
    payload: {
      message: {
        id: 'incomplete',
        tool_calls: [
          {
            id: 'blocked',
            name: 'write_file',
            args: { file_path: 'blocked.txt' },
          },
        ],
      },
    },
  });
  bus.emit('tool_result', {
    payload: {
      id: 'blocked',
      name: 'write_file',
      status: 'error',
      output: 'not run: model output limit reached; response incomplete',
    },
  });
  assert.equal(
    lines.at(-1),
    '  ⎿ Write(blocked.txt) not run · model output limit reached; response incomplete',
  );
  assert.equal(progress.notRun, 1);
  assert.equal(progress.summary(), '↑ 0 · ↓ 0 · 1 call not run');
  assert.equal(
    lines.some((line) => line.includes('--yolo')),
    false,
  );
});
