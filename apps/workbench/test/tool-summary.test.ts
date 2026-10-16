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

function edit(status: ToolCall['status'], file: string, output = ''): Message {
  return {
    id: `${status}-${file}`,
    parentId: null,
    role: 'tool',
    text: '',
    at: '',
    tool: {
      id: `${status}-${file}`,
      name: 'write_file',
      input: {},
      output,
      status,
      filePath: file,
    },
  };
}

function call(name: string, status: ToolCall['status'], output = ''): Message {
  return {
    id: `${status}-${name}`,
    parentId: null,
    role: 'tool',
    text: '',
    at: '',
    tool: {
      id: `${status}-${name}`,
      name,
      input: {},
      output,
      status,
    },
  };
}

test('a pending command or listing waits, and a rejection says so', () => {
  assert.equal(
    toolSummary([call('execute', 'waiting')]).text,
    'waiting to run a command',
  );
  assert.equal(
    toolSummary([call('ls', 'waiting'), call('ls', 'waiting')]).text,
    'waiting to list 2 directories',
  );
  assert.equal(
    toolSummary([call('execute', 'error', 'The user rejected this tool call.')])
      .text,
    'rejected a command',
  );
  assert.equal(
    toolSummary([call('execute', 'running')]).text,
    'running a command',
  );
  assert.equal(
    toolSummary([call('execute', 'error', 'exit 1')]).text,
    'failed to run a command',
  );
});

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

test('an edit says whether it is waiting, rejected or failed', () => {
  assert.equal(
    toolSummary([edit('waiting', 'src/fib.py')]).text,
    'waiting to edit fib.py',
  );
  assert.equal(
    toolSummary([edit('running', 'src/fib.py')]).text,
    'editing fib.py',
  );
  assert.equal(
    toolSummary([
      edit('error', 'src/fib.py', 'The user rejected this tool call.'),
    ]).text,
    'rejected an edit to fib.py',
  );
  assert.equal(
    toolSummary([edit('error', 'src/fib.py', 'disk full')]).text,
    'failed to edit fib.py',
  );
  assert.equal(
    toolSummary([edit('success', 'src/fib.py')]).text,
    'edited fib.py',
  );
  assert.equal(
    toolSummary([
      edit('error', 'src/a.py', 'The user rejected this tool call.'),
      edit('error', 'src/b.py', 'The user rejected this tool call.'),
    ]).text,
    'rejected edits to 2 files',
  );
});
