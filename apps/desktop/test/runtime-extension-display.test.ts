import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';

test('extension append is a display notice, never assistant history or later model input', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-display-boundary-'));
  const home = join(root, 'home'),
    workspace = join(root, 'workspace');
  const ext = join(workspace, '.circle/extensions/display');
  await mkdir(ext, { recursive: true });
  const settings = trustFolder(defaultSettings(), workspace);
  settings.mcp_servers = [
    {
      name: 'disabled-fixture',
      command: process.execPath,
      args: ['-e', 'throw Error("must not start")'],
      enabled: false,
    },
  ];
  saveSettings(settings, home);
  const marker = 'display-only-fixture-1871';
  await writeFile(
    join(ext, 'extension.mjs'),
    `export function register(api){api.registerCommand('display','display fixture',async(_args,ctx)=>ctx.append('${marker}'))}`,
  );
  const model = new ScriptedModel(
    [0, 1].map((i) => ({
      message: {
        id: randomUUID(),
        role: 'assistant' as const,
        content: 'answer ' + i,
      },
    })),
  );
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
  await controller.initialize();
  assert.equal(controller.snapshot().mcp[0]?.status, 'not connected');
  assert.equal(controller.snapshot().mcp[0]?.error, undefined);
  assert.equal(controller.snapshot().mcp[0]?.tools.length, 0);
  const id = controller.snapshot().activeSessionId;
  const call = (
    name: 'custom-command' | 'prompt',
    payload: Record<string, unknown>,
  ) => controller.dispatch({ id: randomUUID(), name, sessionId: id, payload });
  const appended = await call('custom-command', { name: 'display', args: '' });
  assert.equal(appended.ok, true, appended.error);
  const notice = controller
    .snapshot()
    .sessions.find((s) => s.id === id)!
    .messages.find((m) => m.text === marker);
  assert.equal(notice?.role, 'notice');
  for (let i = 0; i < 2; i++) {
    assert.equal((await call('prompt', { text: 'continue ' + i })).ok, true);
    const deadline = Date.now() + 10000;
    while (
      controller.snapshot().sessions.find((s) => s.id === id)!.turn ||
      model.requests.length < i + 1
    ) {
      assert.ok(Date.now() < deadline, 'scripted turn completed');
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  assert.equal(model.requests.length, 2);
  assert.ok(
    model.requests.every(
      (request) => !JSON.stringify(request.messages).includes(marker),
    ),
  );
  const store = new CheckpointStore(home);
  try {
    assert.equal(JSON.stringify(store.messages(id)).includes(marker), false);
  } finally {
    store.close();
  }
});
