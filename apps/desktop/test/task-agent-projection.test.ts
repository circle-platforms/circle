import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { realpathSync, writeFileSync } from 'node:fs';
import { scratch } from '../../../tests/helpers';
import { TaskStore, type TaskRecord } from '../src/workspace/task-store';
import {
  readArchivedTaskAttempts,
  taskToolAgentIds,
  assertReadonlyTaskRequest,
} from '../src/workspace/task-agent-projection';

const task = (
  workspace: string,
  id = 'same',
  attempt = 1,
  sessionId = 'parent',
): TaskRecord => ({
  spec: {
    id,
    workspace,
    sessionId,
    baseline: 'a'.repeat(40),
    dependencies: [],
    access: 'readonly',
    prompt: 'Read source',
    acceptanceCriteria: ['read actual bytes'],
  },
  attempt,
  state: 'running',
  runtimeSessionId: `${sessionId}-${id}-${attempt}`,
  createdAt: 1,
  updatedAt: 2,
});
test('archive reads preserve in-flight/unknown state without constructing a scheduler and scope exact owner and workspace', (t) => {
  const dataDir = scratch(t),
    workspace = realpathSync.native(scratch(t)),
    other = realpathSync.native(scratch(t));
  let store = new TaskStore(join(dataDir, 'collaboration.sqlite'));
  const first = task(workspace);
  first.state = 'cancelled';
  store.put(first);
  store.put(task(workspace, 'same', 2));
  store.put(task(workspace, 'foreign', 1, 'foreign'));
  store.put(task(other, 'other'));
  store.putOperation({
    id: 'unknown',
    kind: 'command',
    fingerprint: 'original',
    state: 'running',
  });
  store.close();
  const records = readArchivedTaskAttempts({
    dataDir,
    workspace,
    ownerSessionId: 'parent',
  });
  assert.deepEqual(
    records.map((record) => [record.spec.id, record.attempt, record.state]),
    [
      ['same', 1, 'cancelled'],
      ['same', 2, 'running'],
    ],
  );
  assert.throws(() => {
    records[0]!.spec.prompt = 'changed';
  }, TypeError);
  store = new TaskStore(join(dataDir, 'collaboration.sqlite'));
  try {
    assert.equal(store.get('same')!.state, 'running');
    assert.equal(store.operation('unknown')!.state, 'running');
  } finally {
    store.close();
  }
});
test('missing archives are empty, malformed archives fail explicitly and close their reader', (t) => {
  const dataDir = scratch(t),
    workspace = scratch(t);
  assert.deepEqual(
    readArchivedTaskAttempts({ dataDir, workspace, ownerSessionId: 'parent' }),
    [],
  );
  const file = join(dataDir, 'collaboration.sqlite');
  writeFileSync(file, 'not a database');
  assert.throws(() =>
    readArchivedTaskAttempts({ dataDir, workspace, ownerSessionId: 'parent' }),
  );
  writeFileSync(file, 'still writable after failed archive read');
});
test('tool links bind real attempt sessions and cannot claim output IDs outside the owner ledger', () => {
  const old = task('/fixture'),
    next = task('/fixture', 'same', 2),
    second = task('/fixture', 'second');
  const attempts = [old, next, second];
  assert.deepEqual(
    taskToolAgentIds(
      'native_tasks_enqueue',
      { tasks: [{ id: 'same' }, { id: 'second' }] },
      JSON.stringify({ tasks: [old, second] }),
      attempts,
    ),
    [old.runtimeSessionId, second.runtimeSessionId],
  );
  assert.deepEqual(
    taskToolAgentIds(
      'native_tasks_analyze',
      { tasks: [{ id: 'same' }] },
      JSON.stringify({ tasks: [old] }),
      attempts,
    ),
    [old.runtimeSessionId],
  );
  assert.equal(
    taskToolAgentIds(
      'native_tasks_enqueue',
      { tasks: [{ id: 'same' }] },
      '',
      attempts,
    ),
    undefined,
  );
  assert.equal(
    taskToolAgentIds(
      'native_tasks_enqueue',
      { tasks: [{ id: 'same' }] },
      JSON.stringify({ tasks: [next] }),
      attempts,
    ),
    undefined,
  );
  assert.deepEqual(
    taskToolAgentIds(
      'native_tasks_retry',
      { id: 'same' },
      JSON.stringify({ task: next }),
      attempts,
    ),
    [next.runtimeSessionId],
  );
  const foreign = task('/fixture', 'foreign', 1, 'foreign');
  assert.equal(
    taskToolAgentIds(
      'native_tasks_list',
      {},
      JSON.stringify({ tasks: [foreign] }),
      attempts,
    ),
    undefined,
  );
  assert.equal(
    taskToolAgentIds(
      'native_tasks_wait',
      { ids: ['same'] },
      JSON.stringify({ tasks: [second] }),
      attempts,
    ),
    undefined,
  );
  assert.equal(
    taskToolAgentIds('execute', {}, JSON.stringify({ tasks: [old] }), attempts),
    undefined,
  );
  assert.equal(
    taskToolAgentIds(
      'native_tasks_events',
      {},
      JSON.stringify({ tasks: [old] }),
      attempts,
    ),
    undefined,
  );
});
test('read-only source policy permits inspection and language previews but rejects disk mutation', () => {
  for (const method of ['read', 'refresh', 'resolveSource'])
    assert.doesNotThrow(() => assertReadonlyTaskRequest('documents', method));
  for (const method of ['save', 'applyEdits', 'delete'])
    assert.throws(
      () => assertReadonlyTaskRequest('documents', method),
      /read-only agent/,
    );
  for (const method of ['definition', 'rename', 'format', 'diagnostics'])
    assert.doesNotThrow(() =>
      assertReadonlyTaskRequest('language', 'request', { method }),
    );
  assert.throws(
    () =>
      assertReadonlyTaskRequest('language', 'request', {
        method: 'workspace/applyEdit',
      }),
    /previews only/,
  );
  assert.throws(
    () =>
      assertReadonlyTaskRequest('language', 'request', {
        method: 'rename',
        apply: true,
      }),
    /previews only/,
  );
});
