import assert from 'node:assert/strict';import { test } from 'node:test';
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

test('thinking-only assistant steps stay visible when showThinking is on', () => {
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

  const hidden = groupMessages(messages);
  assert.equal(hidden.length, 2);
  assert.equal(hidden[0]?.kind, 'tools');
  assert.equal(hidden[1]?.kind, 'message');

  const shown = groupMessages(messages, { showThinking: true });
  assert.deepEqual(
    shown.map((item) =>
      item.kind === 'tools'
        ? { kind: 'tools', ids: item.rows.map((row) => row.id) }
        : { kind: 'message', id: item.message.id },
    ),
    [
      { kind: 'message', id: 'think-1' },
      { kind: 'tools', ids: ['tool-1'] },
      { kind: 'message', id: 'think-2' },
      { kind: 'tools', ids: ['tool-2'] },
      { kind: 'message', id: 'answer' },
    ],
  );
});

test('empty assistant placeholders still fold into the tool group', () => {
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
  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.kind, 'tools');
  if (shown[0]?.kind === 'tools')
    assert.deepEqual(
      shown[0].rows.map((row) => row.id),
      ['empty', 'tool-1'],
    );
});
