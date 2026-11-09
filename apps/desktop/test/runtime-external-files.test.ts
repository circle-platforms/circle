import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { emptyUsage } from '../../../src/types.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import type { RuntimeCommandName } from '../src/runtime-protocol.ts';
const assistant = (
  id: string,
  name?: string,
  args: Record<string, unknown> = {},
) => ({
  usage: emptyUsage(),
  message: {
    id,
    role: 'assistant' as const,
    content: name ? '' : 'done',
    ...(name ? { tool_calls: [{ id: id + '-call', name, args }] } : {}),
  },
});
async function fixture(
  t: TestContext,
  replies: ConstructorParameters<typeof ScriptedModel>[0],
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-native-external-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  await mkdir(join(workspace, '.git'));
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const model = new ScriptedModel(replies);
  const watchers = new Set<() => void>();
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: () => {
      for (const check of watchers) check();
    },
  });
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ) => controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  const until = (predicate: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        watchers.delete(check);
        reject(
          Error(
            'native external-file state did not arrive ' +
              JSON.stringify({
                requests: model.requests.length,
                sessions: controller.snapshot().sessions.map((s) => ({
                  id: s.id,
                  state: s.state,
                  messages: s.messages,
                })),
                interactions: controller.snapshot().interactions,
              }),
          ),
        );
      }, 10_000);
      const check = () => {
        if (predicate()) {
          clearTimeout(timer);
          watchers.delete(check);
          resolve();
        }
      };
      watchers.add(check);
      check();
    });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, workspace, model, controller, call, until };
}

test('native exact-file grant connects real Read/Edit, isolates sessions and expires on deletion', async (t) => {
  let path = '';
  const f = await fixture(t, [
    async () => assistant('read', 'read_file', { file_path: path }),
    async () =>
      assistant('edit', 'edit_file', {
        file_path: path,
        old_string: 'before',
        new_string: 'after',
      }),
    assistant('end'),
    async () => assistant('other-read', 'read_file', { file_path: path }),
    assistant('other-end'),
  ]);
  path = join(f.root, 'outside.txt');
  await writeFile(path, 'before\n');
  const owner = f.controller.snapshot().activeSessionId;
  const grant = await f.controller.grantExternalFile(owner, path, 'readwrite');
  assert.equal((await f.call('set-mode', { mode: 'auto' })).ok, true);
  assert.equal(
    (await f.call('prompt', { text: 'make the exact granted edit' })).ok,
    true,
  );
  await f.until(
    () =>
      f.model.requests.length >= 3 &&
      f.controller.snapshot().sessions.find((s) => s.id === owner)?.state !==
        'waiting',
  );
  assert.equal(await readFile(path, 'utf8'), 'after\n');
  assert.equal((await f.call('list-external-file-grants', {}, owner)).ok, true);
  const created = await f.call('new-session');
  assert.equal(created.ok, true, created.error);
  const other = f.controller.snapshot().activeSessionId;
  assert.notEqual(other, owner);
  const foreign = await f.call('list-external-file-grants', {}, other);
  assert.deepEqual(foreign.data, []);
  assert.equal(
    (
      await f.call('prompt', {
        text: 'attempt ungranted read from the other session',
      })
    ).ok,
    true,
  );
  await f.until(
    () =>
      f.model.requests.length >= 5 &&
      f.controller.snapshot().sessions.find((s) => s.id === other)?.state !==
        'waiting',
  );
  const otherHistory = f.controller
    .snapshot()
    .sessions.find((s) => s.id === other)!.messages;
  assert.ok(
    otherHistory.some(
      (m) =>
        m.tool &&
        /outside this session workspace or lacks an exact-file grant/i.test(
          m.tool.output,
        ),
    ),
    JSON.stringify(otherHistory),
  );
  assert.equal(await readFile(path, 'utf8'), 'after\n');
  const removed = await f.call(
    'delete-session',
    { id: owner, confirmed: true },
    owner,
  );
  assert.equal(removed.ok, true, removed.error);
  assert.deepEqual(
    await f.controller.revokeExternalFileGrant(owner, grant.id),
    {
      revoked: false,
    },
  );
});

test('an ungranted external read explains project workspaces and exact-file access', async (t) => {
  let path = '';
  const f = await fixture(t, [
    async () => assistant('ungranted', 'read_file', { file_path: path }),
    assistant('end'),
  ]);
  path = join(f.root, 'outside.txt');
  await writeFile(path, 'still private\n');
  const owner = f.controller.snapshot().activeSessionId;
  assert.equal(
    (await f.call('prompt', { text: 'read the external file' })).ok,
    true,
  );
  await f.until(
    () =>
      f.model.requests.length >= 2 &&
      f.controller.snapshot().sessions.find((s) => s.id === owner)?.state !==
        'waiting',
  );
  const history = f.controller
    .snapshot()
    .sessions.find((s) => s.id === owner)!.messages;
  assert.ok(
    history.some(
      (m) =>
        m.tool &&
        /open a project folder as a workspace and start a session there/.test(
          m.tool.output,
        ) &&
        /grant one existing text file/.test(m.tool.output),
    ),
    JSON.stringify(history),
  );
  assert.equal(f.model.requests.length, 2);
  assert.equal(await readFile(path, 'utf8'), 'still private\n');
  await assert.rejects(
    f.controller.grantExternalFile(owner, f.root, 'read'),
    /regular non-linked file/,
  );
});

test("a command's output written into the folder the prompt names is read back, and a refused read names that folder", async (t) => {
  let folder = '';
  let outside = '';
  const f = await fixture(t, [
    // The model learns the folder from its prompt, as a model would
    async (request) => {
      folder =
        /Have a command write output you will read into (.+), not \/tmp/.exec(
          request.system,
        )?.[1] ?? '';
      return assistant('write', 'execute', {
        command: `echo command output> "${join(folder, 'run.log')}"`,
      });
    },
    async () =>
      assistant('read', 'read_file', { file_path: join(folder, 'run.log') }),
    async () => assistant('outside', 'read_file', { file_path: outside }),
    assistant('end'),
  ]);
  outside = join(f.root, 'outside.log');
  await writeFile(outside, 'written where read_file does not read\n');
  const owner = f.controller.snapshot().activeSessionId;
  assert.equal((await f.call('set-mode', { mode: 'auto' })).ok, true);
  assert.equal(
    (await f.call('prompt', { text: 'run it and read the log' })).ok,
    true,
  );
  await f.until(
    () =>
      f.model.requests.length >= 4 &&
      f.controller.snapshot().sessions.find((s) => s.id === owner)?.state !==
        'waiting',
  );
  assert.ok(folder, f.model.requests[0]!.system);
  assert.match(
    await readFile(join(folder, 'run.log'), 'utf8'),
    /command output/,
  );
  // What the model got back: the log's text, then a refusal that says where output goes
  const results = f.model.requests[3]!.messages.filter(
    (m) => m.role === 'tool',
  );
  const read = results.find((m) => m.tool_call_id === 'read-call');
  assert.equal(read?.status, 'success', JSON.stringify(read));
  assert.match(String(read?.content), /command output/);
  const refused = results.find((m) => m.tool_call_id === 'outside-call');
  assert.equal(refused?.status, 'error', JSON.stringify(refused));
  assert.ok(
    String(refused?.content).includes(
      `To read a command's output, have the command write it into ${folder} and read it there`,
    ),
    String(refused?.content),
  );
  assert.match(String(refused?.content), /grant one existing text file/);
});

test('grep, glob and ls do not show a folder outside the workspace that read_file may not read', async (t) => {
  let outside = '';
  const f = await fixture(t, [
    async () =>
      assistant('grep', 'grep', {
        pattern: 'SYNTHETIC',
        path: outside,
        output_mode: 'content',
      }),
    async () => assistant('ls', 'ls', { path: outside }),
    async () => assistant('glob', 'glob', { pattern: '*', path: outside }),
    assistant('end'),
  ]);
  outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'private.txt'), 'SYNTHETIC-PRIVATE-LINE\n');
  const owner = f.controller.snapshot().activeSessionId;
  assert.equal(
    (await f.call('prompt', { text: 'look outside the workspace' })).ok,
    true,
  );
  await f.until(
    () =>
      f.model.requests.length >= 4 &&
      f.controller.snapshot().sessions.find((s) => s.id === owner)?.state !==
        'waiting',
  );
  const results = f.model.requests[3]!.messages.filter(
    (m) => m.role === 'tool',
  );
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.match(
      String(result.content),
      /outside this session workspace or lacks an exact-file grant/,
    );
    assert.doesNotMatch(
      String(result.content),
      /SYNTHETIC-PRIVATE-LINE|private\.txt/,
    );
  }
  // Refused, not asked: no card was shown for any of them
  assert.deepEqual(f.controller.snapshot().interactions, []);
});

test('a worktree of the workspace repository beside it is read, searched and edited as the workspace is', async (t) => {
  let side = '';
  let outside = '';
  const f = await fixture(t, [
    async () =>
      assistant('read', 'read_file', {
        file_path: join(side, 'src', 'app.ts'),
      }),
    async () =>
      assistant('grep', 'grep', {
        pattern: 'before',
        path: side,
        output_mode: 'content',
      }),
    async () =>
      assistant('edit', 'edit_file', {
        file_path: join(side, 'src', 'app.ts'),
        old_string: 'before',
        new_string: 'after',
      }),
    async () => assistant('ls', 'ls', { path: side }),
    async () =>
      assistant('git', 'read_file', { file_path: join(side, '.git') }),
    async () => assistant('outside', 'read_file', { file_path: outside }),
    assistant('end'),
  ]);
  // The workspace becomes a real repository, with a worktree of it beside it
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circle Test',
        '-c',
        'user.email=test@example.invalid',
        ...args,
      ],
      { cwd, stdio: 'pipe' },
    );
  await rm(join(f.workspace, '.git'), { recursive: true, force: true });
  git(f.workspace, 'init', '-q');
  await mkdir(join(f.workspace, 'src'));
  await writeFile(
    join(f.workspace, 'src', 'app.ts'),
    'export const value = 1;\n',
  );
  git(f.workspace, 'add', '-A');
  git(f.workspace, 'commit', '-q', '-m', 'start');
  side = join(f.root, 'workspace-side');
  git(f.workspace, 'worktree', 'add', '-q', '-b', 'side', side);
  await writeFile(join(side, 'src', 'app.ts'), 'const state = "before";\n');
  outside = join(f.root, 'outside.txt');
  await writeFile(outside, 'not a worktree\n');
  const owner = f.controller.snapshot().activeSessionId;
  // Edits in the workspace go without a card in this mode; a worktree's count as such
  assert.equal((await f.call('set-mode', { mode: 'accept-edits' })).ok, true);
  assert.equal(
    (await f.call('prompt', { text: 'work in the worktree' })).ok,
    true,
  );
  await f.until(
    () =>
      f.model.requests.length >= 7 &&
      f.controller.snapshot().sessions.find((s) => s.id === owner)?.state !==
        'waiting',
  );
  assert.deepEqual(f.controller.snapshot().interactions, []);
  const results = new Map(
    f.model.requests[6]!.messages.filter((m) => m.role === 'tool').map((m) => [
      m.tool_call_id,
      m,
    ]),
  );
  const ok = (id: string, pattern: RegExp) => {
    const result = results.get(id + '-call');
    assert.equal(result?.status, 'success', JSON.stringify(result));
    assert.match(String(result!.content), pattern);
  };
  ok('read', /const state = "before";/);
  ok('grep', /const state = "before";/);
  ok('edit', /Edited/);
  ok('ls', /src\//);
  assert.equal(
    await readFile(join(side, 'src', 'app.ts'), 'utf8'),
    'const state = "after";\n',
  );
  // Its repository internals stay closed, and a folder that is no worktree stays outside
  const refused = (id: string, pattern: RegExp) => {
    const result = results.get(id + '-call');
    assert.equal(result?.status, 'error', JSON.stringify(result));
    assert.match(String(result!.content), pattern);
  };
  refused('git', /not available in this workspace: \.git; .*git commands/);
  refused(
    'outside',
    /outside this session workspace or lacks an exact-file grant/,
  );
});

test('opening a project folder starts a session whose file reads need no external grant', async (t) => {
  let path = '';
  const f = await fixture(t, [
    async () => assistant('workspace-read', 'read_file', { file_path: path }),
    assistant('end'),
  ]);
  const project = join(f.root, 'project');
  await mkdir(project);
  path = join(project, 'source.txt');
  await writeFile(path, 'project content\n');
  saveSettings(trustFolder(defaultSettings(), project), f.home);
  const opened = await f.call('open-workspace', { path: project });
  assert.equal(opened.ok, true, opened.error);
  const workspaceId = (opened.data as { workspaceId: string }).workspaceId;
  const started = await f.call('begin-session', {
    workspaceId,
    text: 'read the project file',
  });
  assert.equal(started.ok, true, started.error);
  const owner = (started.data as { sessionId: string }).sessionId;
  await f.until(
    () =>
      f.model.requests.length >= 2 &&
      f.controller.snapshot().sessions.find((s) => s.id === owner)?.state !==
        'waiting',
  );
  const history = f.controller
    .snapshot()
    .sessions.find((s) => s.id === owner)!.messages;
  assert.ok(
    history.some((m) => m.tool?.output.includes('project content')),
    JSON.stringify(history),
  );
  assert.deepEqual(
    (await f.call('list-external-file-grants', {}, owner)).data,
    [],
  );
});

test('revoking a grant after Edit preparation but before approval blocks the actual write', async (t) => {
  let path = '';
  const f = await fixture(t, [
    async () => assistant('read', 'read_file', { file_path: path }),
    async () =>
      assistant('edit', 'edit_file', {
        file_path: path,
        old_string: 'before',
        new_string: 'after',
      }),
    assistant('end'),
  ]);
  path = join(f.root, 'outside.txt');
  await writeFile(path, 'before\n');
  const owner = f.controller.snapshot().activeSessionId;
  const grant = await f.controller.grantExternalFile(owner, path, 'readwrite');
  assert.equal(
    (await f.call('prompt', { text: 'edit the granted file with approval' }))
      .ok,
    true,
  );
  await f.until(() =>
    f.controller
      .snapshot()
      .interactions.some(
        (i) => i.kind === 'approval' && i.status === 'pending',
      ),
  );
  const pending = f.controller
    .snapshot()
    .interactions.find((i) => i.kind === 'approval' && i.status === 'pending')!;
  const revoked = await f.call(
    'revoke-external-file-grant',
    { id: grant.id },
    owner,
  );
  assert.equal(revoked.ok, true, revoked.error);
  assert.deepEqual(revoked.data, { revoked: true });
  assert.equal(
    (
      await f.call(
        'answer',
        { id: pending.id, revision: pending.revision, answer: 'approve' },
        owner,
      )
    ).ok,
    true,
  );
  await f.until(
    () =>
      f.model.requests.length >= 3 &&
      f.controller.snapshot().sessions.find((s) => s.id === owner)?.state !==
        'waiting',
  );
  assert.equal(await readFile(path, 'utf8'), 'before\n');
  const history = f.controller
    .snapshot()
    .sessions.find((s) => s.id === owner)!.messages;
  assert.ok(
    history.some((m) => m.tool && /grant|revoked/i.test(m.tool.output)),
    JSON.stringify(history),
  );
});

test('a disk change after actual Read rejects native Edit without overwriting it', async (t) => {
  let path = '';
  const f = await fixture(t, [
    async () => assistant('read', 'read_file', { file_path: path }),
    async () => {
      await writeFile(path, 'independent writer\n');
      return assistant('edit', 'edit_file', {
        file_path: path,
        old_string: 'before',
        new_string: 'after',
      });
    },
    assistant('end'),
  ]);
  path = join(f.root, 'outside.txt');
  await writeFile(path, 'before\n');
  const owner = f.controller.snapshot().activeSessionId;
  await f.controller.grantExternalFile(owner, path, 'readwrite');
  await f.call('set-mode', { mode: 'auto' });
  await f.call('prompt', { text: 'edit after a concurrent write' });
  await f.until(
    () =>
      f.model.requests.length >= 3 &&
      f.controller.snapshot().sessions.find((s) => s.id === owner)?.state !==
        'waiting',
  );
  assert.equal(await readFile(path, 'utf8'), 'independent writer\n');
  assert.ok(
    f.controller
      .snapshot()
      .sessions.find((s) => s.id === owner)!
      .messages.some(
        (m) => m.tool && /changed since read_file/i.test(m.tool.output),
      ),
  );
});

test('native grant mint rejects stale/plan-write/private paths while allowing plan reads', async (t) => {
  const f = await fixture(t, []);
  const path = join(f.root, 'outside.txt');
  await writeFile(path, 'safe\n');
  const owner = f.controller.snapshot().activeSessionId;
  await assert.rejects(
    f.controller.grantExternalFile('missing', path, 'read'),
    /session/,
  );
  await f.call('set-mode', { mode: 'plan' });
  await assert.rejects(
    f.controller.grantExternalFile(owner, path, 'readwrite'),
    /plan mode/,
  );
  const readGrant = await f.controller.grantExternalFile(owner, path, 'read');
  assert.equal(readGrant.access, 'read');
  const privatePath = join(f.home, 'private.txt');
  await writeFile(privatePath, 'secret');
  await assert.rejects(
    f.controller.grantExternalFile(owner, privatePath, 'read'),
    /private|credential/i,
  );
  const forged = await f.controller.dispatch({
    id: randomUUID(),
    name: 'grant-external-file',
    sessionId: owner,
    payload: { path, access: 'readwrite' },
  });
  assert.equal(forged.ok, false);
  assert.equal(f.model.requests.length, 0);
});

test('read-only exact grants cannot edit and archiving removes their authority permanently', async (t) => {
  let path = '';
  const f = await fixture(t, [
    async () => assistant('read', 'read_file', { file_path: path }),
    async () =>
      assistant('edit', 'edit_file', {
        file_path: path,
        old_string: 'before',
        new_string: 'after',
      }),
    assistant('end'),
  ]);
  path = join(f.root, 'outside.txt');
  await writeFile(path, 'before\n');
  const owner = f.controller.snapshot().activeSessionId;
  const grant = await f.controller.grantExternalFile(owner, path, 'read');
  await f.call('set-mode', { mode: 'auto' });
  await f.call('prompt', { text: 'attempt changing a read-only exact file' });
  await f.until(
    () =>
      f.model.requests.length >= 3 &&
      f.controller.snapshot().sessions.find((s) => s.id === owner)?.state !==
        'waiting',
  );
  assert.equal(await readFile(path, 'utf8'), 'before\n');
  assert.ok(
    f.controller
      .snapshot()
      .sessions.find((s) => s.id === owner)!
      .messages.some((m) => m.tool && /grant/i.test(m.tool.output)),
  );
  const archived = await f.call('archive-session', {
    id: owner,
    archived: true,
  });
  assert.equal(archived.ok, true, archived.error);
  assert.deepEqual(
    await f.controller.revokeExternalFileGrant(owner, grant.id),
    { revoked: false },
  );
  await f.call('archive-session', { id: owner, archived: false });
  assert.deepEqual(
    (await f.call('list-external-file-grants', {}, owner)).data,
    [],
  );
});

test('revoke and regrant cannot reuse a prior file-undo preview', async (t) => {
  let path = '';
  const f = await fixture(t, [
    async () => assistant('read', 'read_file', { file_path: path }),
    async () =>
      assistant('edit', 'edit_file', {
        file_path: path,
        old_string: 'before',
        new_string: 'after',
      }),
    assistant('end'),
  ]);
  path = join(f.root, 'outside.txt');
  await writeFile(path, 'before\n');
  const owner = f.controller.snapshot().activeSessionId;
  const grant = await f.controller.grantExternalFile(owner, path, 'readwrite');
  await f.call('set-mode', { mode: 'auto' });
  await f.call('prompt', {
    text: 'change a granted file and retain undo provenance',
  });
  await f.until(
    () =>
      f.model.requests.length >= 3 &&
      f.controller.snapshot().sessions.find((s) => s.id === owner)?.state !==
        'waiting',
  );
  const turn = f.controller.snapshot().sessions.find((s) => s.id === owner)!
    .fileUndoTurns![0]!;
  assert.ok(turn);
  const preview = await f.call('preview-file-undo', { turnId: turn });
  assert.equal(preview.ok, true, preview.error);
  await f.controller.revokeExternalFileGrant(owner, grant.id);
  await f.controller.grantExternalFile(owner, path, 'readwrite');
  const restore = await f.call('restore-turn-files', {
    previewId: (preview.data as { id: string }).id,
  });
  assert.equal(restore.ok, false);
  assert.match(restore.error!, /changed|conflict|revision/i);
  assert.equal(await readFile(path, 'utf8'), 'after\n');
});
