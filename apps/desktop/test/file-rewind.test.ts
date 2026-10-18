import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  chmod,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { WorkspaceDocuments } from '../src/workspace/documents.ts';
import { FileRewindJournal } from '../../../src/file_rewind.ts';
import { buildTools } from '../../../src/tools.ts';
import { Sandbox } from '../../../src/sandbox.ts';
import { planPatch } from '../../../src/apply_patch.ts';

test('native edits and rewind preserve BOM Chinese mixed separators dirty files and Git index', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-rewind-'));
  const documents = new WorkspaceDocuments(root);
  t.after(async () => {
    documents.close();
    await rm(root, { recursive: true, force: true });
  });
  const signal = new AbortController().signal;
  const original = '\uFEFF中文\r\nkeep\nlast';
  await writeFile(join(root, 'a.txt'), original);
  await writeFile(join(root, 'b.txt'), 'dirty before\r\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-q');
  git('add', 'a.txt');
  const index = await readFile(join(root, '.git/index'));
  await writeFile(join(root, 'a.txt'), original.replace('keep', 'dirty keep'));
  const before = await readFile(join(root, 'a.txt'));
  const journal = new FileRewindJournal({
    async read(path, signal) {
      const d = await documents.snapshot(relative(documents.root, path), {
        signal,
      });
      return {
        path,
        content: d?.content ?? null,
        revision: d?.revision ?? null,
        mode: d?.mode,
      };
    },
    async apply(changes, signal) {
      const r = await documents.applyChanges(
        changes.map((c) => ({ ...c, path: relative(documents.root, c.path) })),
        { signal },
      );
      if (r.status !== 'applied')
        throw Error(r.failures.map((f) => f.message).join(';'));
    },
    async restoreAtomic(changes, signal) {
      await documents.restoreAtomic(
        changes.map((c) => ({ ...c, path: relative(documents.root, c.path) })),
        { signal },
      );
    },
  });
  const tools = buildTools(new Sandbox(root), { fileMutations: journal.files });
  const context = { signal, sessionId: 'test' };
  const run = async (name: string, args: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.run(args, context);
  journal.beginTurn('turn-one');
  await run('read_file', { file_path: 'a.txt' });
  await run('edit_file', {
    file_path: 'a.txt',
    old_string: '中文',
    new_string: '中文 changed',
  });
  await run('write_file', { file_path: 'b.txt', content: 'changed\n' });
  journal.endTurn();
  assert.equal(
    await readFile(join(root, 'a.txt'), 'utf8'),
    original.replace('中文', '中文 changed').replace('keep', 'dirty keep'),
  );
  const preview = await journal.preview('turn-one', signal);
  assert.equal(preview.paths.length, 2);
  assert.deepEqual(preview.conflicts, []);
  await journal.restore(preview.id, signal);
  assert.deepEqual(await readFile(join(root, 'a.txt')), before);
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'dirty before\r\n');
  journal.beginTurn('turn-conflict');
  await run('read_file', { file_path: 'a.txt' });
  await run('edit_file', {
    file_path: 'a.txt',
    old_string: '中文',
    new_string: '中文 changed',
  });
  await run('read_file', { file_path: 'b.txt' });
  await run('write_file', { file_path: 'b.txt', content: 'changed\n' });
  journal.endTurn();
  const conflictPreview = await journal.preview('turn-conflict', signal);
  await writeFile(join(root, 'b.txt'), 'external');
  await assert.rejects(
    journal.restore(conflictPreview.id, signal),
    /no files restored/,
  );
  assert.match(await readFile(join(root, 'a.txt'), 'utf8'), /changed/);
  // A new turn must retain its own real before-images, including existing dirt.
  journal.beginTurn('turn-two');
  await run('write_file', { file_path: 'new.txt', content: 'created' });
  journal.endTurn();
  const second = await journal.preview('turn-two', signal);
  await journal.restore(second.id, signal);
  await assert.rejects(readFile(join(root, 'new.txt')), /ENOENT/);
  assert.deepEqual(await readFile(join(root, '.git/index')), index);
  assert.match(before.toString(), /^\uFEFF中文\r\n/);
});

test('patch changes retain BOM, untouched mixed delimiters and no final newline', (t) => {
  const sandbox = new Sandbox(tmpdir());
  for (const original of [
    '\uFEFF中文\r\nkeep\nlast',
    '中文\r\nkeep\r\nlast\r\n',
  ]) {
    const changes = planPatch(
      '*** Begin Patch\n*** Update File: a.txt\n@@\n-keep\n+edited\n*** End Patch',
      sandbox,
      () => original,
    );
    assert.equal(changes[0]!.content, original.replace('keep', 'edited'));
  }
});

test('patch context lines retain their individual mixed delimiters', () => {
  const changes = planPatch(
    '*** Begin Patch\n*** Update File: a.txt\n@@\n first\n-before\n+after\n last\n*** End Patch',
    new Sandbox(tmpdir()),
    () => 'first\r\nbefore\nlast',
  );
  assert.equal(changes[0]!.content, 'first\r\nafter\r\nlast');
});

test('atomic restore rejects all files before mutation and leaves no staging files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-rewind-reject-'));
  const docs = new WorkspaceDocuments(root);
  t.after(async () => {
    docs.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'a.txt'), 'a');
  await writeFile(join(root, 'b.txt'), 'b');
  const a = await docs.read('a.txt');
  const b = await docs.read('b.txt');
  await writeFile(join(root, 'b.txt'), 'external');
  await assert.rejects(
    docs.restoreAtomic([
      { path: 'a.txt', content: 'old a', expectedRevision: a.revision },
      { path: 'b.txt', content: 'old b', expectedRevision: b.revision },
    ]),
    /changed on disk/,
  );
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'a');
});

test('a failure after the first restored file compensates it and reports the failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-undo-compensation-'));
  const docs = new WorkspaceDocuments(root);
  t.after(async () => {
    docs.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'a.txt'), 'after a');
  await writeFile(join(root, 'b.txt'), 'after b');
  const a = await docs.read('a.txt');
  const b = await docs.read('b.txt');
  const internal = docs as unknown as {
    check: (...args: unknown[]) => Promise<unknown>;
  };
  const check = internal.check.bind(docs);
  internal.check = async (...args) => {
    const edit = args[0] as { path: string };
    if (
      edit.path === 'b.txt' &&
      (await readFile(join(root, 'a.txt'), 'utf8')) === 'before a'
    )
      throw Error('injected second-file failure');
    return check(...args);
  };
  await assert.rejects(
    docs.restoreAtomic([
      { path: 'a.txt', content: 'before a', expectedRevision: a.revision },
      { path: 'b.txt', content: 'before b', expectedRevision: b.revision },
    ]),
    /injected second-file failure; no file contents left restored/,
  );
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'after a');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'after b');
});

test('failed compensation names the unrestored path and leaves an explicit failure receipt', async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), 'circle-undo-failed-compensation-'),
  );
  const docs = new WorkspaceDocuments(root);
  t.after(async () => {
    docs.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'a.txt'), 'after a');
  await writeFile(join(root, 'b.txt'), 'after b');
  const a = await docs.read('a.txt');
  const b = await docs.read('b.txt');
  const internal = docs as unknown as {
    check: (...args: unknown[]) => Promise<unknown>;
  };
  const check = internal.check.bind(docs);
  internal.check = async (...args) => {
    const edit = args[0] as { path: string; content: string };
    if (
      edit.path === 'b.txt' &&
      (await readFile(join(root, 'a.txt'), 'utf8')) === 'before a'
    )
      throw Error('second-file failure');
    if (edit.path === 'a.txt' && edit.content === 'after a')
      throw Error('recovery write failure');
    return check(...args);
  };
  await assert.rejects(
    docs.restoreAtomic([
      { path: 'a.txt', content: 'before a', expectedRevision: a.revision },
      { path: 'b.txt', content: 'before b', expectedRevision: b.revision },
    ]),
    (error: unknown) => {
      assert.match(String(error), /compensation incomplete: a.txt/);
      assert.deepEqual((error as { committedPaths: string[] }).committedPaths, [
        'a.txt',
      ]);
      assert.equal(
        (error as { compensationFailures: string[] }).compensationFailures
          .length,
        1,
      );
      return true;
    },
  );
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'before a');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'after b');
});

test('native external reads and edits both require an explicit file grant', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-native-external-'));
  await mkdir(join(root, 'workspace'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'external.txt');
  await writeFile(path, 'outside');
  const tools = buildTools(new Sandbox(join(root, 'workspace')), {
    fileMutations: {
      async read() {
        throw Error('backend must not broaden its root');
      },
      async apply() {
        throw Error('must not write');
      },
    },
  });
  const context = {
    sessionId: 'external',
    signal: new AbortController().signal,
  };
  await assert.rejects(
    tools
      .find((tool) => tool.name === 'read_file')!
      .run({ file_path: path }, context),
    /explicit external file grant/,
  );
  await assert.rejects(
    tools
      .find((tool) => tool.name === 'edit_file')!
      .run(
        { file_path: path, old_string: 'outside', new_string: 'changed' },
        context,
      ),
    /explicit external file grant/,
  );
  assert.equal(await readFile(path, 'utf8'), 'outside');
});

test(
  'undo recreates a deleted executable with its recorded ordinary permissions',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'circle-undo-mode-'));
    const docs = new WorkspaceDocuments(root);
    t.after(async () => {
      docs.close();
      await rm(root, { recursive: true, force: true });
    });
    const path = join(docs.root, 'script.sh');
    await writeFile(path, '#!/bin/sh\n');
    await chmod(path, 0o751);
    const journal = new FileRewindJournal({
      async read(path, signal) {
        const d = await docs.snapshot(relative(docs.root, path), { signal });
        return {
          path,
          content: d?.content ?? null,
          revision: d?.revision ?? null,
          mode: d?.mode,
        };
      },
      async apply(changes, signal) {
        const result = await docs.applyChanges(
          changes.map((c) => ({ ...c, path: relative(docs.root, c.path) })),
          { signal },
        );
        if (result.status !== 'applied') throw Error('apply failed');
      },
      async restoreAtomic(changes, signal) {
        await docs.restoreAtomic(
          changes.map((c) => ({ ...c, path: relative(docs.root, c.path) })),
          { signal },
        );
      },
    });
    const signal = new AbortController().signal;
    const before = await journal.files.read(path, signal);
    assert.equal(before.mode, 0o751);
    journal.beginTurn('delete-script');
    await journal.files.apply(
      [{ path, content: null, expectedRevision: before.revision }],
      signal,
    );
    journal.endTurn();
    const preview = await journal.preview('delete-script', signal);
    await journal.restore(preview.id, signal);
    assert.equal(await readFile(path, 'utf8'), '#!/bin/sh\n');
    assert.equal((await stat(path)).mode & 0o777, 0o751);
  },
);

test(
  'undo failure compensation recreates deleted files with their prior permissions',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await mkdtemp(
      join(tmpdir(), 'circle-undo-compensation-mode-'),
    );
    const docs = new WorkspaceDocuments(root);
    t.after(async () => {
      docs.close();
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(join(root, 'a.sh'), 'executable');
    await chmod(join(root, 'a.sh'), 0o755);
    await writeFile(join(root, 'b.txt'), 'after b');
    const a = await docs.read('a.sh');
    const b = await docs.read('b.txt');
    const internal = docs as unknown as {
      check: (...args: unknown[]) => Promise<unknown>;
    };
    const check = internal.check.bind(docs);
    internal.check = async (...args) => {
      const edit = args[0] as { path: string };
      if (
        edit.path === 'b.txt' &&
        !(await stat(join(root, 'a.sh')).then(
          () => true,
          () => false,
        ))
      )
        throw Error('second-file failure');
      return check(...args);
    };
    await assert.rejects(
      docs.restoreAtomic([
        { path: 'a.sh', content: null, expectedRevision: a.revision },
        {
          path: 'b.txt',
          content: 'before b',
          expectedRevision: b.revision,
          mode: b.mode,
        },
      ]),
      /no file contents left restored/,
    );
    assert.equal(await readFile(join(root, 'a.sh'), 'utf8'), 'executable');
    assert.equal((await stat(join(root, 'a.sh'))).mode & 0o777, 0o755);
  },
);
