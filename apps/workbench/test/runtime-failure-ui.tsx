import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { setLanguage } from '../src/i18n';
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
const runtime = new PreviewRuntime();
const error =
  '✖ 404 status code (no body)\n' + 'original error line\n'.repeat(600);
runtime.change((state) => {
  state.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
  const session = state.sessions[0]!;
  state.activeSessionId = session.id;
  session.messages = [
    {
      id: 'failure-input',
      role: 'user',
      parentId: null,
      text: 'attempt configured connection',
      at: '2026-10-16T00:00:00Z',
    },
    {
      id: 'failure-actual-controller-identity',
      parentId: 'failure-input',
      role: 'notice',
      text: error,
      at: '2026-10-16T00:00:01Z',
    },
    {
      id: 'ordinary-notice',
      parentId: 'failure-input',
      role: 'notice',
      text: '✖ 404 is quoted text, not a runtime failure',
      at: '2026-10-16T00:00:02Z',
    },
  ];
  session.leafId = 'failure-input';
  session.branchIds = session.messages.map((message) => message.id);
  session.hiddenIds = [];
  session.draft = 'preserve draft and never automatically resend';
  session.state = 'idle';
  state.interactions = [];
  state.requests = [];
});
const copied: string[] = [];
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      copied.push(text);
    },
  },
});
Object.assign(window, { failureFixture: { runtime, error, copied } });
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
