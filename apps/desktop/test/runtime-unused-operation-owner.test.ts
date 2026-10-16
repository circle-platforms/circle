import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { ScriptedModel } from '../../../src/testing.ts';

test('completed and reconciled operation owners survive empty-session cleanup and restart without replaying writes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-operation-owner-')),
    home = join(root, 'home'),
    workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const model = new ScriptedModel();
  const open = () =>
    new RuntimeController({
      home,
      workspace,
      userHome: home,
      model,
      emit: () => {},
    });
  let controller = open();
  t.after(async () => {
    await controller.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const call = (
    name: string,
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
    id = randomUUID(),
  ) => controller.dispatch({ id, name, payload, sessionId });
  const service = (
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ) =>
    call(
      'workspace-service',
      { service: 'operations', method, params },
      sessionId,
    );
  const owner = controller.snapshot().activeSessionId;
  const empty = await call('new-session');
  assert.equal(
    (empty.data as { sessionId: string }).sessionId,
    owner,
    'a truly unused shell is still reused',
  );
  await writeFile(join(workspace, 'value.txt'), 'before');
  const initial = await call(
    'workspace-service',
    { service: 'documents', method: 'read', params: { path: 'value.txt' } },
    owner,
  );
  assert.equal(initial.ok, true, initial.error);
  const save = await call(
    'workspace-service',
    {
      service: 'documents',
      method: 'save',
      params: {
        path: 'value.txt',
        content: 'saved once',
        expectedRevision: (initial.data as { revision: string }).revision,
      },
    },
    owner,
  );
  assert.equal(save.ok, true, save.error);
  const failedId = randomUUID();
  const failed = await call(
    'workspace-service',
    {
      service: 'terminal',
      method: 'write',
      params: { id: 'missing-terminal', data: 'synthetic pending input' },
    },
    owner,
    failedId,
  );
  assert.equal(failed.ok, false);
  const reviewed = await service(
    'review',
    { id: failedId, note: 'verified no terminal existed' },
    owner,
  );
  assert.equal(reviewed.ok, true, reviewed.error);
  const all = await service('list', {}, owner);
  assert.deepEqual(
    new Set((all.data as { state: string }[]).map((row) => row.state)),
    new Set(['completed', 'reconciled']),
  );
  const next = await call('new-session');
  assert.equal(next.ok, true, next.error);
  assert.notEqual(
    (next.data as { sessionId: string }).sessionId,
    owner,
    'durable work is not reused as a blank chat',
  );
  const selected = await call('select-session', { id: owner });
  assert.equal(selected.ok, true, selected.error);
  await controller.close();
  controller = open();
  assert.equal(controller.snapshot().activeSessionId, owner);
  const after = await service('list', {}, owner);
  assert.equal(after.ok, true, after.error);
  assert.equal((after.data as unknown[]).length, 2);
  await writeFile(
    join(workspace, 'value.txt'),
    'external after completed save',
  );
  const afterRestart = await call('new-session');
  assert.equal(afterRestart.ok, true, afterRestart.error);
  assert.notEqual(
    (afterRestart.data as { sessionId: string }).sessionId,
    owner,
    'lazy reopened ledger still preserves its owner',
  );
  const stillOwned = await service('list', {}, owner);
  assert.equal(stillOwned.ok, true, stillOwned.error);
  assert.equal(
    await readFile(join(workspace, 'value.txt'), 'utf8'),
    'external after completed save',
    'cleanup and restart never replay the completed write',
  );
  assert.equal(model.requests.length, 0);
});
