import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import type { RuntimeCommandName } from '../src/runtime-protocol.ts';
import { CollaborationResources } from '../src/workspace/collaboration.ts';
import { TaskStore, type TaskRecord } from '../src/workspace/task-store.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import { ModelCatalog } from '../../../src/model_catalog.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import type { ModelRequest, ModelResponse } from '../../../src/types.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw Error(label);
    await delay(5);
  }
}
function resources(controller: RuntimeController): CollaborationResources {
  return Reflect.get(controller, 'taskResources') as CollaborationResources;
}
function taskServiceCount(controller: RuntimeController): number {
  return (Reflect.get(controller, 'taskServices') as Map<string, unknown>).size;
}
function call(
  controller: RuntimeController,
  name: RuntimeCommandName,
  payload: Record<string, unknown> = {},
  sessionId?: string,
) {
  return controller.dispatch({ id: randomUUID(), name, payload, sessionId });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'circle-resource-startup-'));
  const home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    dataFolder = join(root, 'data');
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(dataFolder)]);
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const settingsPath = join(
    dataFolder,
    'workspace-services',
    'task-settings.json',
  );
  const options = {
    home,
    workspace,
    dataFolder,
    userHome: home,
    emit: () => {},
    catalog: (path: string) =>
      new ModelCatalog(path, { env: { CIRCLE_NO_MODELS_REFRESH: '1' } }),
  };
  return { root, home, workspace, dataFolder, settingsPath, options };
}

test('persisted app limits gate ordinary parent model requests immediately after restart without opening or replaying the task scheduler', async (t) => {
  const f = await fixture();
  let controller: RuntimeController | undefined;
  t.after(async () => {
    await controller?.close();
    await rm(f.root, { recursive: true, force: true });
  });
  controller = new RuntimeController({
    ...f.options,
    model: new ScriptedModel(),
  });
  const saved = await call(
    controller,
    'workspace-service',
    {
      service: 'tasks',
      method: 'settings',
      params: { limits: { agents: 1, builds: 1 } },
    },
    controller.snapshot().activeSessionId,
  );
  assert.equal(saved.ok, true, saved.error);
  assert.deepEqual(saved.data, { agents: 1, builds: 1, ui: 1, browsers: 1 });
  await controller.close();
  const settings = await readFile(f.settingsPath, 'utf8');
  const canonical = await realpath(f.workspace);
  const checkpoint = new CheckpointStore(f.home);
  checkpoint.create(canonical, 'scripted', 'queued owner', 'queued-owner');
  checkpoint.close();
  const database = join(
    f.dataFolder,
    'collaboration',
    createHash('sha256').update(canonical).digest('hex').slice(0, 24),
    'collaboration.sqlite',
  );
  const pending: TaskRecord = {
    spec: {
      id: 'do-not-replay',
      sessionId: 'queued-owner',
      workspace: canonical,
      baseline: 'a'.repeat(40),
      dependencies: [],
      access: 'readonly',
      prompt:
        'Do not replay this saved task while loading concurrency settings',
      acceptanceCriteria: ['explicit task action required'],
    },
    state: 'queued',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const ledger = new TaskStore(database);
  ledger.put(pending);
  const originalEvents = ledger.eventsAfter(0);
  ledger.close();
  let active = 0,
    peak = 0;
  const entered: string[] = [];
  const hold = async (request: ModelRequest): Promise<ModelResponse> => {
    active++;
    peak = Math.max(peak, active);
    entered.push(
      request.messages.filter((row) => row.role === 'user').at(-1)!.content,
    );
    try {
      return await new Promise<ModelResponse>((_resolve, reject) => {
        const abort = () => reject(request.signal.reason ?? Error('aborted'));
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
      });
    } finally {
      active--;
    }
  };
  const model = new ScriptedModel([hold, hold]);
  controller = new RuntimeController({ ...f.options, model });
  controller.publish();
  assert.equal(
    taskServiceCount(controller),
    0,
    'reading settings must not open a task scheduler',
  );
  assert.equal(
    model.requests.length,
    0,
    'startup cannot resume the saved task',
  );
  const first = controller.snapshot().activeSessionId;
  assert.equal(
    (await call(controller, 'prompt', { text: 'first ordinary parent' }, first))
      .ok,
    true,
  );
  await until(
    () => model.requests.length === 1,
    'first ordinary parent never reached the actual model',
  );
  const created = await call(controller, 'new-session');
  assert.equal(created.ok, true, created.error);
  const second = controller.snapshot().activeSessionId;
  assert.notEqual(first, second);
  assert.equal(
    (
      await call(
        controller,
        'prompt',
        { text: 'second ordinary parent' },
        second,
      )
    ).ok,
    true,
  );
  const pool = resources(controller).pools.agent;
  await until(
    () =>
      model.requests.length === 2 || Reflect.get(pool, 'waiters').length === 1,
    'second parent neither queued nor reached the model',
  );
  assert.equal(
    model.requests.length,
    1,
    'the persisted one-agent cap must apply before any task service access',
  );
  assert.equal(peak, 1);
  assert.equal(Reflect.get(pool, 'waiters').length, 1);
  assert.deepEqual(resources(controller).getLimits(), {
    agents: 1,
    builds: 1,
    ui: 1,
    browsers: 1,
  });
  assert.equal(taskServiceCount(controller), 0);
  assert.equal(
    (await call(controller, 'select-session', { id: first })).ok,
    true,
  );
  const cancelled = await call(controller, 'abort', {}, first);
  assert.equal(cancelled.ok, true, cancelled.error);
  await until(
    () => model.requests.length === 2,
    'queued parent did not reach the model after its predecessor stopped',
  );
  assert.deepEqual(entered, [
    'first ordinary parent',
    'second ordinary parent',
  ]);
  assert.equal(
    peak,
    1,
    'ordinary requests may never overlap above the saved cap',
  );
  await controller.close();
  controller = undefined;
  assert.equal(active, 0);
  assert.equal(await readFile(f.settingsPath, 'utf8'), settings);
  const restored = new TaskStore(database);
  try {
    assert.deepEqual(restored.get(pending.spec.id), pending);
    assert.deepEqual(restored.eventsAfter(0), originalEvents);
  } finally {
    restored.close();
  }
  t.diagnostic(
    JSON.stringify({
      storedAgents: 1,
      peakActualModels: peak,
      actualParentRequests: entered,
      taskSchedulerCount: 0,
      queuedTaskUnchanged: true,
    }),
  );
});

test('missing app task settings use defaults without opening a scheduler or writing a replacement file', async (t) => {
  const f = await fixture();
  const model = new ScriptedModel();
  const controller = new RuntimeController({ ...f.options, model });
  t.after(async () => {
    await controller.close();
    await rm(f.root, { recursive: true, force: true });
  });
  assert.deepEqual(resources(controller).getLimits(), {
    agents: 8,
    builds: 2,
    ui: 1,
    browsers: 1,
  });
  assert.equal(taskServiceCount(controller), 0);
  assert.equal(model.requests.length, 0);
  await assert.rejects(access(f.settingsPath), { code: 'ENOENT' });
});

test('invalid persisted app task limits fail before opening sessions rather than silently enabling default concurrency', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(join(f.dataFolder, 'workspace-services'));
  for (const value of [
    '{invalid',
    JSON.stringify({ agents: 33 }),
    JSON.stringify({ ui: 2 }),
    JSON.stringify({ agents: 1, unknown: 2 }),
  ]) {
    await writeFile(f.settingsPath, value);
    const model = new ScriptedModel();
    assert.throws(
      () => new RuntimeController({ ...f.options, model }),
      /could not load task settings/,
    );
    assert.equal(model.requests.length, 0);
    assert.equal(await readFile(f.settingsPath, 'utf8'), value);
    await assert.rejects(access(join(f.home, 'circle.sqlite')), {
      code: 'ENOENT',
    });
  }
});
