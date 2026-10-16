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
    cyclePorts: () => ports,
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
test('session factories isolate matching cycle ids and stop only the released owner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-cycle-owner-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-cycle-owner-data-'));
  const progressed = new Set<string>();
  const actions: string[] = [];
  const created: string[] = [];
  const bound = new Set<string>();
  const factory = (owner: string): CyclePorts => {
    created.push(owner);
    return {
      bind: (record, mode) => {
        assert.equal(mode, 'created');
        bound.add(owner + ':' + record.id);
      },
      tasks: {
        create: async (record) => {
          assert(bound.has(owner + ':' + record.id));
          actions.push(owner + ':create');
          return ['task-' + owner];
        },
        status: async () => (progressed.has(owner) ? 'passed' : 'pending'),
        merge: async () => {
          actions.push(owner + ':merge');
          return { status: 'merged', workspace: root };
        },
      },
      verify: async () => ({
        passed: true,
        head: 'head-' + owner,
        paths: [],
        evidence: [
          {
            criterion: 'works',
            status: 'passed',
            source: 'independent-review',
            detail: 'owner-bound fixture',
          },
        ],
      }),
      git: {
        snapshot: async () => ({
          head: 'head-' + owner,
          revision: 'revision-' + owner,
          branch: 'codex/' + owner,
          dirty: false,
        }),
        commit: async () => {
          throw Error('not needed');
        },
        push: async () => {
          actions.push(owner + ':push');
        },
      },
      delivery: {
        publish: async () => {
          actions.push(owner + ':publish');
          return {
            url: 'https://github.com/example/project/pull/1',
            head: 'head-' + owner,
          };
        },
        checks: async () => ({
          head: 'head-' + owner,
          checks: [{ name: 'tests', bucket: 'pass' }],
        }),
        logs: async () => 'owner logs',
        retry: async () => {},
        ready: async () => {
          actions.push(owner + ':ready');
        },
      },
    };
  };
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    cyclePorts: async (owner) => factory(owner),
    cycleIntervalMs: 10,
    emit: () => {},
  });
  try {
    for (const owner of ['a', 'b'])
      await service.call(owner, 'cycles', 'create', {
        id: 'same-cycle-id',
        operationId: 'same-operation-id',
        title: owner,
        body: '',
        acceptanceCriteria: ['works'],
      });
    assert.deepEqual(created, ['a', 'b']);
    assert.deepEqual([...bound].sort(), ['a:same-cycle-id', 'b:same-cycle-id']);
    for (let i = 0; i < 100; i++) {
      const allA = (await service.call('a', 'cycles', 'list')) as CycleRecord[];
      const allB = (await service.call('b', 'cycles', 'list')) as CycleRecord[];
      assert.equal(allA.length, 1);
      assert.equal(allB.length, 1);
      assert.equal(allA[0].title, 'a');
      assert.equal(allB[0].title, 'b');
      if (allA[0].state === 'working' && allB[0].state === 'working') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(await service.hasActiveSession('a'), true);
    assert.equal(await service.hasActiveSession('b'), true);
    await service.releaseSession('a');
    assert.equal(await service.hasActiveSession('a'), false);
    await assert.rejects(service.call('a', 'cycles', 'list'), /closed/);
    progressed.add('a');
    progressed.add('b');
    for (let i = 0; i < 200; i++) {
      const allB = (await service.call('b', 'cycles', 'list')) as CycleRecord[];
      if (allB[0].state === 'pending_human_merge') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(actions.includes('b:ready'));
    assert.ok(!actions.includes('a:merge'));
    assert.ok(!actions.includes('a:push'));
    const events = (await service.replay()).events.filter(
      (event) => event.service === 'cycles',
    );
    assert.ok(events.some((event) => event.sessionId === 'a'));
    assert.ok(events.some((event) => event.sessionId === 'b'));
    assert.equal(await service.hasActiveSession('b'), false);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
test('a failed cycle factory does not trap session cleanup and can be retried', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-cycle-factory-fail-'));
  const data = await mkdtemp(
    path.join(tmpdir(), 'circle-cycle-factory-fail-data-'),
  );
  let calls = 0;
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'unused',
    cyclePorts: async () => {
      calls++;
      throw Error('configuration unavailable');
    },
    emit: () => {},
  });
  try {
    await assert.rejects(
      service.call('a', 'cycles', 'list'),
      /configuration unavailable/,
    );
    assert.equal(await service.hasActiveSession('a'), false);
    await assert.rejects(
      service.call('a', 'cycles', 'list'),
      /configuration unavailable/,
    );
    assert.equal(calls, 2);
    await assert.doesNotReject(service.releaseSession('a'));
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
