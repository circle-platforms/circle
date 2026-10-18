import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  NativeExternalFilePicker,
  type ExternalPickerContext,
  type ExactFileSelection,
} from '../src/external-file-picker.ts';
import type {
  ExternalFileAccess,
  NativeExternalFileGrant,
} from '../src/contracts.ts';
const selectedPath = path.join(tmpdir(), 'synthetic-selected.txt');
const context = (): ExternalPickerContext => ({
  connected: true,
  activeSessionId: 'A',
  sessions: [
    { id: 'A', workspaceId: 'project', readOnly: false },
    { id: 'B', workspaceId: 'project', readOnly: false },
  ],
});
function gate() {
  const picker = new NativeExternalFilePicker();
  const state = context();
  picker.observe(state);
  const minted: unknown[] = [],
    revoked: unknown[] = [];
  const ports = {
    choose: async (
      _access: ExternalFileAccess,
    ): Promise<ExactFileSelection> => ({
      canceled: false,
      filePaths: [selectedPath],
    }),
    mint: async (
      sessionId: string,
      path: string,
      access: ExternalFileAccess,
    ): Promise<NativeExternalFileGrant> => {
      const grant = { id: 'exact-file-id', sessionId, path, access };
      minted.push(grant);
      return grant;
    },
    revoke: async (sessionId: string, id: string) => {
      revoked.push({ sessionId, id });
    },
    refresh: () => state,
  };
  return { picker, state, minted, revoked, ports };
}
test('only the native exact selection reaches mint; cancel never authorizes', async () => {
  const { picker, minted, ports } = gate();
  assert.deepEqual(await picker.request('A', 'read', ports), {
    id: 'exact-file-id',
    sessionId: 'A',
    path: selectedPath,
    access: 'read',
  });
  assert.equal(minted.length, 1);
  assert.equal(
    await picker.request('A', 'readwrite', {
      ...ports,
      choose: async () => ({ canceled: true, filePaths: [selectedPath] }),
    }),
    null,
  );
  assert.equal(minted.length, 1);
  for (const paths of [
    [],
    ['relative.txt'],
    [selectedPath, selectedPath],
    [selectedPath + '\0'],
  ])
    await assert.rejects(
      picker.request('A', 'read', {
        ...ports,
        choose: async () => ({ canceled: false, filePaths: paths }),
      }),
      /exactly one/,
    );
  assert.equal(minted.length, 1);
});
test('unavailable owners and malformed access are rejected before opening any dialog', async () => {
  const { picker, state, ports } = gate();
  let opened = 0;
  ports.choose = async () => {
    opened++;
    return { canceled: true, filePaths: [] };
  };
  for (const owner of ['', 'B', 'missing', undefined])
    await assert.rejects(picker.request(owner, 'read', ports));
  for (const access of [
    'write',
    'read-write',
    { toString: () => 'read' },
    undefined,
  ])
    await assert.rejects(picker.request('A', access, ports), /invalid/);
  for (const change of [
    { occupied: true },
    { lifecycle: 'deleting' },
    { archivedAt: 'today' },
  ]) {
    Object.assign(state.sessions[0], change);
    await assert.rejects(
      picker.request('A', 'read', ports),
      /available session/,
    );
    state.sessions = context().sessions;
  }
  state.connected = false;
  await assert.rejects(picker.request('A', 'read', ports), /available session/);
  state.connected = true;
  state.sessions[0].readOnly = true;
  await assert.rejects(
    picker.request('A', 'readwrite', ports),
    /available session/,
  );
  assert.equal(opened, 0);
  assert.equal(
    await picker.request('A', 'read', ports),
    null,
    'plan mode may choose read access',
  );
});
test('session changes away and back while dialog is open invalidate the selection', async () => {
  const { picker, state, minted, ports } = gate();
  let choose!: (selection: ExactFileSelection) => void;
  const pending = picker.request('A', 'read', {
    ...ports,
    choose: () =>
      new Promise((resolve) => {
        choose = resolve;
      }),
  });
  await assert.rejects(picker.request('A', 'read', ports), /already open/);
  state.activeSessionId = 'B';
  picker.observe(state);
  state.activeSessionId = 'A';
  picker.observe(state);
  choose({ canceled: false, filePaths: [selectedPath] });
  await assert.rejects(pending, /stale/);
  assert.equal(minted.length, 0);
});
test('deleted or disconnected sessions cannot acquire a token when picker returns', async () => {
  for (const invalidate of [
    (state: ExternalPickerContext) => {
      state.sessions = [];
    },
    (state: ExternalPickerContext) => {
      state.connected = false;
    },
  ]) {
    const { picker, state, minted, ports } = gate();
    await assert.rejects(
      picker.request('A', 'read', {
        ...ports,
        choose: async () => {
          invalidate(state);
          return { canceled: false, filePaths: [selectedPath] };
        },
      }),
      /available session/,
    );
    assert.equal(minted.length, 0);
  }
});
test('navigation during mint revokes its late token instead of leaking authorization', async () => {
  const { picker, revoked, ports } = gate();
  await assert.rejects(
    picker.request('A', 'readwrite', {
      ...ports,
      mint: async (...args) => {
        const grant = await ports.mint(...args);
        picker.invalidate();
        return grant;
      },
    }),
    /stale/,
  );
  assert.deepEqual(revoked, [{ sessionId: 'A', id: 'exact-file-id' }]);
});
test('registry denial for native selected forbidden files propagates without a grant', async () => {
  const { picker, revoked, ports } = gate();
  for (const reason of [
    'symlink targets cannot be granted',
    'credential files cannot be granted',
  ]) {
    await assert.rejects(
      picker.request('A', 'read', {
        ...ports,
        mint: async () => {
          throw Error(reason);
        },
      }),
      new RegExp(reason),
    );
  }
  assert.deepEqual(revoked, []);
  assert.ok(
    await picker.request('A', 'read', ports),
    'a rejected chooser does not leave the next request locked',
  );
});

test('trusted picker plus real registry rejects symlinks and credential/app-data selections', async () => {
  const { mkdtemp, mkdir, writeFile, symlink, rm, realpath } =
    await import('node:fs/promises');
  const { ExternalFileGrants } =
    await import('../src/workspace/external-file-grants.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'circle-native-picker-'));
  const ordinary = path.join(root, 'document.txt');
  const secret = path.join(root, '.env');
  const link = path.join(root, 'alias.txt');
  const privateRoot = path.join(root, 'private-data');
  await mkdir(privateRoot);
  await writeFile(ordinary, 'synthetic external content\n');
  await writeFile(secret, 'SYNTHETIC_SECRET=not-a-real-key\n');
  await writeFile(path.join(privateRoot, 'settings.json'), '{}\n');
  await symlink(ordinary, link);
  const registry = new ExternalFileGrants({ protectedRoots: [privateRoot] });
  const { picker, ports } = gate();
  let selected = ordinary;
  const actualPorts = {
    ...ports,
    choose: async () => ({ canceled: false, filePaths: [selected] }),
    mint: (owner: string, file: string, access: ExternalFileAccess) =>
      registry.mint(owner, file, access),
    revoke: async (owner: string, id: string) => {
      registry.revoke(owner, id);
    },
  };
  try {
    for (selected of [secret, link, path.join(privateRoot, 'settings.json')]) {
      await assert.rejects(
        picker.request('A', 'readwrite', actualPorts),
        /credential|private|non-linked/,
      );
      assert.deepEqual(registry.list('A'), []);
    }
    selected = ordinary;
    const granted = await picker.request('A', 'read', actualPorts);
    assert.ok(granted);
    const read = await registry.read(
      'A',
      await realpath(ordinary),
      new AbortController().signal,
    );
    assert.equal(read.content, 'synthetic external content\n');
    await assert.rejects(
      registry.read('B', granted.path, new AbortController().signal),
      /authorize|grant/,
    );
    registry.revokeSession('A');
    await assert.rejects(
      registry.read('A', granted.path, new AbortController().signal),
      /authorize|grant/,
    );
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
