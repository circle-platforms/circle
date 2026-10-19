import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { circlePlugins } from '../src/plugins/builtins';
import { PreviewRuntime } from '../src/model/state';
import { createFixtures } from '../src/preview/fixtures';
import { setLanguage } from '../src/i18n';

// A task conversation open in the window, its task finished and waiting for review, behind
// a fake desktop host that serves the task list and records the decisions made.
const query = new URLSearchParams(location.search),
  data = createFixtures();
data.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const parent = data.sessions[0]!;
const task = structuredClone(parent);
task.id = 'task-session';
task.title = 'add a regression for the close boundary';
task.messages = [
  {
    id: 'tu',
    parentId: null,
    role: 'user',
    at: '12:00',
    text: 'Add a regression test for the close boundary.',
  },
  {
    id: 'ta',
    parentId: 'tu',
    role: 'assistant',
    at: '12:05',
    text: 'Added the regression test and ran the reconnect suite.',
  },
];
task.leafId = 'ta';
task.todos = [];
task.changes = [];
// The parent conversation's call that scheduled the task links to it.
parent.messages = [
  ...parent.messages,
  {
    id: 'schedule',
    parentId: parent.leafId,
    role: 'tool',
    at: '12:00',
    text: 'scheduled 1 task',
    tool: {
      id: 'call-schedule',
      name: 'native_tasks_enqueue',
      input: {},
      output: 'queued task-1',
      status: 'success',
      agentIds: ['task-agent'],
    },
  },
];
parent.leafId = 'schedule';
// The task's independent reviewer has a conversation of its own, and only reads.
const reviewer = structuredClone(task);
reviewer.id = 'reviewer-session';
reviewer.title = 'review add a regression for the close boundary';
data.sessions = [parent, task, reviewer];
data.activeSessionId = task.id;
data.interactions = [];
data.requests = [];
data.jobs = [];
data.agents = [
  {
    id: 'task-agent',
    sessionId: parent.id,
    resourceSessionId: task.id,
    name: 'add a regression for the close boundary',
    description: 'add a regression for the close boundary',
    status: 'running',
    model: 'sample-code-model',
    tokens: 0,
    messages: [],
    task: {
      id: 'task-1',
      attempt: 1,
      state: 'needs_review',
      access: 'write',
      baseline: 'b'.repeat(40),
    },
  },
  {
    id: 'reviewer-agent',
    sessionId: parent.id,
    resourceSessionId: reviewer.id,
    name: 'review add a regression for the close boundary',
    description: 'review add a regression for the close boundary',
    status: 'completed',
    model: 'sample-code-model',
    tokens: 0,
    messages: [],
    readOnly: true,
    task: {
      id: 'task-1',
      role: 'reviewer',
      attempt: 1,
      state: 'needs_review',
      access: 'readonly',
      baseline: 'b'.repeat(40),
    },
  },
];
const runtime = new PreviewRuntime({
  getItem: () => JSON.stringify(data),
  setItem: () => {},
  removeItem: () => {},
});
const sha = 'a'.repeat(64);
let record: any = {
  spec: {
    id: 'task-1',
    prompt: 'Add a regression test for the close boundary.',
    acceptanceCriteria: [
      'the last frame is kept at the close boundary',
      'the buffer is empty after the reconnect',
    ],
    baseline: 'b'.repeat(40),
    dependencies: [],
  },
  state: 'needs_review',
  attempt: 1,
  result: {
    taskId: 'task-1',
    attempt: 1,
    checks: [],
    changes: {
      sha256: sha,
      head: 'c'.repeat(40),
      paths: ['tests/reconnect.test.ts', 'src/connection.ts'],
    },
  },
  createdAt: 1,
  updatedAt: 2,
};
const calls: Array<{ method: string; params: any }> = [];
window.circleDesktop = {
  setTheme: async () => {},
  onBrowserEvent: () => () => {},
  onTerminalEvent: () => () => {},
  onAction: () => () => {},
  onWorkspaceEvent: () => () => {},
  browserState: async () => ({ sessionId: 'none' }),
  runtimeCommand: async (command: any) => {
    const { service, method, params } = command.payload ?? {};
    if (service !== 'tasks') return { ok: true, data: [] };
    if (method === 'list') return { ok: true, data: [structuredClone(record)] };
    // As the service does: a decision is of the attempt and patch that were shown.
    if (
      params?.expectedAttempt !== record.attempt ||
      params?.expectedPatchSha256 !== record.result.changes.sha256
    )
      return { ok: false, error: 'the task changed since it was shown' };
    calls.push({ method, params });
    // A decision is taken: the task is no longer waiting for one.
    record = {
      ...record,
      state: 'running',
      attempt: method === 'reject' ? 2 : record.attempt,
    };
    return { ok: true, data: record };
  },
} as unknown as NonNullable<Window['circleDesktop']>;
Object.assign(window, {
  taskReviewFixture: {
    calls,
    parent: parent.id,
    /** The task runs again as a later attempt, and finishes with another patch. */
    nextAttempt: () => {
      record = {
        ...record,
        state: 'needs_review',
        attempt: record.attempt + 1,
        result: {
          ...record.result,
          attempt: record.attempt + 1,
          changes: { ...record.result.changes, sha256: 'd'.repeat(64) },
        },
      };
    },
  },
});
setLanguage(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en');
location.hash = `/session/${task.id}`;
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
