import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceServices } from '../src/workspace/workspace-services.ts';
import type {
  CyclePorts,
  CycleRecord,
} from '../src/workspace/delivery-cycle.ts';
test('trusted cycle ports advance automatically without renderer advance calls', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-cycle-routing-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-cycle-routing-data-'));
  const actions: string[] = [];
  const ports: CyclePorts = {
    tasks: {
      create: async () => {
        actions.push('create');
        return ['task-a'];
      },
      status: async () => 'passed',
      merge: async () => {
        actions.push('merge');
        return { status: 'merged', workspace: root };
      },
    },
    verify: async () => {
      actions.push('verify');
      return {
        passed: true,
        head: 'head-a',
        paths: [],
        evidence: [
          {
            criterion: 'works',
            status: 'passed',
            source: 'independent-review',
            detail: 'independent fixture evidence',
          },
        ],
      };
    },
    git: {
      snapshot: async () => ({
        head: 'head-a',
        revision: 'revision-a',
        branch: 'codex/cycle-a',
        dirty: false,
      }),
      commit: async () => {
        throw Error('clean commit should not run');
      },
      push: async () => {
        actions.push('push');
      },
    },
    delivery: {
      publish: async () => {
        actions.push('publish');
        return {
          url: 'https://github.com/example/project/pull/1',
          head: 'head-a',
        };
      },
      checks: async () => ({
        head: 'head-a',
        checks: [{ name: 'test', bucket: 'pass' }],
      }),
      logs: async () => 'fixture log',
      retry: async () => {},
      ready: async () => {
        actions.push('ready');
      },
    },
  };
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    cyclePorts: ports,
    cycleIntervalMs: 10,
    emit: () => {},
  });
  try {
    await assert.rejects(
      service.call('s', 'cycles', 'create', {
        id: 'bad',
        workspace: '/ungranted',
        title: 't',
        body: '',
        acceptanceCriteria: ['works'],
        operationId: 'bad',
      }),
      /trusted host/,
    );
    await service.call('s', 'cycles', 'create', {
      id: 'cycle-a',
      title: 'Deliver feature',
      body: 'body',
      acceptanceCriteria: ['works'],
      operationId: 'cycle-a-create',
    });
    let cycles: CycleRecord[] = [];
    for (let i = 0; i < 200; i++) {
      cycles = (await service.call('s', 'cycles', 'list')) as CycleRecord[];
      if (cycles[0]?.state === 'pending_human_merge') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cycles[0].state, 'pending_human_merge');
    assert.deepEqual(actions, [
      'create',
      'merge',
      'verify',
      'push',
      'publish',
      'ready',
    ]);
    assert.ok(
      (await service.replay()).events.some(
        (event) => event.service === 'cycles',
      ),
    );
    await service.dispose();
    const count = actions.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(actions.length, count);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
test('cycles without trusted execution ports fail clearly instead of reporting success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-cycle-unavailable-'));
  const data = await mkdtemp(
    path.join(tmpdir(), 'circle-cycle-unavailable-data-'),
  );
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    emit: () => {},
  });
  try {
    await assert.rejects(service.call('s', 'cycles', 'list'), /unavailable/);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
