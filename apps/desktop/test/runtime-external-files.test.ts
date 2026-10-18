import assert from 'node:assert/strict';
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
      (m) => m.tool && /grant|another session/i.test(m.tool.output),
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
