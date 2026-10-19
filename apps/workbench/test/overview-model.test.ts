import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PullRequestOverview,
  PullRequestSummary,
} from '../../desktop/src/workspace/pulls-types.ts';
import { contextUsage } from '../src/model/context-usage.ts';
import {
  agentLabel,
  outputRows,
  overviewProgress,
  pendingFor,
  pullRequestAction,
  relativeTo,
} from '../src/model/overview.ts';
import type {
  AgentRecord,
  Interaction,
  Session,
  Todo,
} from '../src/model/types.ts';

const agent = (extra: Partial<AgentRecord> = {}): AgentRecord => ({
  id: 'a1',
  sessionId: 's1',
  name: 'general-purpose: clean the build and rebuild',
  description: 'general-purpose: clean the build and rebuild',
  status: 'running',
  model: 'm',
  tokens: 0,
  messages: [],
  ...extra,
});
const session = (id: string, extra: Partial<Session> = {}) =>
  ({
    id,
    title: id,
    messages: [{ id: 'm', role: 'user', text: 'x' }],
    queue: [],
    state: 'idle',
    todos: [],
    ...extra,
  }) as unknown as Session;
const task = (id: string, state: string, parent = 's1'): AgentRecord =>
  agent({
    id,
    sessionId: parent,
    resourceSessionId: id,
    name: `task ${id}`,
    description: `task ${id}`,
    status: 'running',
    task: {
      id: `t-${id}`,
      attempt: 1,
      state: state as NonNullable<AgentRecord['task']>['state'],
      access: 'write',
      baseline: 'b',
    },
  });

test('a subagent title reads as a name and what it was sent to do', () => {
  assert.deepEqual(agentLabel(agent()), {
    name: 'general-purpose',
    detail: 'clean the build and rebuild',
  });
  // Long titles keep one line of detail.
  assert.equal(
    agentLabel(agent({ name: 'explore: find\n  every   call' })).detail,
    'find every call',
  );
  // A name with no type prefix falls back to a separate description.
  assert.deepEqual(
    agentLabel(agent({ name: 'explore', description: 'Find reconnect tests' })),
    { name: 'explore', detail: 'Find reconnect tests' },
  );
  assert.deepEqual(
    agentLabel(agent({ name: 'explore', description: 'explore' })),
    {
      name: 'explore',
      detail: '',
    },
  );
  // A task keeps its own name and has no separate detail.
  assert.deepEqual(agentLabel(task('x', 'running')), {
    name: 'task x',
    detail: '',
  });
});

test('in progress lists the plan step, running subagents and tasks that are not finished', () => {
  const todos: Todo[] = [
    { id: '1', text: 'trace', status: 'completed' },
    { id: '2', text: 'add a test', status: 'running' },
    { id: '3', text: 'run the suite', status: 'pending' },
  ];
  const top = session('s1', { todos });
  const sessions = [
    top,
    session('t1'),
    session('t2'),
    session('t3'),
    session('t4'),
  ];
  const agents = [
    agent({ id: 'a1' }),
    agent({ id: 'a2', status: 'completed' }),
    agent({ id: 'a3', sessionId: 'other' }),
    task('t1', 'running'),
    task('t2', 'needs_review'),
    task('t3', 'succeeded'),
    task('t4', 'failed'),
  ];
  const progress = overviewProgress(top, sessions, agents);
  assert.deepEqual(
    progress.plan && { ...progress.plan, current: progress.plan.current?.text },
    {
      done: 1,
      total: 3,
      current: 'add a test',
    },
  );
  assert.deepEqual(
    progress.agents.map((item) => item.id),
    ['a1'],
  );
  assert.deepEqual(
    progress.tasks.map((item) => item.session.id).sort(),
    ['t1', 't2'],
    'a finished or failed task is not in progress, a task that needs review is',
  );
  assert.equal(overviewProgress(session('s9'), sessions, agents).plan, null);
});

test('a finished plan is not in progress, so it neither counts nor shows', () => {
  const finished = session('s1', {
    todos: [
      { id: '1', text: 'trace', status: 'completed' },
      { id: '2', text: 'fix', status: 'completed' },
    ],
  });
  const progress = overviewProgress(
    finished,
    [finished],
    [agent({ id: 'a1' })],
  );
  assert.equal(progress.plan, null);
  // What the card counts: the subagent at work, and no plan.
  assert.deepEqual(
    progress.agents.map((item) => item.id),
    ['a1'],
  );
  assert.equal(overviewProgress(finished, [finished], []).plan, null);
});

test('the plan step in progress falls back to the next pending one', () => {
  const s = session('s1', {
    todos: [
      { id: '1', text: 'done', status: 'completed' },
      { id: '2', text: 'next', status: 'pending' },
    ],
  });
  assert.equal(overviewProgress(s, [s], []).plan?.current?.text, 'next');
});

test('a waiting subagent is matched to the request it made', () => {
  const asked = {
    id: 'i1',
    status: 'pending',
    sessionId: 's1',
    kind: 'approval',
    title: 'execute',
    command: 'rm -rf dist',
    origin: { agent: 'a1', name: 'general-purpose' },
  } as unknown as Interaction;
  const answered = {
    ...asked,
    id: 'i2',
    status: 'recorded',
  } as unknown as Interaction;
  const other = {
    ...asked,
    id: 'i3',
    origin: { agent: 'a2' },
  } as unknown as Interaction;
  assert.equal(pendingFor('a1', [answered, other, asked])?.id, 'i1');
  assert.equal(pendingFor('a1', [answered, other]), undefined);
});

test('paths in the outputs are relative to the folder, on either kind of slash', () => {
  assert.equal(relativeTo('/work/orbit/src/a.ts', '/work/orbit'), 'src/a.ts');
  assert.equal(relativeTo('/work/orbit/src/a.ts', '/work/orbit/'), 'src/a.ts');
  assert.equal(
    relativeTo('/work/other/a.ts', '/work/orbit'),
    '/work/other/a.ts',
  );
  // A Windows folder and path differ in slash and in a drive letter's case.
  assert.equal(
    relativeTo('C:\\Users\\me\\orbit\\src\\a.ts', 'c:\\Users\\me\\orbit'),
    'src/a.ts',
  );
  assert.equal(
    relativeTo('c:/Users/me/orbit/src/a.ts', 'C:\\Users\\me\\orbit\\'),
    'src/a.ts',
  );
  assert.equal(
    relativeTo('C:\\Users\\me\\orbit-two\\a.ts', 'C:\\Users\\me\\orbit'),
    'C:/Users/me/orbit-two/a.ts',
    'a sibling folder with the same prefix is not inside the folder',
  );
  assert.equal(relativeTo('src\\a.ts'), 'src/a.ts');

  const rows = outputRows(
    [
      { path: '/w/src/client.ts', kind: 'modified', at: '', diff: {} as never },
      {
        path: '/w/tests/new.test.ts',
        kind: 'added',
        at: '',
        diff: {} as never,
      },
      { path: '/w/old.ts', kind: 'deleted', at: '', diff: {} as never },
    ],
    '/w',
  );
  assert.deepEqual(
    rows.map((row) => [row.path, row.name, row.folder, row.letter]),
    [
      ['src/client.ts', 'client.ts', 'src', 'M'],
      ['tests/new.test.ts', 'new.test.ts', 'tests', 'A'],
      ['old.ts', 'old.ts', '', 'D'],
    ],
  );
  assert.deepEqual(outputRows(undefined), []);
});

const pull = (extra: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  number: 1,
  title: 't',
  url: 'https://github.com/a/b/pull/1',
  state: 'open',
  draft: true,
  headRef: 'feat',
  ...extra,
});
const overview = (
  git: Partial<PullRequestOverview['git']>,
  extra: Partial<PullRequestOverview> = {},
): PullRequestOverview => ({
  git: {
    repository: true,
    branch: 'feat',
    defaultBranch: 'main',
    github: 'a/b',
    files: 0,
    additions: 0,
    deletions: 0,
    ahead: 0,
    unpushed: 0,
    ...git,
  },
  access: 'ready',
  current: null,
  recent: [],
  ...extra,
});

test('the changes card offers to create a pull request, update one, or nothing', () => {
  assert.equal(pullRequestAction(undefined), null);
  // Nothing in the branch to put in a pull request.
  assert.equal(pullRequestAction(overview({})), null);
  assert.equal(pullRequestAction(overview({ files: 2 })), 'create');
  assert.equal(
    pullRequestAction(overview({ ahead: 1, unpushed: 1 })),
    'create',
  );
  // Already committed and pushed, already has one: nothing to do.
  assert.equal(
    pullRequestAction(overview({ ahead: 1 }, { current: pull() })),
    null,
  );
  assert.equal(
    pullRequestAction(overview({ files: 1, ahead: 1 }, { current: pull() })),
    'update',
  );
  assert.equal(
    pullRequestAction(overview({ ahead: 2, unpushed: 1 }, { current: pull() })),
    'update',
  );
  // On the default branch, work not committed or not pushed is offered as a new pull
  // request (the skill moves it to a branch first); a detached HEAD has no branch.
  assert.equal(
    pullRequestAction(overview({ branch: 'main', files: 3 })),
    'create',
  );
  assert.equal(
    pullRequestAction(overview({ branch: 'main', ahead: 0, unpushed: 2 })),
    'create',
  );
  assert.equal(pullRequestAction(overview({ branch: 'main' })), null);
  assert.equal(pullRequestAction(overview({ branch: '', files: 3 })), null);
  for (const access of ['missing', 'signed-out', 'unavailable'] as const)
    assert.equal(pullRequestAction(overview({ files: 3 }, { access })), null);
});

test("context usage reads the terminal footer's numbers, and its tokens are the window's fill", () => {
  const unknown = contextUsage({ meters: undefined });
  assert.deepEqual(unknown, {
    percent: null,
    level: '',
    fill: 'N/A',
    cost: 'N/A',
    cache: 'N/A',
  });
  const meters = {
    input: 12_300,
    output: 1200,
    cacheRead: 6150,
    cost: '$0.04',
    contextInput: 14_100,
    contextWindow: 128_000,
  };
  const usage = contextUsage({ meters });
  // What the last answer left in the window, of the model's window: not what the whole
  // session sent and received.
  assert.equal(usage.fill, '14.1k / 128.0k');
  assert.equal(Math.round(usage.percent!), 11);
  assert.equal(usage.cost, '$0.04');
  assert.equal(usage.cache, '50.0%');
  assert.equal(usage.level, '');
  assert.equal(
    contextUsage({ meters: { ...meters, contextInput: 90_000 } }).level,
    'high',
  );
  assert.equal(
    contextUsage({ meters: { ...meters, contextInput: 120_000 } }).level,
    'full',
  );
  assert.equal(
    contextUsage({ meters: { ...meters, contextWindow: 1_048_576 } }).fill,
    '14.1k / 1.0M',
  );
  assert.equal(
    contextUsage({ meters: { ...meters, contextWindow: null } }).fill,
    '14.1k / N/A',
  );
  assert.equal(
    contextUsage({ meters: { ...meters, contextInput: null } }).fill,
    'N/A',
  );
});
