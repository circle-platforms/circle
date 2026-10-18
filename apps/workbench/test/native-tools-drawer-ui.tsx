import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from 'radix-ui';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime } from '../src/model/state';
import { WorkspacePanelContents } from '../src/features/WorkspacePanelContents';
import { NativeBrowser } from '../src/features/NativeBrowser';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
import '../src/styles/app.css';
import '../src/styles/developer-workbench.css';
import '../src/styles/panes.css';
const query = new URLSearchParams(location.search);
applyTheme(query.get('theme') === 'light' ? 'light' : 'dark');
setLanguage('en');
const runtime = new PreviewRuntime();
// The debug tab belongs to the developer extension; this drawer exercises it.
runtime.change((snapshot) => {
  snapshot.extensions.push({
    id: 'developer',
    name: 'developer',
    version: '0.1.0',
    scope: 'bundled',
    enabled: true,
    tools: [],
    commands: [],
    events: [],
  });
});
const fixture = {
  calls: [] as any[],
  bounds: [] as any[],
  hidden: [] as string[],
  keys: [] as any[],
};
Object.assign(window, { nativeDrawerFixture: fixture });
(window as any).circleDesktop = {
  runtimeCommand: async (command: any) => {
    fixture.calls.push(command);
    return { ok: true, data: { status: 'idle', output: '', breakpoints: {} } };
  },
  onWorkspaceEvent: () => () => {},
  browserState: async (id: string) => ({
    sessionId: `browser:${id}`,
    tab: 'same-tab',
    url: 'https://example.invalid',
    tabs: [
      {
        id: 'same-tab',
        active: true,
        url: 'https://example.invalid',
        title: 'fixture tab',
      },
    ],
  }),
  // Device consoles: none in this fixture.
  onTerminalEvent: () => () => {},
  onBrowserEvent: () => () => {},
  browserBounds: async (...args: any[]) => {
    fixture.bounds.push(args);
  },
  browserHide: async (id: string) => {
    fixture.hidden.push(id);
  },
  browserPage: async (...args: any[]) => {
    fixture.keys.push(args);
  },
};
function Harness() {
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button onClick={() => setVisible((value) => !value)}>
        toggle resource
      </button>
      <aside
        className="inspector work-drawer"
        style={{ width: 420, height: 650 }}
        data-inspector-panel="activity"
      >
        <header className="inspector-title">
          <h2 className="inspector-title-name">activity</h2>
        </header>
        <div className="inspector-body">
          <WorkspacePanelContents
            kind="activity"
            sessionId="session1"
            visible
            selection=""
            onFile={() => {}}
            onSession={() => {}}
            onTask={() => {}}
          >
            <textarea aria-label="resource draft" defaultValue="keep me" />
          </WorkspacePanelContents>
        </div>
      </aside>
      <aside
        className="inspector work-drawer"
        style={{ width: 420, height: 480 }}
        data-inspector-panel="browser"
      >
        <header className="inspector-title">
          <h2 className="inspector-title-name">browser</h2>
        </header>
        <div
          hidden={!visible}
          style={
            visible ? { display: 'flex', flex: 1, minHeight: 0 } : undefined
          }
        >
          <div className="inspector-body flush">
            <NativeBrowser />
          </div>
        </div>
      </aside>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider>
    <RuntimeProvider runtime={runtime}>
      <Harness />
    </RuntimeProvider>
  </Tooltip.Provider>,
);
