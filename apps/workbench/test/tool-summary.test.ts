import test from 'node:test';
import assert from 'node:assert/strict';
import { toolSummary } from '../src/model/tool-summary.ts';
import type { Message, ToolCall } from '../src/model/types.ts';

function row(name: string): Message {
  const tool: ToolCall = {
    id: name,
    name,
    input: {},
    output: '',
    status: 'success',
  };
  return {
    id: name,
    parentId: null,
    role: 'tool',
    text: '',
    at: '',
    tool,
  };
}

test('a directory listing is not called a search', () => {
  assert.equal(toolSummary([row('ls')]).text, 'listed a directory');
  assert.equal(
    toolSummary([row('ls'), row('ls')]).text,
    'listed 2 directories',
  );
  assert.equal(toolSummary([row('glob')]).text, 'searched files once');
  assert.equal(toolSummary([row('grep')]).text, 'searched once');
  assert.equal(toolSummary([row('lsp')]).text, 'looked up a symbol');
  assert.match(
    toolSummary([row('ls'), row('grep')]).text,
    /listed a directory/,
  );
  assert.match(toolSummary([row('ls'), row('grep')]).text, /searched once/);
});
