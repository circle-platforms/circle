import '../src/styles/app.css';
import { createRoot } from 'react-dom/client';
import { Tooltip } from 'radix-ui';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime, currentSession } from '../src/model/state';
import { FileViewer } from '../src/features/FileViewer';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
const query = new URLSearchParams(location.search);
const language = query.get('lang') === 'zh-CN' ? 'zh-CN' : 'en';
const theme = query.get('theme') === 'light' ? 'light' : 'dark';
const child = query.get('source') === 'child';
const readOnly = query.get('readonly') === 'true';
const runtime = new PreviewRuntime();
runtime.change((snapshot) => {
  const session = currentSession(snapshot);
  session.readOnly = readOnly;
  const parent = snapshot.workspaces.find(
    (row) => row.id === session.workspaceId,
  )!;
  parent.name = 'parent-project';
  parent.path = '/isolated/parent-project';
  snapshot.workspaces.push({
    ...parent,
    id: 'child-workspace',
    name: 'a0b1c2d3e4f5678901234567-2',
    path: '/isolated/task-worktrees/a0b1c2d3e4f5678901234567-2',
  });
  const agent = snapshot.agents[0];
  Object.assign(agent, {
    id: 'child-session',
    sessionId: session.id,
    resourceSessionId: 'child-session',
    workspaceId: 'child-workspace',
    readOnly,
    name: '实现登录表单与验证 · Login agent',
  });
  snapshot.files = [
    {
      id: 'parent-main',
      path: 'README.md',
      workspaceId: parent.id,
      language: 'markdown',
      content: 'PARENT SAME NAME',
    },
    {
      id: 'child-main',
      path: 'README.md',
      workspaceId: 'child-workspace',
      language: 'markdown',
      content: 'CHILD SAME NAME',
    },
  ];
});
// Apply the requested screenshot identity after creating the preview data.
// The fixture does not mount App's settings/theme effects.
setLanguage(language);
applyTheme(theme);
createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider delayDuration={0}>
    <RuntimeProvider runtime={runtime}>
      <div style={{ height: '100vh', display: 'flex', width: '100%' }}>
        <FileViewer
          path="README.md"
          onClose={() => {}}
          resourceOwner={
            child
              ? {
                  sessionId: 'child-session',
                  workspaceId: 'child-workspace',
                  readOnly,
                }
              : undefined
          }
        />
      </div>
    </RuntimeProvider>
  </Tooltip.Provider>,
);
