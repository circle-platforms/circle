import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';

test('home command preparation creates a trusted owner and applies per-session controls without a model request or history prompt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-home-command-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const before = loadSettings(home);
  const model = new ScriptedModel([]);
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: () => {},
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const result = await controller.dispatch({
    id: randomUUID(),
    name: 'begin-session',
    sessionId: controller.snapshot().activeSessionId,
    payload: {
      workspaceId: controller
        .snapshot()
        .sessions.find(
          (item) => item.id === controller.snapshot().activeSessionId,
        )!.workspaceId,
      text: '/editor',
      prepareOnly: true,
      mode: 'plan',
      effort: 'high',
    },
  });
  assert.equal(result.ok, true, result.error);
  const owner = controller
    .snapshot()
    .sessions.find(
      (item) => item.id === (result.data as { sessionId: string }).sessionId,
    )!;
  assert.ok(owner);
  assert.equal(owner.readOnly, true);
  assert.equal(owner.effort, 'high');
  assert.equal(owner.messages.filter((item) => item.role === 'user').length, 0);
  assert.notEqual(owner.state, 'waiting');
  assert.equal(model.requests.length, 0);
  assert.deepEqual(loadSettings(home), before);
});
