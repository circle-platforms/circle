import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FileMutations } from '../src/file_mutations.js';
import { oldStringMissing } from '../src/edit_miss.js';
import { Sandbox } from '../src/sandbox.js';
import { buildTools } from '../src/tools.js';
import type { ToolContext } from '../src/types.js';
import { scratch } from './helpers.js';

const context: ToolContext = {
  sessionId: 's',
  signal: new AbortController().signal,
};

// A workspace, Circle's own folder, and a folder outside both, with one file granted in it
function world(t: TestContext, desktop: boolean) {
  const workspace = realpathSync.native(scratch(t));
  const offload = realpathSync.native(scratch(t));
  const outside = realpathSync.native(scratch(t));
  mkdirSync(join(workspace, 'src'));
  writeFileSync(join(workspace, 'src', 'app.ts'), 'SYNTHETIC-WORKSPACE-LINE\n');
  mkdirSync(join(workspace, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(workspace, '.git', 'refs', 'heads', 'main'), 'abc\n');
  mkdirSync(join(offload, 'large_tool_results'), { recursive: true });
  writeFileSync(
    join(offload, 'large_tool_results', 'r1.txt'),
    'SYNTHETIC-OFFLOAD-LINE\n',
  );
  writeFileSync(join(outside, 'private.txt'), 'SYNTHETIC-PRIVATE-LINE\n');
  writeFileSync(join(outside, 'granted.txt'), 'SYNTHETIC-GRANTED-LINE\n');
  const granted = join(outside, 'granted.txt');
  // The desktop's backend: outside the workspace, only the granted file
  const backend: FileMutations = {
    authorize(path) {
      if (path !== granted)
        throw Error(
          'file is outside this session workspace or lacks an exact-file grant',
        );
    },
    async read() {
      throw Error('not used');
    },
    async apply() {
      throw Error('no writes');
    },
  };
  const tools = buildTools(
    new Sandbox(workspace, offload),
    desktop ? { fileMutations: backend } : {},
  );
  const run = (name: string, args: Record<string, unknown>) =>
    Promise.resolve(
      tools.find((tool) => tool.name === name)!.run(args, context),
    );
  return { workspace, outside, granted, run };
}

test("in the desktop, grep, glob and ls keep to read_file's bounds", async (t) => {
  const w = world(t, true);
  const refused = /outside this session workspace or lacks an exact-file grant/;
  // Outside the workspace: what read_file refuses, grep does not show either
  await assert.rejects(
    w.run('read_file', { file_path: join(w.outside, 'private.txt') }),
    refused,
  );
  await assert.rejects(
    w.run('grep', {
      pattern: 'SYNTHETIC',
      path: w.outside,
      output_mode: 'content',
    }),
    refused,
  );
  await assert.rejects(
    w.run('grep', {
      pattern: 'SYNTHETIC',
      path: join(w.outside, 'private.txt'),
      output_mode: 'content',
    }),
    refused,
  );
  await assert.rejects(w.run('ls', { path: w.outside }), refused);
  await assert.rejects(
    w.run('glob', { pattern: '*', path: w.outside }),
    refused,
  );
  // A pattern cannot leave `path` instead
  for (const pattern of [join(w.outside, '*'), '../**/*.txt', '~/*'])
    await assert.rejects(
      w.run('glob', { pattern }),
      /the glob pattern is matched inside path/,
      pattern,
    );
  // The one granted file may be searched, as it may be read
  assert.match(
    String(
      await w.run('grep', {
        pattern: 'SYNTHETIC',
        path: w.granted,
        output_mode: 'content',
      }),
    ),
    /SYNTHETIC-GRANTED-LINE/,
  );
  // Circle's own folders and the workspace stay searchable
  assert.match(
    String(
      await w.run('grep', {
        pattern: 'SYNTHETIC',
        path: '/large_tool_results',
        output_mode: 'content',
      }),
    ),
    /SYNTHETIC-OFFLOAD-LINE/,
  );
  assert.match(
    String(
      await w.run('grep', { pattern: 'SYNTHETIC', output_mode: 'content' }),
    ),
    /SYNTHETIC-WORKSPACE-LINE/,
  );
  assert.match(String(await w.run('ls', { path: 'src' })), /app\.ts/);
  assert.match(String(await w.run('glob', { pattern: 'src/*.ts' })), /app\.ts/);
  // The repository's internals are refused to listing as to reading, saying what to use
  const git =
    /file is not available in this workspace: \.git; .*use git commands/;
  await assert.rejects(w.run('ls', { path: '.git/refs/heads' }), git);
  await assert.rejects(
    w.run('read_file', { file_path: '.git/refs/heads' }),
    git,
  );
  await assert.rejects(w.run('grep', { pattern: 'ref', path: '.git' }), git);
  await assert.rejects(w.run('glob', { pattern: '*', path: '.git' }), git);
});

test('in the terminal, which reads anywhere, listing and searching do too', async (t) => {
  const w = world(t, false);
  assert.match(
    String(
      await w.run('grep', {
        pattern: 'SYNTHETIC',
        path: w.outside,
        output_mode: 'content',
      }),
    ),
    /SYNTHETIC-PRIVATE-LINE/,
  );
  assert.match(String(await w.run('ls', { path: w.outside })), /private\.txt/);
  assert.match(
    // A glob pattern takes forward slashes, a Windows drive path included
    String(
      await w.run('glob', {
        pattern: join(w.outside, '*.txt').split(sep).join('/'),
      }),
    ),
    /private\.txt/,
  );
});

test("a path with '..' is refused with the absolute path to give instead", async (t) => {
  const w = world(t, true);
  await assert.rejects(
    w.run('ls', { path: '../' }),
    (error: Error) =>
      error.message.startsWith('Path traversal not allowed') &&
      error.message.includes(
        `give the absolute path ${join(w.workspace, '..')}`,
      ),
  );
});

test('an edit whose old text is not in the file says where the file has it and how', async (t) => {
  const content = 'function a() {\n const remove = 1;\n const sync = 2;\n}\n';
  // The same lines with other spacing: the file's lines, quoted, so their spaces show
  const spacing = oldStringMissing(
    content,
    '  const remove = 1;\n  const sync = 2;',
  );
  assert.match(
    spacing,
    /^oldString not found in content\. Lines 2-3 have the same text with other spacing/,
  );
  assert.ok(
    spacing.includes('\n2\t" const remove = 1;"\n3\t" const sync = 2;"'),
    spacing,
  );
  // Several such places
  assert.match(
    oldStringMissing('a\n  x\nb\n x\n', 'x'),
    /With other spacing it is at 2 places \(lines 2, 4\)/,
  );
  // The first line is there, what follows is not
  assert.match(
    oldStringMissing(content, ' const remove = 1;\n const later = 3;'),
    /Its first line is at line 2, but what follows differs/,
  );
  // Nothing like it
  assert.match(
    oldStringMissing(content, 'nothing like this'),
    /may have changed since it was read: read it again/,
  );
  // Through the edit tool, as the model meets it
  const w = world(t, false);
  writeFileSync(join(w.workspace, 'src', 'cache.ts'), content);
  await w.run('read_file', { file_path: 'src/cache.ts' });
  await assert.rejects(
    w.run('edit_file', {
      file_path: 'src/cache.ts',
      old_string: '  const remove = 1;',
      new_string: '  const remove = 10;',
    }),
    /Lines 2-2 have the same text with other spacing[\s\S]*2\t" const remove = 1;"/,
  );
});
