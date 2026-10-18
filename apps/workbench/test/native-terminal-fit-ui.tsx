import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { createFixtures } from '../src/preview/fixtures';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
import { connectWorkspaceStreams } from '../src/model/workspace-client';
const options = new URLSearchParams(location.search);
const data = createFixtures();
data.settings.theme = options.get('theme') === 'dark' ? 'dark' : 'light';
data.sessions[0].state = 'idle';
data.interactions = [];
data.requests = [];
data.agents = [];
data.jobs = [];
const runtime = new PreviewRuntime({
  getItem: () => JSON.stringify(data),
  setItem: () => {},
  removeItem: () => {},
});
const listeners = new Set<(event: unknown) => void>();
const stream = new EventSource('/terminal-fit-events');
stream.onmessage = (event) => {
  for (const receive of listeners) receive(JSON.parse(event.data));
};
(window as any).circleDesktop = {
  // Device consoles: none in this fixture.
  onTerminalEvent: () => () => {},
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  setTheme: async () => {},
  browserState: async () => ({ sessionId: 'inactive-fixture' }),
  onWorkspaceEvent: (receive: (event: unknown) => void) => {
    listeners.add(receive);
    return () => listeners.delete(receive);
  },
  runtimeCommand: async (command: unknown) =>
    (
      await fetch('/terminal-fit-command', {
        method: 'POST',
        body: JSON.stringify(command),
      })
    ).json(),
};
connectWorkspaceStreams('terminal-fit-workspace', 'session1');
location.hash = '/session/session1';
applyTheme(data.settings.theme);
setLanguage('en');
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={[]} />,
);
