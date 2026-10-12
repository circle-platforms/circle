import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ApprovalPolicy,
  ApprovalStore,
  SESSION_MODES,
} from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { Harness } from '../src/harness.js';
import { AgentRuntime } from '../src/runtime.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { buildTools } from '../src/tools.js';
import type { Message, ToolCall } from '../src/types.js';

const assistant = (
  content: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content,
  tool_calls: calls,
});

function policy(root: string) {
  return new ApprovalPolicy(new ApprovalStore(join(root, 'approvals')), root);
}

test('accept-edits answers for edits inside the workspace and asks for the rest', (t) => {
  const root = scratch(t);
  const rules = policy(root);
  const inside = { file_path: join(root, 'a.py'), content: 'x' };
  const outside = { file_path: join(root, '..', 'b.py'), content: 'x' };
  assert.equal(rules.mode('s'), 'manual');
  assert.equal(rules.needsApproval('write_file', inside, 's'), true);
  rules.setMode('s', 'accept-edits');
  assert.equal(rules.mode('s'), 'accept-edits');
  assert.equal(rules.yoloEnabled('s'), false);
  assert.equal(rules.needsApproval('write_file', inside, 's'), false);
  assert.equal(
    rules.needsApproval(
      'edit_file',
      { file_path: 'a.py', old_string: 'x', new_string: 'y' },
      's',
    ),
    false,
  );
  assert.equal(rules.needsApproval('write_file', outside, 's'), true);
  assert.equal(
    rules.needsApproval('delete', { path: join(root, 'a.py') }, 's'),
    true,
  );
  assert.equal(
    rules.needsApproval(
      'apply_patch',
      { patchText: '*** Begin Patch\n*** Delete File: a.py\n*** End Patch' },
      's',
    ),
    true,
  );
  assert.equal(
    rules.needsApproval('execute', { command: 'touch made' }, 's'),
    true,
  );
  // The mode belongs to one session.
  assert.equal(rules.needsApproval('write_file', inside, 'other'), true);
});

test('auto is the old yolo switch and manual clears it', (t) => {
  const root = scratch(t);
  const rules = policy(root);
  rules.setYolo('s', true);
  assert.equal(rules.mode('s'), 'auto');
  assert.equal(
    rules.needsApproval('execute', { command: 'touch made' }, 's'),
    false,
  );
  rules.setMode('s', 'manual');
  assert.equal(rules.yoloEnabled('s'), false);
  assert.equal(
    rules.needsApproval('execute', { command: 'touch made' }, 's'),
    true,
  );
  assert.deepEqual(SESSION_MODES, ['manual', 'accept-edits', 'plan', 'auto']);
});

test('in accept-edits the harness writes the file without asking and still asks before a command', async (t) => {
  // The policy compares resolved paths; the temporary folder is a link on macOS.
  const root = realpathSync(scratch(t));
  writeFileSync(join(root, 'calc.py'), 'def add(a, b):\n    return a - b\n');
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'scripted');
  const rules = policy(root);
  rules.setMode(session.id, 'accept-edits');
  const model = new ScriptedModel([
    {
      message: assistant('', [
        { id: 'read', name: 'read_file', args: { file_path: 'calc.py' } },
      ]),
    },
    {
      message: assistant('', [
        {
          id: 'edit',
          name: 'edit_file',
          args: {
            file_path: 'calc.py',
            old_string: 'a - b',
            new_string: 'a + b',
          },
        },
        {
          id: 'run',
          name: 'execute',
          args: { command: 'touch ran.txt' },
        },
      ]),
    },
    { message: assistant('done') },
  ]);
  const asked: ToolCall[] = [];
  const harness = new Harness({
    model,
    tools: buildTools(new Sandbox(root)),
    store,
    session,
    policy: rules,
    system: 'test',
    approve: async (call) => {
      asked.push(call);
      return 'reject';
    },
  });
  await harness.run('fix it');
  assert.equal(
    readFileSync(join(root, 'calc.py'), 'utf8'),
    'def add(a, b):\n    return a + b\n',
  );
  assert.deepEqual(
    asked.map((call) => call.name),
    ['execute'],
  );
  const results = model.requests[2]!.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.match(String(results[1]!.content), /Edited/);
  assert.match(String(results[2]!.content), /rejected/);
});

test('the runtime mode joins plan and the approval modes, and plan exit can accept edits', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    {
      message: assistant('', [{ id: 'exit', name: 'plan_exit', args: {} }]),
    },
    { message: assistant('ok') },
  ]);
  const questions: unknown[] = [];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    question: async (args) => {
      questions.push(args);
      return JSON.stringify([['implement plan, accept edits']]);
    },
  });
  cleanup(t, () => runtime.close());
  assert.equal(runtime.mode, 'manual');
  runtime.setMode('auto');
  assert.equal(runtime.policy.yoloEnabled(runtime.session.id), true);
  runtime.setMode('plan');
  assert.equal(runtime.harness.planMode, true);
  assert.equal(runtime.mode, 'plan');
  assert.equal(
    runtime.policy.mode(runtime.session.id),
    'manual',
    'leaving plan asks again',
  );
  await runtime.harness.run('done planning');
  assert.equal(questions.length, 1);
  assert.equal(runtime.harness.planMode, false);
  assert.equal(runtime.mode, 'accept-edits');
  const result = model.requests[1]!.messages.findLast(
    (message) => message.role === 'tool',
  );
  assert.match(String(result!.content), /accepted without asking/);
});
