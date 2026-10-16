import { createRoot } from 'react-dom/client';
import { TasksPanel } from '../src/features/TasksPanel';
import { setLanguage } from '../src/i18n';
import { applyTheme } from '../src/theme';
import '../src/styles/app.css';
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
applyTheme(query.get('theme') === 'dark' ? 'dark' : 'light');
let invalid = true;
let limits = { agents: 1, builds: 1, ui: 1, browsers: 1 };
const calls: unknown[] = [];
Object.assign(window, {
  calls,
  circleDesktop: {
    runtimeCommand: async (command: any) => {
      calls.push(command);
      const { service, method, params } = command.payload;
      if (service === 'operations') return { ok: true, data: [] };
      if (method === 'settings') {
        if (params.limits) {
          if (
            Object.keys(params.limits).sort().join(',') !==
            'agents,browsers,builds,ui'
          )
            return { ok: false, error: 'unexpected settings fields' };
          limits = params.limits;
          invalid = false;
        }
        return {
          ok: true,
          data: {
            ...limits,
            ...(invalid
              ? { error: 'could not load task settings: invalid agents' }
              : {}),
          },
        };
      }
      if (method === 'list')
        return invalid
          ? {
              ok: false,
              error: 'task scheduler unavailable until limits are repaired',
            }
          : { ok: true, data: [] };
      if (method === 'enqueue') return { ok: true, data: [] };
      return { ok: true, data: [] };
    },
  },
});
createRoot(document.getElementById('root')!).render(
  <TasksPanel sessionId="synthetic-parent" onSession={() => {}} />,
);
