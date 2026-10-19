import '../src/styles/app.css';
import { Tooltip } from 'radix-ui';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeProvider } from '../src/app/context';
import { Inspector } from '../src/features/Panels';
import { setLanguage } from '../src/i18n';
import { PreviewRuntime, currentSession } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { PluginProvider } from '../src/plugins/context';
import { applyTheme } from '../src/theme';
import type { DesktopBridge } from '../../desktop/src/contracts';

// The drawer's files mode as the live app has it, registered by the files plugin, behind a
// workspace whose Git says what differs from the last commit. This conversation changed
// nothing: a file changed and a file added outside it, and one deleted.
const query = new URLSearchParams(location.search);
const theme = query.get('theme') === 'dark' ? 'dark' : 'light';
applyTheme(theme);
setLanguage('en');

const calls: { sessionId: string; service: string; method: string }[] = [];
const runtime = new PreviewRuntime();
runtime.change((state) => {
  state.settings.theme = theme;
  const session = currentSession(state);
  session.changes = [];
  state.workspaces.find(
    (workspace) => workspace.id === session.workspaceId,
  )!.origin = 'native';
  state.files = [
    'src/outside.ts',
    'src/fresh.ts',
    'src/plain.ts',
    'docs/guide.md',
    'readme.md',
  ].map((path, index) => ({
    id: `git-marks-${index}`,
    workspaceId: session.workspaceId,
    path,
    content: '',
    language: 'typescript',
  }));
});
Object.defineProperty(runtime, 'mode', { value: 'live' });
window.circleDesktop = {
  runtimeCommand: async (command: {
    name: string;
    sessionId: string;
    payload?: { service?: string; method?: string };
  }) => {
    const { service = '', method = '' } = command.payload ?? {};
    calls.push({ sessionId: command.sessionId, service, method });
    if (
      command.name === 'workspace-service' &&
      service === 'git' &&
      method === 'changes'
    )
      return {
        ok: true,
        data: {
          revision: 'fixture',
          files: [
            { path: 'src/outside.ts', status: 'M', added: 2, removed: 1 },
            { path: 'src/fresh.ts', status: 'A', added: 3, removed: 0 },
            { path: 'gone.ts', status: 'D', added: 0, removed: 4 },
          ],
        },
      };
    return { ok: false, error: `unsupported ${service}.${method}` };
  },
} as unknown as DesktopBridge;

let show: (visible: boolean) => void = () => {};
function Drawer() {
  // As App has it: the files mode is the drawer's first mode, mounted while the drawer
  // is closed, and shown when the drawer opens on it.
  const [visible, setVisible] = useState(false);
  show = setVisible;
  const none = () => {};
  return (
    <Inspector
      panel="files"
      visible={visible}
      selection={{ panel: 'files', value: '' }}
      onPanel={none}
      onClose={none}
      onFile={none}
      onAgentFile={none}
      onAgent={none}
      onInteraction={none}
      onDialog={none}
    />
  );
}
Object.assign(window, {
  filesGitFixture: {
    calls,
    sessionId: currentSession(runtime.getSnapshot()).id,
    show: (visible: boolean) => show(visible),
  },
});
createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider>
    <RuntimeProvider runtime={runtime}>
      <PluginProvider plugins={circlePlugins} services={{}}>
        <div style={{ display: 'flex', width: 420, height: 600 }}>
          <Drawer />
        </div>
      </PluginProvider>
    </RuntimeProvider>
  </Tooltip.Provider>,
);
