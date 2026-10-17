import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
async function until(check: () => boolean | Promise<boolean>, label: string) {
  // A worker and its reviewer each build a worktree; Windows runners need seconds for that.
  const deadline = Date.now() + 30000;
  while (!(await check())) {
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
  const recoveryPath = join(
    dataFolder,
    'workspace-services',
    'task-settings-recovery.json',
  );
  return {
    root,
    home,
    workspace,
    dataFolder,
    settingsPath,
    recoveryPath,
    options,
  };
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

test('invalid saved limits leave history and manual editing available and repair through original settings does not start queued tasks until explicit start', async (t) => {
  const f = await fixture();
  let controller: RuntimeController | undefined;
  t.after(async () => {
    await controller?.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', f.workspace, ...args], {
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  git('config', '--local', 'core.autocrlf', 'false');
  await writeFile(join(f.workspace, 'human.txt'), 'before');
  git('add', 'human.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Create recovery fixture',
  );
  const baseline = git('rev-parse', 'HEAD');
  const canonical = await realpath(f.workspace);
  const checkpoint = new CheckpointStore(f.home);
  checkpoint.create(canonical, 'scripted', 'saved owner', 'saved-owner');
  const savedUser = {
    id: randomUUID(),
    role: 'user' as const,
    content: 'stored history must remain available',
  };
  checkpoint.append('saved-owner', [savedUser]);
  checkpoint.close();
  await writeFile(
    join(f.home, 'desktop-session.json'),
    JSON.stringify({ workspace: canonical, sessionId: 'saved-owner' }),
  );
  await mkdir(join(f.dataFolder, 'workspace-services'));
  const invalid = '{broken limits';
  await writeFile(f.settingsPath, invalid);
  const database = join(
    f.dataFolder,
    'collaboration',
    createHash('sha256').update(canonical).digest('hex').slice(0, 24),
    'collaboration.sqlite',
  );
  const pending: TaskRecord = {
    spec: {
      id: 'saved-queued-task',
      sessionId: 'saved-owner',
      workspace: canonical,
      baseline,
      dependencies: [],
      access: 'readonly',
      prompt: 'Run only after the original explicit start action',
      acceptanceCriteria: ['inspect saved code'],
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
  const answer = (content: string) => ({
    message: { id: randomUUID(), role: 'assistant' as const, content },
  });
  const model = new ScriptedModel([
    answer('worker inspection complete'),
    answer(
      JSON.stringify({
        checks: [
          {
            criterion: 'inspect saved code',
            status: 'needs_review',
            evidence: 'Human acceptance is still required.',
          },
        ],
      }),
    ),
  ]);
  controller = new RuntimeController({ ...f.options, model });
  controller.publish();
  assert.equal(controller.snapshot().activeSessionId, 'saved-owner');
  assert.equal(
    controller.snapshot().sessions.find((row) => row.id === 'saved-owner')!
      .messages[0]!.text,
    savedUser.content,
  );
  assert.match(
    controller.snapshot().runtime!.error!,
    /could not load task settings/,
  );
  assert.deepEqual(resources(controller).getLimits(), {
    agents: 1,
    builds: 1,
    ui: 1,
    browsers: 1,
  });
  assert.equal(taskServiceCount(controller), 0);
  assert.equal(model.requests.length, 0);
  const service = (method: string, params: Record<string, unknown> = {}) =>
    call(
      controller!,
      'workspace-service',
      { service: 'tasks', method, params },
      'saved-owner',
    );
  const blockedPrompt = await call(
    controller,
    'prompt',
    { text: 'must not run while settings are invalid' },
    'saved-owner',
  );
  assert.equal(blockedPrompt.ok, false);
  assert.match(blockedPrompt.error!, /could not load task settings/);
  assert.equal(model.requests.length, 0);
  const blockedTasks = await service('list');
  assert.equal(blockedTasks.ok, false);
  assert.equal(taskServiceCount(controller), 0);
  const settings = await service('settings');
  assert.equal(settings.ok, true, settings.error);
  assert.deepEqual(settings.data, {
    agents: 1,
    builds: 1,
    ui: 1,
    browsers: 1,
    error: controller.snapshot().runtime!.error,
    requiresStart: true,
  });
  const doc = await call(
    controller,
    'workspace-service',
    { service: 'documents', method: 'read', params: { path: 'human.txt' } },
    'saved-owner',
  );
  assert.equal(doc.ok, true, doc.error);
  const saved = await call(
    controller,
    'workspace-service',
    {
      service: 'documents',
      method: 'save',
      params: {
        path: 'human.txt',
        content: 'human edit during settings repair',
        expectedRevision: (doc.data as { revision: unknown }).revision,
      },
    },
    'saved-owner',
  );
  assert.equal(saved.ok, true, saved.error);
  assert.equal(
    await readFile(join(f.workspace, 'human.txt'), 'utf8'),
    'human edit during settings repair',
  );
  for (const bad of [
    { agents: 0 },
    { agents: 33 },
    { ui: 2 },
    { agents: 1, error: 'renderer must not return error as authority' },
  ]) {
    const rejected = await service('settings', { limits: bad });
    assert.equal(rejected.ok, false);
    assert.equal(await readFile(f.settingsPath, 'utf8'), invalid);
    assert.equal(model.requests.length, 0);
    assert.equal(taskServiceCount(controller), 0);
  }
  const repaired = await service('settings', {
    limits: { agents: 1, builds: 2, ui: 1, browsers: 1 },
  });
  assert.equal(repaired.ok, true, repaired.error);
  assert.deepEqual(repaired.data, { agents: 1, builds: 2, ui: 1, browsers: 1 });
  assert.equal(controller.snapshot().runtime!.error, undefined);
  assert.equal(taskServiceCount(controller), 0);
  assert.equal(model.requests.length, 0);
  assert.deepEqual(
    JSON.parse(await readFile(f.settingsPath, 'utf8')),
    repaired.data,
  );
  // This is the original panel's complete post-save refresh, not merely the POST instant.
  const refresh = await Promise.all([service('list'), service('settings')]);
  assert(refresh.every((reply) => reply.ok));
  assert.equal((refresh[0]!.data as TaskRecord[])[0]!.state, 'queued');
  assert.equal(
    (refresh[1]!.data as { requiresStart: boolean }).requiresStart,
    true,
  );
  const refreshedAgain = await service('list');
  assert.equal((refreshedAgain.data as TaskRecord[])[0]!.state, 'queued');
  assert.equal(model.requests.length, 0);
  assert.equal(taskServiceCount(controller), 1);
  const unchanged = new TaskStore(database);
  try {
    assert.deepEqual(unchanged.get(pending.spec.id), pending);
    assert.deepEqual(unchanged.eventsAfter(0), originalEvents);
  } finally {
    unchanged.close();
  }
  // Repair and panel refresh must not turn into permission to replay on a later app launch.
  await controller.close();
  controller = new RuntimeController({ ...f.options, model });
  controller.publish();
  assert.equal(taskServiceCount(controller), 0);
  assert.equal(model.requests.length, 0);
  const afterRestart = await Promise.all([
    service('list'),
    service('settings'),
  ]);
  assert(afterRestart.every((reply) => reply.ok));
  assert.equal((afterRestart[0]!.data as TaskRecord[])[0]!.state, 'queued');
  assert.equal(
    (afterRestart[1]!.data as { requiresStart: boolean }).requiresStart,
    true,
  );
  assert.equal(
    model.requests.length,
    0,
    'valid repaired limits must not erase explicit-start recovery intent',
  );
  assert.equal(controller.snapshot().runtime!.error, undefined);
  assert.deepEqual(JSON.parse(await readFile(f.recoveryPath, 'utf8')), {
    version: 1,
    startedWorkspaces: [],
  });
  const started = await service('start');
  assert.equal(started.ok, true, started.error);
  await until(async () => {
    const result = await service('list');
    return (result.data as TaskRecord[])[0]!.state === 'needs_review';
  }, 'explicit original start did not run the actual queued worker and independent reviewer');
  assert.equal(model.requests.length, 2);
  assert.match(
    model.requests[0]!.messages.find((row) => row.role === 'user')!.content,
    /Run only after the original explicit start action/,
  );
  const finalSettings = await service('settings');
  assert.deepEqual(finalSettings.data, {
    agents: 1,
    builds: 2,
    ui: 1,
    browsers: 1,
  });
  assert.equal(
    controller.snapshot().sessions.find((row) => row.id === 'saved-owner')!
      .messages[0]!.text,
    savedUser.content,
  );
  assert.equal(
    await readFile(join(f.workspace, 'human.txt'), 'utf8'),
    'human edit during settings repair',
  );
  const recovery = JSON.parse(await readFile(f.recoveryPath, 'utf8'));
  assert.equal(recovery.startedWorkspaces.length, 1);
  assert.equal(recovery.startedWorkspaces[0].canonical, canonical);
  await controller.close();
  controller = new RuntimeController({ ...f.options, model });
  assert.deepEqual(
    (await service('settings')).data,
    {
      agents: 1,
      builds: 2,
      ui: 1,
      browsers: 1,
    },
    'an explicit start retains the authorization for the same granted directory after restart',
  );
  assert.equal(model.requests.length, 2);
  await controller.close();
  // The same canonical string with another inode must require a new explicit confirmation.
  const { rename } = await import('node:fs/promises');
  await rename(f.workspace, `${f.workspace}-original`);
  await mkdir(f.workspace);
  controller = new RuntimeController({ ...f.options, model });
  const replaced = await service('settings');
  assert.equal(replaced.ok, true, replaced.error);
  assert.equal(
    (replaced.data as { requiresStart: boolean }).requiresStart,
    true,
  );
  assert.equal(
    model.requests.length,
    2,
    'a replaced directory must not inherit the prior start confirmation',
  );
  t.diagnostic(
    JSON.stringify({
      invalidStartupVisible: true,
      historyRetained: true,
      parentSaveDuringError: true,
      zeroModelsThroughRepairRefreshAndRestart: true,
      explicitStartActualWorkerAndReviewerRequests: model.requests.length,
      confirmationClearedForWorkspace: true,
    }),
  );
});

test('a malformed recovery checkpoint keeps the app usable and preserves both files until an explicit valid settings repair', async (t) => {
  const f = await fixture();
  let controller: RuntimeController | undefined;
  t.after(async () => {
    await controller?.close();
    await rm(f.root, { recursive: true, force: true });
  });
  await mkdir(join(f.dataFolder, 'workspace-services'));
  const originalLimits = JSON.stringify({
    agents: 3,
    builds: 2,
    ui: 1,
    browsers: 1,
  });
  const malformedRecovery = '{broken recovery checkpoint';
  await writeFile(f.settingsPath, originalLimits);
  await writeFile(f.recoveryPath, malformedRecovery);
  const model = new ScriptedModel();
  controller = new RuntimeController({ ...f.options, model });
  const id = controller.snapshot().activeSessionId;
  const settings = (params: Record<string, unknown> = {}) =>
    call(
      controller!,
      'workspace-service',
      {
        service: 'tasks',
        method: 'settings',
        params,
      },
      id,
    );
  assert.match(
    controller.snapshot().runtime!.error!,
    /could not load task settings recovery/,
  );
  assert.deepEqual(resources(controller).getLimits(), {
    agents: 1,
    builds: 1,
    ui: 1,
    browsers: 1,
  });
  assert.equal(
    (await call(controller, 'prompt', { text: 'must remain blocked' }, id)).ok,
    false,
  );
  const invalid = await settings({ limits: { agents: 0 } });
  assert.equal(invalid.ok, false);
  assert.equal(await readFile(f.settingsPath, 'utf8'), originalLimits);
  assert.equal(await readFile(f.recoveryPath, 'utf8'), malformedRecovery);
  assert.equal(taskServiceCount(controller), 0);
  const repaired = await settings({
    limits: { agents: 2, builds: 2, ui: 1, browsers: 1 },
  });
  assert.equal(repaired.ok, true, repaired.error);
  assert.deepEqual(JSON.parse(await readFile(f.recoveryPath, 'utf8')), {
    version: 1,
    startedWorkspaces: [],
  });
  assert.equal(controller.snapshot().runtime!.error, undefined);
  await controller.close();
  controller = new RuntimeController({ ...f.options, model });
  assert.equal(controller.snapshot().runtime!.error, undefined);
  assert.deepEqual((await settings()).data, {
    agents: 2,
    builds: 2,
    ui: 1,
    browsers: 1,
    requiresStart: true,
  });
  assert.equal(taskServiceCount(controller), 0);
  assert.equal(model.requests.length, 0);
});
