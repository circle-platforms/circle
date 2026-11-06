import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { setLanguage } from '../src/i18n';
import type { Message, ToolCall } from '../src/model/types';

// Two finished turns that changed files: the second writes updates between its calls, as a
// model on the commentary channel does, and has more calls than one line can hold.
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
const runtime = new PreviewRuntime();
const at = '2026-11-06T03:29:00Z';
let id = 0;
const said = (text: string, extra: Partial<Message> = {}): Message => ({
  id: `said-${++id}`,
  parentId: null,
  role: 'assistant',
  text,
  at,
  phase: 'commentary',
  ...extra,
});
const call = (
  name: string,
  input: Record<string, unknown>,
  status: ToolCall['status'] = 'success',
): Message => {
  const key = `call-${++id}`;
  return {
    id: key,
    parentId: null,
    role: 'tool',
    text: '',
    at,
    tool: { id: key, name, input, output: 'output of ' + key, status },
  };
};
const many = (count: number, name: string, input: Record<string, unknown>) =>
  Array.from({ length: count }, (_, i) =>
    call(name, { ...input, file_path: `src/file-${i}.ts` }),
  ).map((row, i) => ({
    ...row,
    tool: { ...row.tool!, filePath: `src/long-folder-name/file-${i}.ts` },
  }));
const messages: Message[] = [
  { id: 'first', parentId: null, role: 'user', text: 'first request', at },
  call('edit_file', { file_path: 'src/one.ts' }),
  said('The first turn is finished.', {
    phase: 'final_answer',
    usage: { input: 10, output: 2, elapsed: '9s' },
  }),
  { id: 'second', parentId: null, role: 'user', text: 'second request', at },
  said('I will review the two sets of changes first.'),
  call('execute', { command: 'git status' }),
  said('The review found two problems that need fixing before any commit.'),
  ...Array.from({ length: 50 }, () => call('execute', { command: 'npm test' })),
  ...many(32, 'read_file', {}),
  ...Array.from({ length: 4 }, () => call('ls', { path: 'src' })),
  ...Array.from({ length: 7 }, () => call('grep', { pattern: 'x' })),
  ...Array.from({ length: 6 }, () => call('glob', { pattern: 'x' })),
  ...many(6, 'edit_file', {}),
  call('execute', { command: 'false' }, 'error'),
  call('write_todos', { todos: [] }),
  said('Both problems are fixed and the tests pass.', {
    phase: 'final_answer',
    usage: { input: 436021, output: 1046, elapsed: '6m 42s' },
  }),
];
runtime.change((state) => {
  state.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
  const session = state.sessions[0]!;
  state.activeSessionId = session.id;
  session.title = 'conversation folding';
  session.todos = [];
  session.queue = [];
  session.attachments = [];
  session.draft = '';
  session.presentation = { scroll: { top: 0, follow: false } };
  state.jobs = [];
  state.agents = [];
  session.messages = messages;
  session.leafId = messages.at(-1)!.id;
  session.branchIds = messages.map((message) => message.id);
  session.hiddenIds = [];
  session.state = 'idle';
  session.fileUndoTurns = ['first', 'second'];
  state.interactions = [];
  state.requests = [];
});
Object.assign(window, {
  foldingFixture: {
    joinCall: () =>
      runtime.change((state) => {
        const session = state.sessions[0]!;
        const after = session.messages.findIndex(
          (row) => row.tool?.input.command === 'git status',
        );
        const row = call('grep', { pattern: 'joined' });
        session.messages.splice(after + 1, 0, row);
        session.branchIds!.splice(after + 1, 0, row.id);
      }),
    work: () =>
      runtime.change((state) => {
        const session = state.sessions[0]!;
        session.state = 'waiting';
        session.turn = {
          startedAt: Date.now(),
          stage: 'working',
        } as unknown as typeof session.turn;
      }),
  },
});
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={[]} />,
);
