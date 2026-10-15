import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { Harness } from '../src/harness.js';
import { Sandbox } from '../src/sandbox.js';
import { ScriptedModel } from '../src/testing.js';
import { buildTools } from '../src/tools.js';
import type { Message, ToolCall } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';
const assistant = (
  id: string,
  tool_calls?: Message['tool_calls'],
): Message => ({
  id,
  role: 'assistant',
  content: tool_calls ? '' : 'done',
  tool_calls,
});

test('accept-edits writes an existing file through a real workspace alias while refusing outside and credential writes', async (t) => {
  const base = scratch(t),
    workspace = join(base, 'workspace'),
    alias = join(base, 'workspace-alias'),
    home = join(base, 'home');
  mkdirSync(workspace);
  mkdirSync(home);
  symlinkSync(
    workspace,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  writeFileSync(join(workspace, 'calc.py'), 'return a - b\n');
  const outside = join(base, 'outside.txt');
  writeFileSync(outside, 'human-owned outside bytes\n');
  writeFileSync(join(workspace, '.env'), 'synthetic credential file\n');
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const session = store.create(alias, 'scripted');
  const policy = new ApprovalPolicy(
    new ApprovalStore(join(home, 'approvals')),
    alias,
  );
  policy.setMode(session.id, 'accept-edits');
  if (process.platform === 'win32') {
    const otherDrive = alias[0]!.toUpperCase() === 'Z' ? 'Y' : 'Z';
    assert.equal(
      policy.needsApproval(
        'write_file',
        {
          file_path: `${otherDrive}:\\outside\\new.txt`,
          content: 'not authorized',
        },
        session.id,
      ),
      true,
      'a different volume cannot become a relative inside path',
    );
  }
  const model = new ScriptedModel([
    {
      message: assistant('read', [
        { id: 'read-file', name: 'read_file', args: { file_path: 'calc.py' } },
      ]),
    },
    {
      message: assistant('edit', [
        {
          id: 'edit-file',
          name: 'edit_file',
          args: {
            file_path: 'calc.py',
            old_string: 'a - b',
            new_string: 'a + b',
          },
        },
        {
          id: 'write-outside',
          name: 'write_file',
          args: { file_path: outside, content: 'not authorized' },
        },
        {
          id: 'write-credential',
          name: 'write_file',
          args: { file_path: '.env', content: 'not authorized' },
        },
        {
          id: 'execute',
          name: 'execute',
          args: { command: 'echo requires approval' },
        },
      ]),
    },
    { message: assistant('done') },
  ]);
  const asked: ToolCall[] = [];
  const harness = new Harness({
    model,
    tools: buildTools(new Sandbox(alias)),
    store,
    session,
    policy,
    system: 'test',
    approve: async (call) => {
      asked.push(call);
      return 'reject';
    },
  });
  await harness.run('fix this file through the granted alias');
  const results = model.requests[2]!.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.equal(
    readFileSync(join(workspace, 'calc.py'), 'utf8'),
    'return a + b\n',
    JSON.stringify({ asked, results }),
  );
  assert.deepEqual(
    asked.map((call) => call.id),
    ['write-outside', 'execute'],
  );
  assert.equal(
    results.find((message) => message.tool_call_id === 'edit-file')?.status,
    'success',
  );
  assert.equal(
    results.find((message) => message.tool_call_id === 'write-outside')?.status,
    'error',
  );
  assert.equal(
    results.find((message) => message.tool_call_id === 'write-credential')
      ?.status,
    'error',
  );
  assert.equal(readFileSync(outside, 'utf8'), 'human-owned outside bytes\n');
  assert.equal(
    readFileSync(join(workspace, '.env'), 'utf8'),
    'synthetic credential file\n',
  );
});
