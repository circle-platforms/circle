import { createRoot } from 'react-dom/client';
import { TaskLimitsSettings } from '../src/features/TaskLimitsSettings';
import { setLanguage } from '../src/i18n';
import { applyTheme } from '../src/theme';
import '../src/styles/app.css';

// The settings page's parallel tasks, behind a host whose saved limit could not be read:
// saving a value repairs it, and the queued tasks then wait until the person starts them.
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
applyTheme(query.get('theme') === 'dark' ? 'dark' : 'light');
let invalid = true;
let requiresStart = false;
let limits = { agents: 1, builds: 1, ui: 1, browsers: 1 };
const calls: { method: string; params?: unknown }[] = [];
Object.assign(window, {
  calls,
  circleDesktop: {
    runtimeCommand: async (command: any) => {
      const { service, method, params } = command.payload;
      if (service !== 'tasks') return { ok: true, data: [] };
      calls.push({ method, params });
      if (method === 'settings') {
        if (params?.limits) {
          limits = params.limits;
          invalid = false;
          requiresStart = true;
        }
        return {
          ok: true,
          data: {
            ...limits,
            ...(requiresStart ? { requiresStart: true } : {}),
            ...(invalid
              ? { error: 'could not load task settings: invalid agents' }
              : {}),
          },
        };
      }
      if (method === 'start') {
        requiresStart = false;
        return { ok: true, data: [] };
      }
      return { ok: false, error: `unexpected ${method}` };
    },
  },
});
createRoot(document.getElementById('root')!).render(
  <main className="page" style={{ padding: 24, maxWidth: 760 }}>
    <TaskLimitsSettings sessionId="session1" />
  </main>,
);
