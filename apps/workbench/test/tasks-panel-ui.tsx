import { createRoot } from 'react-dom/client';
import { TasksPanel } from '../src/features/TasksPanel';
import { setLanguage } from '../src/i18n';
import { applyTheme } from '../src/theme';
import '../src/styles/app.css';
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
applyTheme(query.get('theme') === 'dark' ? 'dark' : 'light');
let records = ['running', 'succeeded', 'queued'].map((state, index) => ({
  spec: {
    id: 'task-' + index,
    prompt: [
      'Implement editor navigation',
      'Verify actual saved files',
      'Inspect resulting changes',
    ][index],
    workspace: '/synthetic/worktree-' + index,
    baseline: 'a'.repeat(40),
    dependencies: [],
    access: 'write',
    acceptanceCriteria: ['keep complete source'],
  },
  state,
  attempt: 1,
  createdAt: 1,
  updatedAt: 2,
  reason: state === 'succeeded' ? 'Independent verification passed' : undefined,
}));
const calls: unknown[] = [];
const reviewRecord = {
  ...records[1],
  spec: {
    ...records[1]!.spec,
    id: 'review-task',
    prompt:
      'Review task summary\nComplete task instruction remains available after expanding the activity row.',
  },
  state: 'needs_review',
  reason: 'Acceptance requires human review.',
  result: { changes: { sha256: 'b'.repeat(64), head: 'c'.repeat(40) } },
};
const patch = 'diff --git a/demo.ts b/demo.ts\n+preserved complete change\n';
Object.assign(window, {
  calls,
  circleDesktop: {
    runtimeCommand: async (command: any) => {
      calls.push(command);
      const { service, method, params } = command.payload;
      if (service === 'operations') return { ok: true, data: [] };
      if (method === 'settings')
        return { ok: true, data: { agents: 8, builds: 2, ui: 1, browsers: 1 } };
      if (method === 'list')
        return {
          ok: true,
          data: structuredClone(
            query.has('review') ? [reviewRecord, ...records] : records,
          ),
        };
      if (method === 'artifacts')
        return {
          ok: true,
          data: [
            {
              id: 'patch-artifact',
              kind: 'task-patch',
              sha256: 'b'.repeat(64),
              attempt: 1,
            },
          ],
        };
      if (method === 'readArtifact')
        return {
          ok: true,
          data: {
            id: 'patch-artifact',
            kind: 'task-patch',
            sha256: 'b'.repeat(64),
            content: patch,
            truncated: false,
            offset: 0,
            totalCharacters: patch.length,
            byteLength: patch.length,
          },
        };
      if (method === 'review') {
        reviewRecord.state = 'succeeded';
        return { ok: true, data: reviewRecord };
      }
      if (method === 'enqueue') {
        records = [
          ...records,
          ...params.tasks.map((spec: any) => ({
            spec: {
              ...spec,
              workspace: '/synthetic/new',
              baseline: 'a'.repeat(40),
            },
            state: 'queued',
            attempt: 1,
            createdAt: 3,
            updatedAt: 3,
          })),
        ];
        return { ok: true, data: records };
      }
      if (method === 'start') {
        records = records.map((record) =>
          record.state === 'queued' ? { ...record, state: 'running' } : record,
        );
        return { ok: true, data: records };
      }
      throw Error('unexpected fixture command');
    },
  },
});
createRoot(document.getElementById('root')!).render(
  <>
    <TasksPanel
      sessionId="task-fixture"
      onSession={() => {}}
      focusTaskId={query.has('focusTask') ? 'task-0' : undefined}
      embedded={query.has('embedded')}
    />
    {query.has('focusTask') && <textarea aria-label="manual editor" />}
  </>,
);
