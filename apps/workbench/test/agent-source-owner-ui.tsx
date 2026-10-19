import '../src/styles/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from 'radix-ui';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime, currentSession } from '../src/model/state';
import { FileViewer } from '../src/features/FileViewer';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
import type { DesktopBridge } from '../../desktop/src/contracts';
setLanguage('en');
applyTheme('dark');
window.circleDesktop = {
  runtimeCommand: async (command) => {
    const response = await fetch('/__owner', {
      method: 'POST',
      body: JSON.stringify(command),
    });
    return response.json();
  },
  onWorkspaceEvent: (listener) => {
    const events = new EventSource('/__owner_events');
    events.onmessage = (event) => listener(JSON.parse(event.data));
    return () => events.close();
  },
} as DesktopBridge;
const runtime = new PreviewRuntime();
runtime.change((snapshot) => {
  snapshot.files = [
    {
      id: 'parent-main',
      path: 'main.ts',
      workspaceId: currentSession(snapshot).workspaceId,
      language: 'typescript',
      content: 'PARENT projection must not appear',
    },
  ];
});
Object.defineProperty(runtime, 'mode', { value: 'live' });
function Fixture() {
  const [source, setSource] = useState<{
    path: string;
    line?: number;
    column?: number;
  }>({ path: 'main.ts' });
  const [readOnly, setReadOnly] = useState(false);
  return (
    <Tooltip.Provider>
      <RuntimeProvider runtime={runtime}>
        <button
          onClick={() => fetch('/__owner?external=child', { method: 'POST' })}
        >
          external child
        </button>
        <button
          onClick={() => fetch('/__owner?external=parent', { method: 'POST' })}
        >
          external parent
        </button>
        <button onClick={() => setReadOnly(true)}>read only</button>
        <button onClick={() => setSource({ path: 'plan.md' })}>
          open plan
        </button>
        <div style={{ height: 650, display: 'flex' }}>
          <FileViewer
            path={source.path}
            line={source.line}
            column={source.column}
            onNavigate={(path, line, column) =>
              setSource({ path, line, column })
            }
            resourceOwner={{
              sessionId: 'child-session',
              workspaceId: 'child-workspace',
              readOnly,
            }}
            onClose={() => {}}
          />
        </div>
      </RuntimeProvider>
    </Tooltip.Provider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
