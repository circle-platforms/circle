import { createRoot } from 'react-dom/client';
import { TasksPanel } from '../src/features/TasksPanel';
import { setLanguage } from '../src/i18n';
import { applyTheme } from '../src/theme';
import '../src/styles/app.css';
import '../src/styles/developer-workbench.css';
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
Object.assign(window, {
  calls,
  circleDesktop: {
    runtimeCommand: async (command: any) => {
      calls.push(command);
      const { service, method, params } = command.payload;
      if (service === 'operations') return { ok: true, data: [] };
      if (method === 'settings')
        return { ok: true, data: { agents: 8, builds: 2, ui: 1, browsers: 1 } };
      if (method === 'list') return { ok: true, data: records };
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
  <TasksPanel sessionId="task-fixture" onSession={() => {}} />,
);
