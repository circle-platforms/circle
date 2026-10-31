import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { FileRewindJournal } from '../src/file_rewind.js';
import { FileSystemFileMutations } from '../src/file_mutations_fs.js';
import { AgentRuntime } from '../src/runtime.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { buildTools } from '../src/tools.js';
import type { Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const assistant = (
  content: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content,
  tool_calls: calls,
});
const call = (name: string, args: Record<string, unknown>) => ({
  id: randomUUID(),
  name,
  args,
});
const fresh = () => new AbortController().signal;
const tail = (path: string): string => path.split(/[\\/]+/).pop() ?? path;

/** The terminal's tools, with the journal wired the way the runtime wires them. */
function journalTools(workspace: string, journal: FileRewindJournal) {
  const sandbox = new Sandbox(workspace);
  const tools = buildTools(sandbox, {
    captures: (paths, signal, write) => journal.capture(paths, signal, write),
  });
  return {
    sandbox,
    tools,
    run: (name: string, args: Record<string, unknown>) =>
      tools
        .find((tool) => tool.name === name)!
        .run(args, { signal: fresh(), sessionId: 's1' }),
  };
}

test('a turn of text-tool writes is rewound after Circle restarts', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const at = (name: string) => join(workspace, name);
  writeFileSync(at('a.txt'), 'one\n');
  writeFileSync(at('b.txt'), 'two\n');
  const settings = trustFolder(defaultSettings(), workspace);
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings,
    model: new ScriptedModel([
      {
        message: assistant('', [
          call('read_file', { file_path: 'a.txt' }),
          call('read_file', { file_path: 'b.txt' }),
        ]),
      },
      {
        message: assistant('', [
          call('write_file', { file_path: 'a.txt', content: 'ten\n' }),
          call('edit_file', {
            file_path: 'b.txt',
            old_string: 'two',
            new_string: 'twenty',
          }),
          // A patch that deletes asks even in auto mode, so nobody would answer it
          // here: the move-and-delete path is checked on its own below.
          call('apply_patch', {
            patchText:
              '*** Begin Patch\n*** Add File: new.txt\n+created\n*** End Patch\n',
          }),
        ]),
      },
      { message: assistant('done') },
    ]),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const sessionId = runtime.session.id;
  runtime.setMode('auto');
  await runtime.harness.run('change the files');
  const turn = runtime.store
    .tree(sessionId)
    .findLast((node) => node.message?.role === 'user')!;
  // The turn is recorded under the message that opened it, as on the desktop.
  assert.deepEqual(runtime.fileRewind!.availableTurns(), [turn.id]);
  assert.deepEqual(
    runtime.fileRewind!.recordedPaths(turn.id).map(tail).sort(),
    ['a.txt', 'b.txt', 'new.txt'],
  );
  assert.equal(readFileSync(at('a.txt'), 'utf8'), 'ten\n');
  assert.equal(readFileSync(at('b.txt'), 'utf8'), 'twenty\n');
  assert.equal(readFileSync(at('new.txt'), 'utf8'), 'created\n');
  // The receipt lives in the conversation's own database, not only in memory.
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  assert.deepEqual(
    store.rewindLoad(sessionId).map((row) => [row.turnId, row.entries.length]),
    [[turn.id, 3]],
  );
  await runtime.close();
  // A second Circle over the same conversation still offers that turn, and puts files back.
  const again = new AgentRuntime({
    workspace,
    home,
    settings,
    session: sessionId,
    model: new ScriptedModel([{ message: assistant('back again') }]),
    headless: true,
  });
  cleanup(t, () => again.close());
  assert.deepEqual(again.fileRewind!.availableTurns(), [turn.id]);
  const preview = await again.fileRewind!.preview(turn.id, fresh());
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(preview.paths.map(tail).sort(), [
    'a.txt',
    'b.txt',
    'new.txt',
  ]);
  // A rewind changes files, not the conversation.
  const before = again.store.messages(sessionId).length;
  const receipt = await again.fileRewind!.restore(preview.id, fresh());
  assert.deepEqual(receipt.paths.map(tail).sort(), [
    'a.txt',
    'b.txt',
    'new.txt',
  ]);
  assert.equal(readFileSync(at('a.txt'), 'utf8'), 'one\n');
  assert.equal(readFileSync(at('b.txt'), 'utf8'), 'two\n');
  assert.equal(existsSync(at('new.txt')), false);
  assert.equal(again.store.messages(sessionId).length, before);
  assert.deepEqual(again.fileRewind!.availableTurns(), []);
  assert.deepEqual(store.rewindLoad(sessionId), []);
});

test('a patch that moves, adds and deletes is rewound file by file', async (t) => {
  const workspace = realpathSync(scratch(t));
  const journal = new FileRewindJournal(
    new FileSystemFileMutations(new Sandbox(workspace)),
  );
  const { run } = journalTools(workspace, journal);
  const at = (name: string) => join(workspace, name);
  writeFileSync(at('a.txt'), 'one\n');
  writeFileSync(at('gone.txt'), 'gone\n');
  journal.beginTurn('turn-1');
  await run('apply_patch', {
    patchText:
      '*** Begin Patch\n' +
      '*** Update File: a.txt\n' +
      '*** Move to: moved.txt\n' +
      '@@\n' +
      '-one\n' +
      '+two\n' +
      '*** Delete File: gone.txt\n' +
      '*** Add File: added.txt\n' +
      '+fresh\n' +
      '*** End Patch\n',
  });
  journal.endTurn();
  assert.equal(readFileSync(at('moved.txt'), 'utf8'), 'two\n');
  assert.equal(existsSync(at('a.txt')), false);
  assert.equal(existsSync(at('gone.txt')), false);
  assert.equal(readFileSync(at('added.txt'), 'utf8'), 'fresh\n');
  const preview = await journal.preview('turn-1', fresh());
  assert.deepEqual(preview.paths.map(tail).sort(), [
    'a.txt',
    'added.txt',
    'gone.txt',
    'moved.txt',
  ]);
  await journal.restore(preview.id, fresh());
  assert.equal(readFileSync(at('a.txt'), 'utf8'), 'one\n');
  assert.equal(readFileSync(at('gone.txt'), 'utf8'), 'gone\n');
  assert.equal(existsSync(at('moved.txt')), false);
  assert.equal(existsSync(at('added.txt')), false);
});

test('a change outside the turn is reported, and nothing is overwritten', async (t) => {
  const workspace = realpathSync(scratch(t));
  const journal = new FileRewindJournal(
    new FileSystemFileMutations(new Sandbox(workspace)),
  );
  const { run } = journalTools(workspace, journal);
  const path = join(workspace, 'a.txt');
  writeFileSync(path, 'one\n');
  journal.beginTurn('turn-1');
  await run('read_file', { file_path: 'a.txt' });
  await run('edit_file', {
    file_path: 'a.txt',
    old_string: 'one',
    new_string: 'two',
  });
  journal.endTurn();
  assert.equal(readFileSync(path, 'utf8'), 'two\n');
  writeFileSync(path, 'someone else\n');
  const preview = await journal.preview('turn-1', fresh());
  assert.deepEqual(preview.conflicts, [path]);
  await assert.rejects(
    journal.restore(preview.id, fresh()),
    /no files restored/,
  );
  assert.equal(readFileSync(path, 'utf8'), 'someone else\n');
});

test('a file that cannot be brought back byte for byte costs only its rewind', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const session = store.create(workspace, 'test-model');
  const journal = new FileRewindJournal(
    new FileSystemFileMutations(new Sandbox(workspace)),
    {
      session: () => session.id,
      ledger: () => store,
    },
  );
  const { run } = journalTools(workspace, journal);
  const plain = join(workspace, 'a.txt');
  const binary = join(workspace, 'blob.bin');
  journal.beginTurn('turn-1');
  // A file the journal can hold is recorded first, so the rule below is tested against
  // a turn that really did have something to offer.
  await run('write_file', { file_path: 'a.txt', content: 'one\n' });
  assert.deepEqual(journal.recordedPaths('turn-1'), [plain]);
  await run('write_file', { file_path: 'blob.bin', content: 'head\u0000tail' });
  journal.endTurn();
  // Both writes stand. The turn is not offered, and nothing is kept for it either:
  // a restart must not be tempted to undo half of it.
  assert.equal(readFileSync(plain, 'utf8'), 'one\n');
  assert.equal(readFileSync(binary, 'utf8'), 'head\u0000tail');
  assert.deepEqual(journal.availableTurns(), []);
  assert.deepEqual(store.rewindLoad(session.id), []);
  await assert.rejects(
    journal.preview('turn-1', fresh()),
    /blob\.bin is not text Circle can bring back/,
  );
});

test('a turn that only wrote the conversation plan has nothing to rewind', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const sandbox = new Sandbox(workspace, join(home, 'projects'));
  const journal = new FileRewindJournal(new FileSystemFileMutations(sandbox));
  const tools = buildTools(sandbox, {
    captures: (paths, signal, write) => journal.capture(paths, signal, write),
  });
  journal.beginTurn('turn-1');
  await tools
    .find((tool) => tool.name === 'write_file')!
    .run(
      { file_path: '/session_plans/s1.md', content: '# plan\n' },
      { signal: fresh(), sessionId: 's1' },
    );
  journal.endTurn();
  assert.equal(
    readFileSync(join(home, 'projects', 'session_plans', 's1.md'), 'utf8'),
    '# plan\n',
  );
  assert.deepEqual(journal.availableTurns(), []);
});
