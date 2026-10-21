import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { setLanguage } from '../src/i18n';
import type { ActionFailure } from '../src/model/types';

const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
const runtime = new PreviewRuntime();
const calls: string[] = [];
const copied: string[] = [];
// A command the runtime kept for its whole budget, as the window records it.
const failure: ActionFailure = {
  message: 'Circle did not answer in 120s · prompt',
  kind: 'timeout',
  at: '2026-10-21T00:00:00Z',
  detail:
    'runtime command timed out; execution state must be checked · prompt (120s)',
};
Object.assign(runtime, {
  retryActionFailure: (sessionId?: string) => {
    calls.push('retry ' + sessionId);
  },
  dismissActionError: (sessionId?: string) => {
    calls.push('dismiss ' + sessionId);
    runtime.change((state) => {
      const row = state.sessions.find((item) => item.id === sessionId);
      if (row) row.actionFailure = undefined;
    });
  },
});
runtime.change((state) => {
  state.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
  const session = state.sessions[0]!;
  state.activeSessionId = session.id;
  session.actionFailure = failure;
  state.runtime = {
    ...state.runtime,
    connected: true,
    configured: true,
    waiting: { command: 'custom-command', waitedMs: 8200 },
  };
});
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      copied.push(text);
    },
  },
});
Object.assign(window, { waitFixture: { runtime, calls, copied, failure } });
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
