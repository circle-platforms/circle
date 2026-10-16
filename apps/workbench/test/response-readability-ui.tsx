import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { setLanguage } from '../src/i18n';
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
// Representative renderer content preserved from the real-model native review;
// this fixture tests presentation and navigation, never model correctness.
const text = `浏览器验收完成，全部基于内嵌浏览器快照的实际观察：

| 步骤 | 工具观察（快照原文） | 结果 |
| --- | --- | --- |
| 添加 Plan、Build | 输入提交两次 → "Task added."，摘要 \`2 total · 0 completed\` | ✔ |
| 勾选完成 Build | \`checkbox "Complete Build" checked\`，摘要 \`2 total · 1 completed\` | ✔ |
| Completed 视图 | 仅 Build (checked)，\`Showing completed tasks.\` | ✔ |
| Clear completed | 当前停在 Completed 视图 → \`No tasks in this view.\`，摘要 \`1 total · 0 completed\` | ✔ |

来源：[public/task-model.mjs:2](public/task-model.mjs:2)。
`;
const thinking =
  "With this, I've grasped the overall picture. I'll present a concise plan and the current failure points, without modifying the project. 完整思考内容保持原文。";
const runtime = new PreviewRuntime();
runtime.change((state) => {
  state.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
  const session = state.sessions[0]!;
  state.sessions = [session];
  state.activeSessionId = session.id;
  session.messages = [
    {
      id: 'response-readability',
      parentId: null,
      role: 'assistant',
      text,
      thinking,
      at: '2026-10-16T00:00:00Z',
    },
  ];
  session.leafId = 'response-readability';
  session.branchIds = ['response-readability'];
  session.state = 'idle';
  session.showThinking = true;
  session.todos = [];
  session.draft = '';
  state.agents = [];
  state.jobs = [];
  state.interactions = [];
  state.requests = [];
  state.files.push({
    id: 'representative-source',
    workspaceId: session.workspaceId,
    path: 'public/task-model.mjs',
    content:
      'export function visibleTasks(tasks, mode) {\n  return tasks.filter(task => !task.completed);\n}',
    language: 'javascript',
  });
});
const copied: string[] = [];
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (value: string) => {
      copied.push(value);
    },
  },
});
Object.assign(window, {
  readabilityFixture: { runtime, text, thinking, copied },
});
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
