import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { LiveRuntime } from '../src/model/live';
import { circlePlugins } from '../src/plugins/builtins';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
import type { DesktopBridge } from '../../desktop/src/contracts';
import type { RuntimeUpdate } from '../../desktop/src/runtime-protocol';
import type { WorkspaceServiceEvent } from '../../desktop/src/workspace-protocol';
const runtimeListeners = new Set<(update: RuntimeUpdate) => void>();
const workspaceListeners = new Set<(event: WorkspaceServiceEvent) => void>();
const stream = new EventSource('/__command_events');
stream.onmessage = (event) => {
  const item = JSON.parse(event.data);
  if (item.kind === 'runtime')
    for (const receive of runtimeListeners) receive(item.value);
  if (item.kind === 'workspace')
    for (const receive of workspaceListeners) receive(item.value);
};
const host = {
  setTheme: async () => {},
  setLanguage: async () => {},
  // Device consoles: none in this fixture.
  onTerminalEvent: () => () => {},
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  browserState: async () => ({ sessionId: 'none' }),
  runtimeState: async () => (await fetch('/__command_state')).json(),
  runtimeCommand: async (command: unknown) =>
    (
      await fetch('/__command_dispatch', {
        method: 'POST',
        body: JSON.stringify(command),
      })
    ).json(),
  onRuntime: (receive: (update: RuntimeUpdate) => void) => {
    runtimeListeners.add(receive);
    return () => runtimeListeners.delete(receive);
  },
  onWorkspaceEvent: (receive: (event: WorkspaceServiceEvent) => void) => {
    workspaceListeners.add(receive);
    return () => workspaceListeners.delete(receive);
  },
} as unknown as DesktopBridge;
window.circleDesktop = host;
const runtime = new LiveRuntime(host, await host.runtimeState(), localStorage);
Object.assign(window, { commandTerminalRuntime: runtime });
setLanguage('en');
applyTheme(
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light',
);
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
