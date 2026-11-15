import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { patchFilePaths, planPatch } from '../src/apply_patch.js';
import { readTextContentWindow, readTextWindow } from '../src/file_read.js';
import type { FileMutations } from '../src/file_mutations.js';
import { AgentRuntime } from '../src/runtime.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { buildTools } from '../src/tools.js';
import { cleanup, scratch } from './helpers.js';

test('patch planning uses one supplied snapshot and never writes, including move and delete', (t) => {
  const workspace = realpathSync(scratch(t));
  writeFileSync(join(workspace, 'a.txt'), 'disk content differs\n');
  writeFileSync(join(workspace, 'delete.txt'), 'delete from disk\n');
  const sandbox = new Sandbox(workspace);
  const canonicalWorkspace = realpathSync.native(workspace);
  const patch =
    '*** Begin Patch\n*** Update File: a.txt\n*** Move to: moved.txt\n@@\n-snapshot\n+updated\n*** Delete File: delete.txt\n*** End Patch';
  assert.deepEqual(
    patchFilePaths(patch, sandbox),
    ['a.txt', 'moved.txt', 'delete.txt'].map((path) =>
      join(canonicalWorkspace, path),
    ),
  );
  const planned = planPatch(patch, sandbox, (path) =>
    path === join(canonicalWorkspace, 'a.txt')
      ? 'snapshot\n'
      : path === join(canonicalWorkspace, 'delete.txt')
        ? 'snapshot delete\n'
        : null,
  );
  assert.deepEqual(
    planned.map(({ path, content }) => [path, content]),
    [
      [join(canonicalWorkspace, 'moved.txt'), 'updated\n'],
      [join(canonicalWorkspace, 'a.txt'), null],
      [join(canonicalWorkspace, 'delete.txt'), null],
    ],
  );
  assert.equal(
    readFileSync(join(workspace, 'a.txt'), 'utf8'),
    'disk content differs\n',
  );
  assert.equal(
    readFileSync(join(workspace, 'delete.txt'), 'utf8'),
    'delete from disk\n',
  );
  assert.equal(existsSync(join(workspace, 'moved.txt')), false);
});

test('versioned read windows exactly match streaming windows for every source-line separator', async (t) => {
  const workspace = realpathSync(scratch(t));
  const path = join(workspace, 'lines.txt');
  const signal = new AbortController().signal;
  for (const separator of ['\n', '\r\n', '\r']) {
    for (const suffix of ['', separator]) {
      for (const source of [
        '',
        ' ',
        ['one', 'two', '', 'four'].join(separator),
        'x'.repeat(2100),
      ]) {
        const content = source + suffix;
        writeFileSync(path, content);
        for (const [offset, limit] of [
          [0, 1],
          [1, 2],
          [0, 0],
          [4, 3],
          [50, 10],
        ]) {
          assert.equal(
            readTextContentWindow(content, offset!, limit!),
            await readTextWindow(path, offset!, limit!, signal),
          );
          for (const [charOffset, charLimit] of [
            [0, 500],
            [1900, 300],
            [2500, 100],
          ])
            assert.equal(
              readTextContentWindow(
                content,
                offset!,
                limit!,
                charOffset!,
                charLimit!,
              ),
              await readTextWindow(
                path,
                offset!,
                limit!,
                signal,
                false,
                charOffset!,
                charLimit!,
              ),
            );
        }
      }
    }
  }
});

test('native read versions belong to the actual calling session', async (t) => {
  const workspace = realpathSync(scratch(t));
  const path = join(workspace, 'a.txt');
  writeFileSync(path, 'original');
  const backend: FileMutations = {
    async read(path) {
      return { path, content: readFileSync(path, 'utf8'), revision: 'v1' };
    },
    async apply() {
      throw Error('unexpected write');
    },
  };
  const tools = buildTools(new Sandbox(workspace), { fileMutations: backend });
  const a = { signal: new AbortController().signal, sessionId: 'parent' };
  await tools
    .find((tool) => tool.name === 'read_file')!
    .run({ file_path: 'a.txt' }, a);
  await assert.rejects(
    tools
      .find((tool) => tool.name === 'edit_file')!
      .run(
        {
          file_path: 'a.txt',
          old_string: 'original',
          new_string: 'other session',
        },
        { ...a, sessionId: 'child' },
      ),
    /read_file must be called/,
  );
  assert.equal(readFileSync(path, 'utf8'), 'original');
});

for (const mode of ['read-only', 'credential'] as const) {
  test(`harness ${mode} denial happens before optional preparation can read or write`, async (t) => {
    const home = scratch(t);
    const workspace = realpathSync(scratch(t));
    const path = mode === 'credential' ? '.env' : 'ordinary.txt';
    writeFileSync(join(workspace, path), 'original');
    let reads = 0;
    let writes = 0;
    const backend: FileMutations = {
      async read(path) {
        reads++;
        return { path, content: 'original', revision: 'v1' };
      },
      async apply() {
        writes++;
      },
    };
    const model = new ScriptedModel([
      {
        message: {
          id: 'request',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'write',
              name: 'write_file',
              args: { file_path: path, content: 'forbidden' },
            },
          ],
        },
      },
      { message: { id: 'done', role: 'assistant', content: 'done' } },
    ]);
    const runtime = new AgentRuntime({
      home,
      workspace,
      settings: defaultSettings(),
      model,
      headless: true,
      fileMutations: backend,
    });
    cleanup(t, () => runtime.close());
    if (mode === 'read-only') runtime.harness.planMode = true;
    await runtime.harness.run('try the denied change');
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.equal(readFileSync(join(workspace, path), 'utf8'), 'original');
    const result = model.requests[1]!.messages.findLast(
      (message) => message.role === 'tool',
    )!;
    assert.equal(result.status, 'error');
    assert.match(
      result.content,
      mode === 'credential' ? /credential/ : /read-only mode/,
    );
    runtime.store.requireBalancedTools(runtime.harness.messages);
  });
}

test('native write_file marks written files read for subsequent edit_file', async (t) => {
  const workspace = realpathSync(scratch(t));
  const disk = new Map<string, string>();
  const existing = join(workspace, 'existing.txt');
  writeFileSync(existing, 'before\n');
  disk.set(existing, 'before\n');
  let rev = 1;
  const revisions = new Map<string, string>([[existing, 'r1']]);
  const backend: FileMutations = {
    async read(path) {
      const content = disk.get(path) ?? null;
      return {
        path,
        content,
        revision: content === null ? null : (revisions.get(path) ?? null),
      };
    },
    async apply(changes) {
      for (const change of changes) {
        if (change.content === null) {
          disk.delete(change.path);
          revisions.delete(change.path);
        } else {
          disk.set(change.path, change.content);
          revisions.set(change.path, `r${++rev}`);
        }
      }
    },
  };
  const tools = buildTools(new Sandbox(workspace), { fileMutations: backend });
  const byName = new Map(tools.map((entry) => [entry.name, entry]));
  const context = { signal: new AbortController().signal, sessionId: 'native' };

  await byName
    .get('write_file')!
    .run({ file_path: 'fresh.txt', content: 'one\n' }, context);
  await byName
    .get('edit_file')!
    .run(
      { file_path: 'fresh.txt', old_string: 'one', new_string: 'two' },
      context,
    );
  assert.equal(disk.get(join(workspace, 'fresh.txt')), 'two\n');

  await byName
    .get('write_file')!
    .run({ file_path: 'existing.txt', content: 'after\n' }, context);
  assert.equal(disk.get(existing), 'after\n');
  await byName
    .get('edit_file')!
    .run(
      { file_path: 'existing.txt', old_string: 'after', new_string: 'edited' },
      context,
    );
  assert.equal(disk.get(existing), 'edited\n');
});
