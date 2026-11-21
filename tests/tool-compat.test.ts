import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import {
  prepareToolCall,
  parseToolInput,
  RecoverableToolError,
} from '../src/tool_call_compat.js';
import { buildTools } from '../src/tools.js';
import { Sandbox } from '../src/sandbox.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { redact } from '../src/redact.js';
import { scratch, cleanup } from './helpers.js';
import type { Message, Tool } from '../src/types.js';
test('read-only call aliases, field spellings and one-element string lists are repaired unambiguously', async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'a.txt'), 'hello\n');
  const tools = buildTools(new Sandbox(root));
  const repaired = prepareToolCall(
    {
      id: 'call',
      name: 'Read_File',
      args: { filePath: ['a.txt'], offset: '0' },
    },
    tools,
  );
  assert.equal(repaired.call.name, 'read_file');
  assert.deepEqual(repaired.call.args, { file_path: 'a.txt', offset: 0 });
  const result = await repaired.tool.run(repaired.call.args, {
    signal: new AbortController().signal,
    sessionId: 'test',
  });
  assert.match(result, /1: hello/);
  for (const name of ['Write_File', 'Execute', 'write file'])
    assert.throws(
      () => prepareToolCall({ id: name, name, args: {} }, tools),
      RecoverableToolError,
    );
  assert.throws(
    () =>
      prepareToolCall(
        {
          id: 'ambiguous',
          name: 'read_file',
          args: { filePath: 'a', file_path: 'b' },
        },
        tools,
      ),
    /ambiguous aliases/,
  );
});
test('nested JSON strings and malformed Unicode escapes are repaired, while validation errors disclose types and fields only', () => {
  const tool: Tool = {
    name: 'inspect',
    description: '',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        records: {
          type: 'array',
          items: {
            type: 'object',
            properties: { count: { type: 'integer' } },
            required: ['count'],
          },
        },
      },
      required: ['records'],
    },
    run: async () => 'ok',
  };
  const repaired = prepareToolCall(
    { id: 'one', name: 'inspect', args: { records: '[{"count":2}]' } },
    [tool],
  );
  assert.deepEqual(repaired.call.args, { records: [{ count: 2 }] });
  assert.deepEqual(parseToolInput('{"value":"\\u 00e9"}'), { value: 'é' });
  assert.throws(
    () =>
      prepareToolCall(
        {
          id: 'bad',
          name: 'inspect',
          args: { records: [{ count: 'private-value-should-not-appear' }] },
        },
        [tool],
      ),
    (error) => {
      assert.ok(error instanceof RecoverableToolError);
      assert.match(error.message, /count.*integer/);
      assert.ok(!error.message.includes('private-value'));
      return true;
    },
  );
});
test('the real tool boundary rejects malformed and misspelled mutable calls before any effect and gives the model a recoverable result', async (t) => {
  const root = scratch(t);
  const replies: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'one',
          name: 'Write_File',
          args: { file_path: 'should-not-exist', content: 'wrong' },
        },
      ],
    },
    {
      id: 'a2',
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'two',
          name: 'write_file',
          args: {},
          raw_args: 'not json',
          argument_error: 'invalid arguments JSON',
        },
      ],
    },
    { id: 'a3', role: 'assistant', content: 'fixed the request' },
  ];
  const model = new ScriptedModel(replies.map((message) => ({ message })));
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('test');
  assert.equal(existsSync(join(root, 'should-not-exist')), false);
  const errors = runtime.harness.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.equal(errors.length, 2);
  assert.ok(
    errors.every(
      (message) => message.recoverable && message.status === 'error',
    ),
  );
  assert.equal(model.requests[1]!.messages.at(-1)!.tool_call_id, 'one');
  assert.equal(model.requests[2]!.messages.at(-1)!.tool_call_id, 'two');
});
test('tool exceptions redact known credential shapes before model context and persistence', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    {
      message: {
        id: 'a',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'failure', name: 'fails', args: {} }],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'recovered' } },
  ]);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.harness.tools.push({
    name: 'fails',
    description: '',
    parameters: { type: 'object' },
    effect: 'read',
    run: async () => {
      throw new Error(
        'https://user:password@host.test password=supersecret Authorization: Bearer 123456789abcdef',
      );
    },
  });
  await runtime.harness.run('test');
  const result = runtime.harness.messages.find(
    (message) => message.tool_call_id === 'failure',
  )!;
  assert.ok(!result.content.includes('supersecret'));
  assert.ok(!result.content.includes('123456789abcdef'));
  assert.equal(model.requests[1]!.messages.at(-1)!.content, result.content);
  assert.match(redact('token=hello'), /token=\*\*\*/);
});
test('a value that does not match its pattern is told the field description and examples, or the pattern cut at 120 characters, in the next request', async (t) => {
  const root = scratch(t);
  const reference =
    '^(?:src:[0-9a-f]{4}|tree:[0-9a-f]{4}/(?:[a-z][a-z0-9_.-]{0,15}))$';
  // Over 1 KB, as reference patterns can be
  const long =
    '^(?:' +
    Array.from({ length: 80 }, (_, index) => `kind${index}:[0-9a-f]{64}`).join(
      '|',
    ) +
    ')$';
  assert.equal(long.length, 1595);
  let runs = 0;
  const model = new ScriptedModel([
    {
      message: {
        id: 'a',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'described', name: 'synthetic_get', args: { described: 'x' } },
          { id: 'bare', name: 'synthetic_get', args: { bare: 'x' } },
          { id: 'long', name: 'synthetic_get', args: { long: 'x' } },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.harness.tools.push({
    name: 'synthetic_get',
    description: '',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        described: {
          type: 'string',
          pattern: reference,
          description: 'A content reference, e.g. src:<4-hex-digest>',
          examples: ['src:0f3a', 'tree:0f3a/docs'],
        },
        bare: { type: 'string', pattern: reference },
        long: { type: 'string', pattern: long },
      },
    },
    run: async () => {
      runs++;
      return 'ran';
    },
  });
  await runtime.harness.run('get them');
  assert.equal(runs, 0);
  const read = Object.fromEntries(
    model.requests[1]!.messages.filter(
      (message) => message.role === 'tool',
    ).map((message) => [message.tool_call_id, message.content]),
  );
  assert.deepEqual(read, {
    described:
      'synthetic_get was called with invalid arguments: /described: must match the field\'s pattern, described as "A content reference, e.g. src:<4-hex-digest>", for example "src:0f3a" or "tree:0f3a/docs". Re-issue the call with arguments that satisfy the declared schema; no work was done.',
    bare: 'synthetic_get was called with invalid arguments: /bare: must match pattern "^(?:src:[0-9a-f]{4}|tree:[0-9a-f]{4}/(?:[a-z][a-z0-9_.-]{0,15}))$". Re-issue the call with arguments that satisfy the declared schema; no work was done.',
    long: 'synthetic_get was called with invalid arguments: /long: must match pattern "^(?:kind0:[0-9a-f]{64}|kind1:[0-9a-f]{64}|kind2:[0-9a-f]{64}|kind3:[0-9a-f]{64}|kind4:[0-9a-f]{64}|kind5:[0-9a-f]{64}|ki…" (pattern cut at 120 of 1595 characters). Re-issue the call with arguments that satisfy the declared schema; no work was done.',
  });
  const stored = runtime.harness.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.deepEqual(
    stored.map((message) => [message.status, message.recoverable]),
    [
      ['error', true],
      ['error', true],
      ['error', true],
    ],
  );
});
test('type, required and enum failures keep their short wording when the field has a description', () => {
  const tool: Tool = {
    name: 'synthetic_set',
    description: '',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name' },
        count: { type: 'integer', description: 'How many' },
        mode: {
          type: 'string',
          enum: ['fast', 'slow'],
          description: 'Which mode',
          examples: ['fast'],
        },
      },
      required: ['name'],
    },
    run: async () => 'ok',
  };
  assert.throws(
    () =>
      prepareToolCall(
        {
          id: 'set',
          name: 'synthetic_set',
          args: { count: 'many', mode: 'medium' },
        },
        [tool],
      ),
    {
      message:
        "synthetic_set was called with invalid arguments: <root>.name: must have required property 'name'; /count: must be integer; /mode: must be equal to one of the allowed values. Re-issue the call with arguments that satisfy the declared schema; no work was done.",
    },
  );
});
test('a pattern failure gives examples alone, only string ones, and cuts a long description without splitting a character', () => {
  const tool: Tool = {
    name: 'synthetic_list',
    description: '',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string', pattern: '^[a-z]+$', examples: [7, 'abc'] },
        },
        note: {
          type: 'string',
          pattern: '^n:',
          description: `${'x'.repeat(299)}😀 and more`,
        },
      },
    },
    run: async () => 'ok',
  };
  assert.throws(
    () =>
      prepareToolCall(
        {
          id: 'list',
          name: 'synthetic_list',
          args: { ids: ['ok', 'Private-Value'], note: 'private note' },
        },
        [tool],
      ),
    (error) => {
      assert.ok(error instanceof RecoverableToolError);
      assert.equal(
        error.message,
        `synthetic_list was called with invalid arguments: /ids/1: must match the field's pattern, for example "abc"; /note: must match the field's pattern, described as "${'x'.repeat(299)}😀…" (description cut at 300 of 309 characters). Re-issue the call with arguments that satisfy the declared schema; no work was done.`,
      );
      assert.ok(!error.message.includes('Private-Value'));
      assert.ok(!error.message.includes('private note'));
      return true;
    },
  );
});
test('unambiguous parameter synonyms normalize before schema checks, and unexpected fields name themselves and allowed keys', async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'note.txt'), 'hello\n');
  const tools = buildTools(new Sandbox(root));

  const readCall = prepareToolCall(
    { id: 'r1', name: 'read_file', args: { path: 'note.txt' } },
    tools,
  );
  assert.deepEqual(readCall.call.args, { file_path: 'note.txt' });

  const editCall = prepareToolCall(
    {
      id: 'e1',
      name: 'edit_file',
      args: { path: 'note.txt', old_text: 'hello', new_text: 'world' },
    },
    tools,
  );
  assert.deepEqual(editCall.call.args, {
    file_path: 'note.txt',
    old_string: 'hello',
    new_string: 'world',
  });

  const lsCall = prepareToolCall(
    { id: 'l1', name: 'ls', args: { directory: '.' } },
    tools,
  );
  assert.deepEqual(lsCall.call.args, { path: '.' });

  const execCall = prepareToolCall(
    { id: 'x1', name: 'execute', args: { cmd: 'echo hi' } },
    tools,
  );
  assert.deepEqual(execCall.call.args, { command: 'echo hi' });

  assert.throws(
    () =>
      prepareToolCall(
        {
          id: 'dup',
          name: 'read_file',
          args: { path: 'note.txt', file_path: 'note.txt' },
        },
        tools,
      ),
    /ambiguous aliases for field file_path/,
  );

  assert.throws(
    () =>
      prepareToolCall(
        {
          id: 'extra',
          name: 'execute',
          args: { command: 'echo hi', bogus_flag: 'secret-value-not-shown' },
        },
        tools,
      ),
    (error) => {
      assert.ok(error instanceof RecoverableToolError);
      assert.match(
        error.message,
        /<root>\.bogus_flag: unexpected property 'bogus_flag'; allowed properties: command, description, timeout, background/,
      );
      assert.ok(!error.message.includes('secret-value-not-shown'));
      return true;
    },
  );
});
