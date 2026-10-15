import test from 'node:test';
import assert from 'node:assert/strict';
import { toolSummary } from '../src/components/ToolGroup.tsx';
import type { Message, ToolCall } from '../src/model/types.ts';
function row(status: string): Message {
  return {
    id: 'm1',
    parentId: null,
    role: 'tool',
    text: '',
    at: 'now',
    tool: {
      id: 'call1',
      name: 'execute',
      input: { command: 'node -v' },
      output: '',
      status: status as ToolCall['status'],
    },
  };
}

test('an unapproved command is described as waiting rather than already executed', () => {
  assert.match(toolSummary([row('waiting')]).text, /waiting for approval/);
  assert.doesNotMatch(toolSummary([row('waiting')]).text, /ran/);
});
test('cancelled, rejected and unknown calls do not claim command execution', () => {
  for (const status of ['cancelled', 'rejected', 'unknown'])
    assert.doesNotMatch(
      toolSummary([row(status)]).text,
      /ran|edited|read a file/,
    );
  assert.match(toolSummary([row('success')]).text, /ran a command/);
});
