import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupMessages } from '../src/features/Conversation.tsx';
import type { Message } from '../src/model/types.ts';

const row = (
  id: string,
  role: Message['role'],
  extra: Partial<Message> = {},
): Message => ({
  id,
  parentId: null,
  role,
  text: '',
  at: '2026-10-22T00:00:00Z',
  ...extra,
});

const shape = (items: ReturnType<typeof groupMessages>) =>
  items.map((item) =>
    item.kind === 'tools'
      ? {
          kind: 'tools' as const,
          batchKey: item.batchKey,
          ids: item.rows.map((entry) => entry.id),
        }
      : { kind: 'message' as const, id: item.message.id },
  );

test('thinking-only steps fold in with their tools, even with thinking shown', () => {
  const messages = [
    row('think-1', 'assistant', { thinking: 'Check providers first.' }),
    row('tool-1', 'tool', {
      parentId: 'think-1',
      tool: {
        id: 'call-1',
        name: 'read_file',
        input: { file_path: 'src/providers.ts' },
        output: 'ok',
        status: 'success',
      },
    }),
    row('think-2', 'assistant', { thinking: 'Then patch native websearch.' }),
    row('tool-2', 'tool', {
      parentId: 'think-2',
      tool: {
        id: 'call-2',
        name: 'edit_file',
        input: { file_path: 'src/native_websearch.ts' },
        output: 'ok',
        status: 'success',
      },
    }),
    row('answer', 'assistant', { text: 'Done.' }),
  ];

  // One folded line for the steps; opened, it shows each step's thinking and calls.
  assert.deepEqual(shape(groupMessages(messages, { showThinking: true })), [
    {
      kind: 'tools',
      batchKey: 'think-1',
      ids: ['think-1', 'tool-1', 'think-2', 'tool-2'],
    },
    { kind: 'message', id: 'answer' },
  ]);
});

test('steps with hidden thinking share one ToolGroup', () => {
  const messages = [
    row('think-1', 'assistant', { thinking: 'Check providers first.' }),
    row('tool-1', 'tool', {
      parentId: 'think-1',
      tool: {
        id: 'call-1',
        name: 'read_file',
        input: { file_path: 'src/providers.ts' },
        output: 'ok',
        status: 'success',
      },
    }),
    row('think-2', 'assistant', { thinking: 'Then patch native websearch.' }),
    row('tool-2', 'tool', {
      parentId: 'think-2',
      tool: {
        id: 'call-2',
        name: 'edit_file',
        input: { file_path: 'src/native_websearch.ts' },
        output: 'ok',
        status: 'success',
      },
    }),
    row('answer', 'assistant', { text: 'Done.' }),
  ];

  assert.deepEqual(shape(groupMessages(messages)), [
    {
      kind: 'tools',
      batchKey: 'think-1',
      ids: ['think-1', 'tool-1', 'think-2', 'tool-2'],
    },
    { kind: 'message', id: 'answer' },
  ]);
});

test('tools-only rounds with different parentIds share one ToolGroup', () => {
  const messages = [
    row('tool-a1', 'tool', {
      parentId: 'asst-a',
      tool: {
        id: 'call-a1',
        name: 'read_file',
        input: { file_path: 'a.ts' },
        output: 'ok',
        status: 'success',
      },
    }),
    row('tool-a2', 'tool', {
      parentId: 'asst-a',
      tool: {
        id: 'call-a2',
        name: 'grep',
        input: { pattern: 'x' },
        output: 'ok',
        status: 'success',
      },
    }),
    row('tool-b1', 'tool', {
      parentId: 'asst-b',
      tool: {
        id: 'call-b1',
        name: 'edit_file',
        input: { file_path: 'b.ts' },
        output: 'ok',
        status: 'success',
      },
    }),
  ];

  assert.deepEqual(shape(groupMessages(messages)), [
    {
      kind: 'tools',
      batchKey: 'asst-a',
      ids: ['tool-a1', 'tool-a2', 'tool-b1'],
    },
  ]);
});

test('empty assistant placeholders still fold into their own tool group', () => {
  const messages = [
    row('empty', 'assistant'),
    row('tool-1', 'tool', {
      parentId: 'empty',
      tool: {
        id: 'call-1',
        name: 'ls',
        input: { path: 'src' },
        output: 'ok',
        status: 'success',
      },
    }),
  ];
  const shown = groupMessages(messages, { showThinking: true });
  assert.deepEqual(shape(shown), [
    { kind: 'tools', batchKey: 'empty', ids: ['empty', 'tool-1'] },
  ]);
});

test('an empty placeholder joins the tool batch before it', () => {
  const messages = [
    row('tool-a', 'tool', {
      parentId: 'asst-a',
      tool: {
        id: 'call-a',
        name: 'read_file',
        input: { file_path: 'a.ts' },
        output: 'ok',
        status: 'success',
      },
    }),
    row('empty', 'assistant'),
    row('tool-b', 'tool', {
      parentId: 'empty',
      tool: {
        id: 'call-b',
        name: 'ls',
        input: { path: 'src' },
        output: 'ok',
        status: 'success',
      },
    }),
  ];
  assert.deepEqual(shape(groupMessages(messages)), [
    { kind: 'tools', batchKey: 'asst-a', ids: ['tool-a', 'empty', 'tool-b'] },
  ]);
});

test('text between steps, and the step with the turn usage, keep their own lines', () => {
  const tool = (id: string, parentId: string) =>
    row(id, 'tool', {
      parentId,
      tool: {
        id,
        name: 'grep',
        input: { pattern: 'x' },
        output: 'ok',
        status: 'success',
      },
    });
  const messages = [
    tool('t1', 'a1'),
    tool('t2', 'a2'),
    row('said', 'assistant', { text: 'Found it.' }),
    tool('t3', 'a3'),
    row('end', 'assistant', {
      usage: { input: 10, output: 2, elapsed: '9s' },
    }),
  ];
  assert.deepEqual(shape(groupMessages(messages)), [
    { kind: 'tools', batchKey: 'a1', ids: ['t1', 't2'] },
    { kind: 'message', id: 'said' },
    { kind: 'tools', batchKey: 'a3', ids: ['t3'] },
    { kind: 'message', id: 'end' },
  ]);
});
