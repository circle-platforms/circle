import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { setLanguage } from '../src/i18n';
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
const runtime = new PreviewRuntime();
const text =
  Array.from(
    { length: 600 },
    (_, i) =>
      `test\tRun npm test\t2026-10-16T00:00:00Z\t第${i + 1}行 ${'long original output '.repeat(8)}\x1b[31m red\x1b[0m`,
  ).join('\n') +
  '\n<img src=x onerror=alert(1)>\x1b]8;;https://example.test\x07inert link\x1b]8;;\x07';
const raw = JSON.stringify({ text, head: 'candidate-exact-head', runId: 314 });
runtime.change((state) => {
  state.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
  const session = state.sessions[0]!;
  state.activeSessionId = session.id;
  session.title = 'structured tool output';
  session.todos = [];
  session.queue = [];
  session.attachments = [];
  session.draft = '';
  session.presentation = { scroll: { top: 0, follow: false } };
  state.jobs = [];
  state.agents = [];
  session.messages = [
    {
      id: 'question',
      parentId: null,
      role: 'user',
      text: 'inspect failed checks',
      at: '',
    },
    {
      id: 'tool',
      parentId: 'question',
      role: 'tool',
      text: '',
      at: '',
      tool: {
        id: 'text-call',
        name: 'untrusted_custom_logs',
        input: { runId: 314 },
        output: raw,
        status: 'success',
      },
    },
  ];
  session.leafId = 'tool';
  session.branchIds = ['question', 'tool'];
  session.hiddenIds = [];
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
Object.assign(window, { textOutputFixture: { text, raw, copied } });
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={[]} />,
);
