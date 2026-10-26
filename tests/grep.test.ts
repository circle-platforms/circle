import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { AgentRuntime } from '../src/runtime.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { prepareToolCall } from '../src/tool_call_compat.js';
import { buildTools } from '../src/tools.js';
import { GREP_TRUNCATION_NOTE, readSearchableFile } from '../src/grep_tool.js';
import { cleanup, scratch } from './helpers.js';

function project(t: { after(fn: () => void): void }): string {
  const root = realpathSync(scratch(t));
  mkdirSync(join(root, 'src', 'app'), { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'top.py'), 'needle at the top\nnothing\n');
  writeFileSync(
    join(root, 'src', 'app', 'main.py'),
    'import os\nneedle = 1\r\nprint(needle)\n',
  );
  writeFileSync(join(root, 'src', 'app', 'view.ts'), 'const needle = 2;\n');
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'needle: yes\n');
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'needle\n');
  writeFileSync(join(root, '.env'), 'needle=secret\n');
  writeFileSync(join(root, 'data.bin'), Buffer.from('needle\0binary'));
  writeFileSync(join(root, 'regex.txt'), 'log.*Error and a|b\n');
  return root;
}
function grep(root: string) {
  const tools = buildTools(new Sandbox(root));
  const context = { signal: new AbortController().signal, sessionId: 'test' };
  return async (args: Record<string, unknown>): Promise<string> => {
    const call = prepareToolCall({ id: 'grep', name: 'grep', args }, tools);
    return call.tool.run(call.call.args, context);
  };
}

test("grep has deepagents' schema: a literal pattern, output_mode and max_count", (t) => {
  const tool = buildTools(new Sandbox(scratch(t))).find(
    (tool) => tool.name === 'grep',
  )!;
  const parameters = tool.parameters as {
    properties: Record<string, { enum?: string[]; default?: string }>;
    required: string[];
  };
  assert.deepEqual(Object.keys(parameters.properties), [
    'pattern',
    'path',
    'glob',
    'output_mode',
    'max_count',
  ]);
  assert.deepEqual(parameters.required, ['pattern']);
  assert.deepEqual(parameters.properties.output_mode!.enum, [
    'files_with_matches',
    'content',
    'count',
  ]);
  assert.equal(
    parameters.properties.output_mode!.default,
    'files_with_matches',
  );
  assert.match(tool.description, /literal string, not a regular expression/);
});

test('grep lists matching files by default, and shows content or counts on request', async (t) => {
  const root = project(t);
  const run = grep(root);
  // Credential files, binary files, .git and node_modules are not searched.
  assert.equal(
    await run({ pattern: 'needle' }),
    '/.github/workflows/ci.yml\n/src/app/main.py\n/src/app/view.ts\n/top.py',
  );
  assert.equal(
    await run({ pattern: 'needle', output_mode: 'count' }),
    '/.github/workflows/ci.yml: 1\n/src/app/main.py: 2\n/src/app/view.ts: 1\n/top.py: 1',
  );
  assert.equal(
    await run({ pattern: 'needle', path: 'src', output_mode: 'content' }),
    '/src/app/main.py:\n  2: needle = 1\n  3: print(needle)\n/src/app/view.ts:\n  1: const needle = 2;',
  );
  // The pattern is literal text.
  assert.equal(await run({ pattern: 'log.*Error' }), '/regex.txt');
  assert.equal(await run({ pattern: 'a|b' }), '/regex.txt');
  assert.equal(
    await run({ pattern: 'needle|nothing' }),
    'No matches found\n\nNote: grep matches literal text, not regex, so characters like `|`, `.*`, and `\\.` are searched verbatim. Search for the literal text you need instead; for `|` alternation, run a separate search per alternative.',
  );
  assert.equal(await run({ pattern: 'absent' }), 'No matches found');
  assert.equal(
    await run({ pattern: 'needle', path: 'missing' }),
    'No matches found',
  );
});

test('grep globs match the name at any depth, or the path when they contain a slash', async (t) => {
  const root = project(t);
  const run = grep(root);
  assert.equal(
    await run({ pattern: 'needle', glob: '*.py' }),
    '/src/app/main.py\n/top.py',
  );
  assert.equal(await run({ pattern: 'needle', glob: '/*.py' }), '/top.py');
  assert.equal(
    await run({ pattern: 'needle', glob: 'src/**/*.ts' }),
    '/src/app/view.ts',
  );
  assert.equal(
    await run({ pattern: 'needle', glob: '*.yml' }),
    '/.github/workflows/ci.yml',
  );
  assert.equal(
    await run({ pattern: 'needle', glob: '*.{ts,yml}' }),
    '/.github/workflows/ci.yml\n/src/app/view.ts',
  );
  await assert.rejects(
    run({ pattern: 'needle', glob: '../*.py' }),
    /Path traversal not allowed in glob pattern '\.\.\/\*\.py'/,
  );
});

test('grep stops at max_count, 1000 by default, and says the result is incomplete', async (t) => {
  const root = realpathSync(scratch(t));
  writeFileSync(join(root, 'a.txt'), 'hit\n'.repeat(3));
  writeFileSync(join(root, 'b.txt'), 'hit\n'.repeat(1200));
  const run = grep(root);
  // Exactly max_count matches with none left over is complete.
  assert.equal(
    await run({
      pattern: 'hit',
      path: 'a.txt',
      output_mode: 'count',
      max_count: 3,
    }),
    '/a.txt: 3',
  );
  assert.equal(
    await run({ pattern: 'hit', output_mode: 'count', max_count: 2 }),
    `/a.txt: 2\n\n${GREP_TRUNCATION_NOTE}`,
  );
  assert.equal(
    await run({ pattern: 'hit', output_mode: 'count' }),
    `/a.txt: 3\n/b.txt: 997\n\n${GREP_TRUNCATION_NOTE}`,
  );
  await assert.rejects(
    run({ pattern: 'hit', max_count: 0 }),
    /invalid arguments/,
  );
  await assert.rejects(
    run({ pattern: 'hit', output_mode: 'lines' }),
    /invalid arguments/,
  );
});

test('grep shows paths outside the folder as they are and does not follow links out of the search root', async (t) => {
  const root = realpathSync(scratch(t));
  const outside = realpathSync(scratch(t));
  writeFileSync(join(outside, 'far.txt'), 'needle far away\n');
  mkdirSync(join(root, 'inner'));
  let linked = true;
  try {
    symlinkSync(join(outside, 'far.txt'), join(root, 'inner', 'link.txt'));
  } catch {
    linked = false; // Windows without the right to make links
  }
  const run = grep(root);
  if (linked)
    assert.equal(await run({ pattern: 'needle' }), 'No matches found');
  assert.equal(
    await run({ pattern: 'needle', path: outside, output_mode: 'content' }),
    `${realpathSync.native(join(outside, 'far.txt')).split(sep).join('/')}:\n  1: needle far away`,
  );
});

test('the byte prefilter cannot miss a match: the line rules stay as they were', async (t) => {
  const root = realpathSync(scratch(t));
  writeFileSync(join(root, 'span.txt'), 'a\nb\n');
  writeFileSync(join(root, 'utf8.txt'), 'const 错误码 = 1;\n');
  writeFileSync(join(root, 'crlf.txt'), 'needle = 1\r\nprint\r\n');
  const run = grep(root);
  // The file bytes hold this pattern across a line end, but no single line does.
  assert.equal(await run({ pattern: 'a\nb' }), 'No matches found');
  // A multi-byte pattern is searched as the same bytes UTF-8 writes it as.
  assert.equal(await run({ pattern: '错误码' }), '/utf8.txt');
  assert.equal(
    await run({ pattern: '错误码', output_mode: 'content' }),
    '/utf8.txt:\n  1: const 错误码 = 1;',
  );
  // A match on a CRLF line is found, with the trailing return character dropped as before.
  assert.equal(
    await run({ pattern: 'needle = 1', output_mode: 'content' }),
    '/crlf.txt:\n  1: needle = 1',
  );
  // An empty pattern still matches every line.
  assert.equal(
    await run({ pattern: '', path: 'span.txt', output_mode: 'count' }),
    '/span.txt: 2',
  );
});

test('grep names the files it could not search instead of claiming nothing matched', async (t) => {
  const root = realpathSync(scratch(t));
  writeFileSync(join(root, 'top.txt'), 'needle here\n');
  // One byte over the 10 MB limit, with the needle in it: the size is known before the read,
  // so the file was not looked in, whatever the pattern is.
  writeFileSync(
    join(root, 'big.txt'),
    Buffer.concat([
      Buffer.alloc(10 * 1024 * 1024, 0x78),
      Buffer.from('needle\n'),
    ]),
  );
  // Not valid UTF-8. An ASCII needle still shows up in the bytes, so the byte search passes
  // the file on and it is the failed decode that gets told.
  writeFileSync(
    join(root, 'gbk.txt'),
    Buffer.concat([Buffer.from('needle '), Buffer.from([0xff, 0xfe])]),
  );
  const run = grep(root);
  assert.equal(
    await run({ pattern: 'needle' }),
    '/top.txt\n\n' +
      'Note: 2 files were not searched (1 over the 10 MB limit, 1 not UTF-8 text). ' +
      'A match could be in one of them: narrow the path or glob, or open the file with read_file.',
  );
  // With a non-ASCII pattern the decode is the filter, so a legacy 8-bit file is named as not
  // searched rather than reported as having no match: 错误 is two bytes, not one.
  writeFileSync(join(root, 'gbk2.txt'), Buffer.from([0xb4, 0xed, 0x0a])); // 错误 in GBK
  assert.match(
    await run({ pattern: '错误' }),
    /^No matches found\n\nNote: 3 files were not searched \(1 over the 10 MB limit, 2 not UTF-8 text\)/,
  );
});

test('binary and credential files are declared exclusions, not coverage gaps', async (t) => {
  const root = realpathSync(scratch(t));
  writeFileSync(join(root, 'ok.txt'), 'needle\n');
  writeFileSync(join(root, '.env'), 'needle=secret\n');
  writeFileSync(join(root, 'blob.bin'), Buffer.from('needle\0binary'));
  const run = grep(root);
  // docs/tools.md states these two are skipped by rule, so a search stays free of the note.
  assert.equal(await run({ pattern: 'needle' }), '/ok.txt');
});

test('the reader tells a vanished file from a refused one', (t) => {
  const root = realpathSync(scratch(t));
  const sandbox = new Sandbox(root);
  // Between the walk and the read a file can go away: nothing there could have held a
  // match, so the search does not claim a gap.
  assert.deepEqual(
    readSearchableFile(sandbox, join(root, 'gone.txt'), root, true),
    { excluded: true },
  );
  // A read the operating system refuses is a gap the model has to hear about. A folder is
  // the portable way to make a read fail: the walk only lists files, so this path stands in
  // for the refusal, not for a search the model can ask for.
  mkdirSync(join(root, 'a-folder'));
  assert.deepEqual(
    readSearchableFile(sandbox, join(root, 'a-folder'), root, true),
    { skip: 'unreadable' },
  );
});

test('the coverage note comes before the note about a hit match cap', async (t) => {
  const root = realpathSync(scratch(t));
  writeFileSync(join(root, 'hit.txt'), 'hit\nhit\nhit\n');
  writeFileSync(
    join(root, 'big.txt'),
    Buffer.alloc(10 * 1024 * 1024 + 1, 0x78),
  );
  const run = grep(root);
  assert.equal(
    await run({ pattern: 'hit', output_mode: 'count', max_count: 2 }),
    `/hit.txt: 2\n\nNote: 1 file was not searched (1 over the 10 MB limit). ` +
      'A match could be in one of them: narrow the path or glob, or open the file with read_file.' +
      `\n\n${GREP_TRUNCATION_NOTE}`,
  );
});

test('task requires subagent_type, and a call without it starts nothing', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    {
      message: {
        id: 'main',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'task', name: 'task', args: { description: 'look around' } },
        ],
      },
    },
    { message: { id: 'end', role: 'assistant', content: 'done' } },
  ]);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const task = runtime.harness.tools.find((tool) => tool.name === 'task')!;
  assert.deepEqual((task.parameters as { required: string[] }).required, [
    'description',
    'subagent_type',
  ]);
  await runtime.harness.run('delegate');
  assert.equal(model.requests.length, 2);
  const result = model.requests[1]!.messages.at(-1)!;
  assert.equal(result.role, 'tool');
  assert.match(result.content, /subagent_type/);
  assert.match(result.content, /no work was done/);
});
