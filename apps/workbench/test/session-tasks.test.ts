import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtures } from '../src/preview/fixtures.ts';
import {
  orderedProjects,
  recentSessions,
  sidebarTasks,
  taskOwners,
  taskWorkspaceIds,
  topLevelSessions,
} from '../src/model/session-management.ts';
import type {
  AgentRecord,
  Session,
  WorkbenchSnapshot,
} from '../src/model/types.ts';

type Role = 'worker' | 'reviewer';

/** An owner conversation in a project, and task conversations in their own worktrees. */
function fixture() {
  const snapshot = createFixtures();
  const owner = snapshot.sessions[0]!;
  const project = snapshot.workspaces.find(
    (item) => item.id === owner.workspaceId,
  )!;
  const add = (
    id: string,
    taskId: string,
    role: Role,
    at: string,
    parent = owner.id,
    workspaceId = 'worktree-' + taskId,
  ) => {
    if (!snapshot.workspaces.some((item) => item.id === workspaceId))
      snapshot.workspaces.push({
        ...project,
        id: workspaceId,
        name: 'a0b1c2d3e4f5678901234567-1',
        path: '/isolated/task-worktrees/' + workspaceId,
      });
    snapshot.sessions.push({
      ...structuredClone(owner),
      id,
      workspaceId,
      title: id,
      archivedAt: undefined,
      messages: [
        {
          id: id + '-m',
          parentId: null,
          role: 'user',
          text: 'work',
          at,
        },
      ],
    } as Session);
    snapshot.agents.push({
      ...structuredClone(snapshot.agents[0]!),
      id,
      sessionId: parent,
      name: role === 'reviewer' ? 'review: ' + taskId : taskId,
      workspaceId,
      resourceSessionId: id,
      task: {
        id: taskId,
        role,
        attempt: 1,
        state: 'running',
        access: role === 'reviewer' ? 'readonly' : 'write',
        baseline: 'abc',
      },
    } as AgentRecord);
  };
  return { snapshot, owner, add };
}

const ids = (sessions: readonly Session[]) => sessions.map((item) => item.id);

test('task and reviewer conversations fold under the conversation that started them', () => {
  const { snapshot, owner, add } = fixture();
  add('write-a', 'JOURNEY_WRITE_A', 'worker', '2030-01-01T00:00:01Z');
  add('review-a', 'JOURNEY_WRITE_A', 'reviewer', '2030-01-01T00:00:05Z');
  add('write-b', 'JOURNEY_WRITE_B', 'worker', '2030-01-01T00:00:03Z');
  const owners = taskOwners(snapshot.sessions, snapshot.agents);
  assert.deepEqual(Object.fromEntries(owners), {
    'write-a': owner.id,
    'review-a': owner.id,
    'write-b': owner.id,
  });
  const top = topLevelSessions(snapshot.sessions, snapshot.agents);
  for (const id of ['write-a', 'review-a', 'write-b'])
    assert.ok(!ids(top).includes(id), id + ' is not a top-level row');
  assert.ok(ids(top).includes(owner.id));
  // Recent shows the person's conversations; the new task activity does not push them out.
  assert.deepEqual(
    ids(recentSessions(top)).filter((id) => id.startsWith('write')),
    [],
  );
  // A worktree that holds only task conversations is not a folder.
  assert.ok(
    !orderedProjects(snapshot.workspaces, top).some((item) =>
      item.id.startsWith('worktree-'),
    ),
  );
  assert.ok(
    orderedProjects(snapshot.workspaces, top).some(
      (item) => item.id === owner.workspaceId,
    ),
  );
  // One entry per task, newest first; the worker names it and the reviewer rides along.
  const tasks = sidebarTasks(snapshot.sessions, snapshot.agents).get(owner.id)!;
  assert.deepEqual(
    tasks.map((task) => [task.session.id, task.sessionIds.sort()]),
    [
      ['write-b', ['write-b']],
      ['write-a', ['review-a', 'write-a']],
    ],
  );
  // Nothing about the data changes: every session is still in the snapshot.
  for (const id of ['write-a', 'review-a', 'write-b'])
    assert.ok(snapshot.sessions.some((item) => item.id === id));
});

test('a task with only its reviewer listed shows the reviewer, and a nested task reaches the top conversation', () => {
  const { snapshot, owner, add } = fixture();
  add('review-only', 'R', 'reviewer', '2030-01-01T00:00:01Z');
  add('outer', 'OUTER', 'worker', '2030-01-01T00:00:02Z');
  add('inner', 'INNER', 'worker', '2030-01-01T00:00:03Z', 'outer');
  const owners = taskOwners(snapshot.sessions, snapshot.agents);
  assert.equal(owners.get('inner'), owner.id);
  const tasks = sidebarTasks(snapshot.sessions, snapshot.agents).get(owner.id)!;
  assert.deepEqual(
    tasks.map((task) => task.session.id),
    ['inner', 'outer', 'review-only'],
  );
  assert.equal(
    sidebarTasks(snapshot.sessions, snapshot.agents).get('outer'),
    undefined,
  );
});

test('ordinary sessions, subagents and orphaned tasks stay where they were', () => {
  const { snapshot, owner, add } = fixture();
  add('orphan', 'ORPHAN', 'worker', '2030-01-01T00:00:01Z', 'gone');
  add('archived-owner-task', 'A', 'worker', '2030-01-01T00:00:02Z');
  const archivedOwner = structuredClone(owner);
  archivedOwner.id = 'archived-owner';
  archivedOwner.archivedAt = '2030-01-01T00:00:00Z';
  snapshot.sessions.push(archivedOwner);
  snapshot.agents.find((item) => item.id === 'archived-owner-task')!.sessionId =
    archivedOwner.id;
  // A subagent without a task record, and a task whose resources belong to its parent.
  snapshot.agents.push({
    ...structuredClone(snapshot.agents[0]!),
    id: snapshot.sessions[1]!.id,
    sessionId: owner.id,
    resourceSessionId: snapshot.sessions[1]!.id,
    task: undefined,
  });
  snapshot.agents.push({
    ...structuredClone(snapshot.agents.at(-2)!),
    id: snapshot.sessions[2]!.id,
    sessionId: owner.id,
    resourceSessionId: owner.id,
    task: {
      id: 'shared',
      attempt: 1,
      state: 'running',
      access: 'write',
      baseline: 'abc',
    },
  });
  const top = ids(topLevelSessions(snapshot.sessions, snapshot.agents));
  for (const session of snapshot.sessions)
    assert.ok(top.includes(session.id), session.id + ' stays a top-level row');
});

test('archived and empty task conversations do not count as tasks', () => {
  const { snapshot, owner, add } = fixture();
  add('done', 'DONE', 'worker', '2030-01-01T00:00:01Z');
  add('blank', 'BLANK', 'worker', '2030-01-01T00:00:02Z');
  const done = snapshot.sessions.find((item) => item.id === 'done')!;
  done.archivedAt = '2030-01-02T00:00:00Z';
  const blank = snapshot.sessions.find((item) => item.id === 'blank')!;
  blank.messages = [];
  blank.title = 'new session';
  const tasks: ReturnType<typeof sidebarTasks> = sidebarTasks(
    snapshot.sessions,
    snapshot.agents,
  );
  assert.equal(tasks.get(owner.id), undefined);
  // They stay folded under the owner rather than returning to recent.
  assert.ok(
    !ids(topLevelSessions(snapshot.sessions, snapshot.agents)).includes('done'),
  );
  void (snapshot satisfies WorkbenchSnapshot);
});

test('a task copy of the project is not a folder anywhere, while a folder with your own conversation is', () => {
  const { snapshot, owner, add } = fixture();
  add('write-a', 'JOURNEY_WRITE_A', 'worker', '2030-01-01T00:00:01Z');
  add('review-a', 'JOURNEY_WRITE_A', 'reviewer', '2030-01-01T00:00:05Z');
  // A task that works in the project folder itself does not hide that folder.
  add(
    'write-in-place',
    'JOURNEY_IN_PLACE',
    'worker',
    '2030-01-01T00:00:02Z',
    owner.id,
    owner.workspaceId,
  );
  const folders = taskWorkspaceIds(snapshot.sessions, snapshot.agents);
  assert.deepEqual([...folders], ['worktree-JOURNEY_WRITE_A']);
  assert.ok(!folders.has(owner.workspaceId));
});
