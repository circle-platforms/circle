import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileUndoFoots, groupMessages } from '../src/features/Conversation.tsx';
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

const grep = (id: string, parentId: string) =>
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

test("the model's updates stay as text and each starts its own line of calls", () => {
  const messages = [
    row('note-1', 'assistant', {
      phase: 'commentary',
      text: 'Checking the logs first.',
    }),
    grep('t1', 'note-1'),
    grep('t2', 'a2'),
    row('note-2', 'assistant', {
      phase: 'commentary',
      text: 'The port was taken; looking at who holds it.',
    }),
    grep('t3', 'note-2'),
    row('answer', 'assistant', { phase: 'final_answer', text: 'Fixed.' }),
  ];
  assert.deepEqual(shape(groupMessages(messages)), [
    { kind: 'message', id: 'note-1' },
    { kind: 'tools', batchKey: 'note-1', ids: ['t1', 't2'] },
    { kind: 'message', id: 'note-2' },
    { kind: 'tools', batchKey: 'note-2', ids: ['t3'] },
    { kind: 'message', id: 'answer' },
  ]);
});

test('an update with no call after it stays as text, with calls before it or not', () => {
  assert.deepEqual(
    shape(
      groupMessages([
        grep('t1', 'a1'),
        row('note', 'assistant', { phase: 'commentary', text: 'Found it.' }),
        row('answer', 'assistant', { text: 'Done.' }),
      ]),
    ),
    [
      { kind: 'tools', batchKey: 'a1', ids: ['t1'] },
      { kind: 'message', id: 'note' },
      { kind: 'message', id: 'answer' },
    ],
  );
});

test('an update keeps its place when it stops streaming', () => {
  const update = (at: string) => [
    grep('t1', 'a1'),
    row('note', 'assistant', { phase: 'commentary', text: 'Next.', at }),
  ];
  assert.deepEqual(
    shape(groupMessages(update('streaming'))),
    shape(groupMessages(update('2026-10-22T00:00:00Z'))),
  );
});

test('models with and without the commentary channel show a run the same way', () => {
  const run = (phase?: 'commentary') => [
    row('n1', 'assistant', { text: 'One.', ...(phase ? { phase } : {}) }),
    grep('t1', 'n1'),
    row('n2', 'assistant', { text: 'Two.', ...(phase ? { phase } : {}) }),
    grep('t2', 'n2'),
    row('end', 'assistant', { text: 'Done.' }),
  ];
  assert.deepEqual(
    shape(groupMessages(run('commentary'))),
    shape(groupMessages(run())),
  );
});

test("file undo goes on the last row of a finished turn and not on a working session's", () => {
  const items = groupMessages([
    row('u1', 'user', { text: 'first' }),
    grep('t1', 'a1'),
    row('end-1', 'assistant', { text: 'Done.' }),
    row('u2', 'user', { text: 'second' }),
    row('note', 'assistant', { text: 'Working.' }),
    grep('t2', 'note'),
    row('u3', 'user', { text: 'third' }),
  ]);
  assert.deepEqual(
    [...fileUndoFoots(items, ['u1', 'u2'], false)],
    [
      [2, 'u1'],
      [5, 'u2'],
    ],
  );
  assert.equal(fileUndoFoots(items, ['u1', 'u2'], true).size, 0);
  assert.equal(fileUndoFoots(items, undefined, false).size, 0);
  assert.deepEqual([...fileUndoFoots(items, ['u3'], false)], [[6, 'u3']]);
});
