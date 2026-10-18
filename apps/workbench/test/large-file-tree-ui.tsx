import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { setLanguage } from '../src/i18n';
const query = new URLSearchParams(location.search);
setLanguage('en');
const runtime = new PreviewRuntime();
runtime.change((state) => {
  state.settings.theme = query.get('theme') === 'light' ? 'light' : 'dark';
  const first = state.sessions[0]!;
  first.id = 'large-tree-session-a';
  first.draft = 'large tree retained draft';
  first.messages = [
    {
      id: 'large-tree-answer',
      parentId: null,
      role: 'assistant',
      text: 'Inspect the synthetic repository without model requests.',
      at: '2026-10-19T00:00:00Z',
    },
  ];
  first.leafId = 'large-tree-answer';
  first.branchIds = ['large-tree-answer'];
  first.todos = [];
  first.queue = [];
  first.state = 'idle';
  first.turn = undefined;
  state.sessions = [
    first,
    {
      ...structuredClone(first),
      id: 'large-tree-session-b',
      draft: 'second owner draft',
    },
  ];
  state.activeSessionId = first.id;
  state.files = Array.from({ length: 11000 }, (_, index) => ({
    id: `large-file-${index}`,
    workspaceId: first.workspaceId,
    path: `bulk/item-${String(index).padStart(5, '0')}.ts`,
    content: `export const item${index} = ${index};\n`,
    language: 'typescript',
  }));
  state.files.push({
    id: 'deep-source',
    workspaceId: first.workspaceId,
    path: 'deep/nested/source.ts',
    content: 'export const deepSource = true;\n',
    language: 'typescript',
  });
  state.agents = [];
  state.jobs = [];
  state.interactions = [];
  state.requests = [];
});
Object.assign(window, { largeTreeFixture: { runtime, count: 11001 } });
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
