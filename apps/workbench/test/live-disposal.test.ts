import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type { RuntimeUpdate } from '../../desktop/src/runtime-protocol.ts';

test('an in-flight state response after disposal cannot mutate or notify the departed runtime', async () => {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  let resolveState!: (update: RuntimeUpdate) => void;
  const state = new Promise<RuntimeUpdate>((resolve) => {
    resolveState = resolve;
  });
  let commands = 0,
    notifications = 0,
    writes = 0;
  const host = {
    onRuntime: () => () => {},
    runtimeCommand: async (command: { id: string }) => {
      commands++;
      return { id: command.id, ok: true };
    },
    runtimeState: () => state,
  } as unknown as DesktopBridge;
  const runtime = new LiveRuntime(
    host,
    { seq: 1, connected: true, snapshot },
    {
      getItem: () => null,
      setItem: () => {
        writes++;
      },
    },
  );
  runtime.subscribe(() => notifications++);
  const pending = runtime.request('compact');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = runtime.getSnapshot();
  runtime.dispose();
  const late = structuredClone(snapshot);
  late.sessions[0].title = 'late response';
  resolveState({ seq: 2, connected: true, snapshot: late });
  await pending;
  assert.equal(runtime.getSnapshot(), before);
  assert.equal(notifications, 0);
  runtime.change((draft) => {
    draft.sessions[0].draft = 'late draft';
  });
  assert.equal(
    runtime.updateSessionView(before.sessions[0].id, {
      draft: 'late fast-path draft',
    }),
    false,
  );
  assert.equal(
    runtime.getSnapshot(),
    before,
    'the explicit presentation API cannot mutate a disposed runtime',
  );
  assert.equal(
    writes,
    0,
    'departed recipes cannot overwrite a newer runtime draft cache',
  );
  await assert.rejects(runtime.request('compact'), /disconnected/);
  assert.equal(
    commands,
    1,
    'new commands cannot originate from a disposed runtime',
  );
});

test('a pending file listing after disposal cannot replace the new view or notify old subscribers', async () => {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  let finish!: (value: unknown) => void;
  const listing = new Promise((resolve) => {
    finish = resolve;
  });
  let notifications = 0;
  const host = {
    onRuntime: () => () => {},
    listWorkspace: () => listing,
  } as unknown as DesktopBridge;
  const runtime = new LiveRuntime(host, { seq: 1, connected: true, snapshot });
  runtime.subscribe(() => notifications++);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = runtime.getSnapshot();
  runtime.dispose();
  finish({
    id: snapshot.sessions[0].workspaceId,
    files: [{ id: 'late-file', path: 'late.ts', language: 'typescript' }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.getSnapshot(), before);
  assert.equal(notifications, 0);
});

test('same-session worktree moves refresh the file list and ignore a late source listing', async (t) => {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const session = snapshot.sessions.find(
    (item) => item.id === snapshot.activeSessionId,
  )!;
  const source = session.workspaceId;
  let receive!: (update: RuntimeUpdate) => void;
  let finishSource!: (value: unknown) => void;
  const sourceListing = new Promise((resolve) => {
    finishSource = resolve;
  });
  const asked: string[] = [];
  const host = {
    onRuntime: (callback: (update: RuntimeUpdate) => void) => {
      receive = callback;
      return () => {};
    },
    listWorkspace: async (workspaceId: string) => {
      asked.push(workspaceId);
      if (workspaceId === source) return sourceListing;
      return {
        id: 'target-grant',
        files: [
          { id: 'target-file', path: 'target-only.ts', language: 'typescript' },
        ],
      };
    },
  } as unknown as DesktopBridge;
  const runtime = new LiveRuntime(host, { seq: 1, connected: true, snapshot });
  t.after(() => runtime.dispose());

  const moved = structuredClone(snapshot);
  moved.sessions.find((item) => item.id === session.id)!.executionWorkspaceId =
    'target';
  receive({ seq: 2, connected: true, snapshot: moved });
  finishSource({
    id: 'source-grant',
    files: [
      { id: 'source-file', path: 'source-only.ts', language: 'typescript' },
    ],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(asked, [source, 'target']);
  const result = runtime.getSnapshot();
  assert.equal(result.activeSessionId, session.id);
  assert.equal(
    result.sessions.find((item) => item.id === session.id)?.workspaceId,
    source,
  );
  assert.deepEqual(
    result.files.map(({ path, workspaceId, nativeGrant }) => ({
      path,
      workspaceId,
      nativeGrant,
    })),
    [
      {
        path: 'target-only.ts',
        workspaceId: 'target',
        nativeGrant: { workspaceId: 'target-grant', fileId: 'target-file' },
      },
    ],
  );
});
