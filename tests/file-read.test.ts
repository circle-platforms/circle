import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentRuntime } from '../src/runtime.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { prepareToolCall } from '../src/tool_call_compat.js';
import { buildTools } from '../src/tools.js';
import { cleanup, scratch } from './helpers.js';

test('file pagination skips zero-based source lines and accepts CRLF, CR and EOF without a phantom row', async (t) => {
  const root = scratch(t);
  const tools = buildTools(new Sandbox(root));
  const context = { signal: new AbortController().signal, sessionId: 'test' };
  for (const separator of ['\n', '\r\n', '\r']) {
    for (const finalNewline of ['', separator]) {
      writeFileSync(
        join(root, 'lines.txt'),
        ['one', 'two', '', 'four'].join(separator) + finalNewline,
      );
      const read = async (offset: number, limit: number) => {
        const call = prepareToolCall(
          {
            id: 'read',
            name: 'read_file',
            args: { file_path: 'lines.txt', offset, limit },
          },
          tools,
        );
        return call.tool.run(call.call.args, context);
      };
      assert.equal(await read(0, 1), '1: one');
      assert.equal(await read(1, 2), '2: two\n3: ');
      assert.equal(await read(-2, 1), '1: one');
      assert.equal(await read(3, 20), '4: four');
      assert.match(await read(0, 0), /no lines were read/);
      assert.match(await read(0, -3), /no lines were read/);
      assert.match(await read(4, 1), /offset 4.*4 lines.*0\.\.3/);
      assert.match(await read(120, 1), /offset 120.*4 lines.*0\.\.3/);
    }
  }
});

test('reads retain requested large windows, bound long rows and distinguish blank files from zero-line requests', async (t) => {
  const root = scratch(t);
  const tool = buildTools(new Sandbox(root)).find(
    (tool) => tool.name === 'read_file',
  )!;
  const context = { signal: new AbortController().signal, sessionId: 'test' };
  writeFileSync(
    join(root, 'large.txt'),
    Array.from({ length: 3001 }, (_, i) => `line ${i + 1}`).join('\n'),
  );
  const rows = (
    await tool.run({ file_path: 'large.txt', limit: 3000 }, context)
  ).split('\n');
  assert.equal(rows.length, 3000);
  assert.equal(rows.at(-1), '3000: line 3000');
  writeFileSync(join(root, 'long.txt'), 'x'.repeat(3000));
  assert.equal(
    await tool.run({ file_path: 'long.txt' }, context),
    `1: ${'x'.repeat(2000)}…\nSystem reminder: long line window (line 1 chars 0..2000 of 3000; pass char_offset=2000 (with char_limit=2000) to continue).`,
  );
  for (const contents of ['', ' \r\n\t']) {
    writeFileSync(join(root, 'blank.txt'), contents);
    assert.match(
      await tool.run({ file_path: 'blank.txt', limit: 0 }, context),
      /File exists but has empty contents/,
    );
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tool.run(
      { file_path: 'large.txt' },
      { ...context, signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
});

test('paged file results reach the next model request and remain identical after reopening the session', async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'source.txt'), 'alpha\nbeta\ngamma\ndelta\n');
  const model = new ScriptedModel([
    {
      message: {
        id: 'read',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'page',
            name: 'read_file',
            args: { file_path: 'source.txt', offset: 2, limit: 2 },
          },
        ],
      },
    },
    { message: { id: 'answer', role: 'assistant', content: 'done' } },
  ]);
  const options = {
    workspace: root,
    home: join(root, 'home'),
    settings: defaultSettings(),
    model,
  };
  const runtime = new AgentRuntime(options);
  cleanup(t, () => runtime.close());
  const harness = runtime.harness;
  await harness.run('Read the last two lines');
  const result = model.requests[1]!.messages.find(
    (message) => message.role === 'tool',
  )!;
  assert.equal(result.content, '3: gamma\n4: delta');
  const sessionId = runtime.session.id;
  await runtime.close();
  const reopened = new AgentRuntime(options);
  cleanup(t, () => reopened.close());
  assert.equal(
    reopened.store
      .messages(sessionId)
      .find((message) => message.role === 'tool')!.content,
    result.content,
  );
});

test('read_file pages long lines by Unicode code points with char_offset and char_limit', async (t) => {
  const root = scratch(t);
  const tool = buildTools(new Sandbox(root)).find(
    (entry) => entry.name === 'read_file',
  )!;
  const context = { signal: new AbortController().signal, sessionId: 'test' };
  const body =
    'a'.repeat(1999) + '😀' + 'middle-marker-' + 'b'.repeat(2980) + 'end!';
  writeFileSync(join(root, 'huge.txt'), body);

  const head = await tool.run({ file_path: 'huge.txt' }, context);
  assert.ok(!head.includes('\uFFFD'));
  assert.equal(
    head,
    `1: ${'a'.repeat(1999)}😀…\nSystem reminder: long line window (line 1 chars 0..2000 of 4998; pass char_offset=2000 (with char_limit=2000) to continue).`,
  );

  const mid = await tool.run(
    { file_path: 'huge.txt', char_offset: 2000, char_limit: 500 },
    context,
  );
  assert.match(mid, /^1: …middle-marker-b+/);
  assert.match(mid, /char_offset=2500 \(with char_limit=500\)/);

  const tail = await tool.run(
    { file_path: 'huge.txt', char_offset: 4990, char_limit: 50 },
    context,
  );
  assert.equal(
    tail,
    '1: …bbbbend!\nSystem reminder: long line window (line 1 chars 4990..4998 of 4998).',
  );

  const past = await tool.run(
    { file_path: 'huge.txt', char_offset: 5000, char_limit: 50 },
    context,
  );
  assert.match(
    past,
    /no characters were read.*longest line is 4998 characters/,
  );
});

test('write_file and apply_patch maintain per-session read state for subsequent edits', async (t) => {
  const root = scratch(t);
  const tools = buildTools(new Sandbox(root));
  const byName = new Map(tools.map((entry) => [entry.name, entry]));
  const context = { signal: new AbortController().signal, sessionId: 's1' };
  const other = { signal: new AbortController().signal, sessionId: 's2' };

  await byName
    .get('write_file')!
    .run({ file_path: 'fresh.txt', content: 'hello world\n' }, context);
  await byName.get('edit_file')!.run(
    {
      file_path: 'fresh.txt',
      old_string: 'hello',
      new_string: 'hi',
    },
    context,
  );
  await assert.rejects(
    byName.get('edit_file')!.run(
      {
        file_path: 'fresh.txt',
        old_string: 'hi',
        new_string: 'other',
      },
      other,
    ),
    /read_file must be called before editing/,
  );

  writeFileSync(join(root, 'existing.txt'), 'before\n');
  await byName
    .get('write_file')!
    .run({ file_path: 'existing.txt', content: 'after\n' }, context);
  await byName.get('edit_file')!.run(
    {
      file_path: 'existing.txt',
      old_string: 'after',
      new_string: 'edited',
    },
    context,
  );

  await byName.get('apply_patch')!.run(
    {
      patchText:
        '*** Begin Patch\n*** Add File: created.txt\n+one\n*** End Patch',
    },
    context,
  );
  await byName.get('edit_file')!.run(
    {
      file_path: 'created.txt',
      old_string: 'one',
      new_string: 'two',
    },
    context,
  );
  await byName.get('apply_patch')!.run(
    {
      patchText:
        '*** Begin Patch\n*** Update File: created.txt\n*** Move to: renamed.txt\n@@\n-two\n+three\n*** End Patch',
    },
    context,
  );
  await assert.rejects(
    byName.get('edit_file')!.run(
      {
        file_path: 'created.txt',
        old_string: 'three',
        new_string: 'four',
      },
      context,
    ),
    /read_file must be called/,
  );
  await byName.get('edit_file')!.run(
    {
      file_path: 'renamed.txt',
      old_string: 'three',
      new_string: 'four',
    },
    context,
  );
});
