import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeController } from '../src/runtime-controller.ts';
import { WorkspaceEventStream } from '../src/workspace/event-stream.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';

test('an existing uncoordinated writer reaches the fatal callback and keeps its journal intact', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'circle-runtime-instance-'));
  const home = join(temp, 'home');
  const rawWorkspace = join(temp, 'workspace');
  await mkdir(rawWorkspace);
  const workspace = await realpath(rawWorkspace);
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const journal = join(
    home,
    'workspace-services',
    'workspaces',
    createHash('sha256').update(workspace).digest('hex'),
    'events.jsonl',
  );
  const owner = await WorkspaceEventStream.open(journal);
  const original = await readFile(journal);
  let controller: RuntimeController | undefined;
  let fatal!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => {
    fatal = resolve;
  });
  try {
    controller = new RuntimeController({
      home,
      workspace,
      userHome: home,
      model: new ScriptedModel([]),
      emit: () => {},
      onFatalError: fatal,
    });
    const reply = await controller.dispatch({
      id: randomUUID(),
      name: 'workspace-service',
      sessionId: controller.snapshot().activeSessionId,
      payload: { service: 'documents', method: 'refresh', params: {} },
    });
    assert.equal(reply.ok, false);
    const error = await failure;
    assert.equal(
      (error as Error & { code: string }).code,
      'DESKTOP_DATA_IN_USE',
    );
    assert.deepEqual(await readFile(journal), original);
    assert.match(controller.snapshot().runtime?.error ?? '', /active writer/);
  } finally {
    await controller?.close();
    await owner.close();
    await rm(temp, { recursive: true, force: true });
  }
});
