// Keys typed in a terminal are the terminal's. A shell and a device console of the
// terminal mode, under a desktop platform the page names (?platform=win32).
import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { setLanguage } from '../src/i18n';
import type {
  DesktopBridge,
  TerminalEvent,
  TerminalState,
} from '../../desktop/src/contracts';
const query = new URLSearchParams(location.search);
document.documentElement.dataset.desktop = query.get('platform') ?? 'win32';
setLanguage('en');
const runtime = new PreviewRuntime();
runtime.change((state) => {
  state.sessions = state.sessions.slice(0, 1).map((session) => ({
    ...session,
    id: 'A',
    title: 'terminal keys',
    attachments: [],
    messages: [],
    state: 'idle',
  }));
  state.activeSessionId = 'A';
});
// What each terminal was sent: the workspace terminal's writes, the console's input.
const written: string[] = [];
const typed: string[] = [];
const taken: string[] = [];
const terminal = {
  id: 'A-terminal',
  owner: 'A',
  sessionId: 'A',
  epoch: 'fixture-epoch',
  cwd: '/synthetic/workspace',
  shell: 'synthetic',
  args: [],
  label: 'fixture terminal',
  pid: 12345,
  cols: 120,
  rows: 24,
  status: 'running',
  startedAt: new Date(0).toISOString(),
  lastSequence: 0,
  logPath: '/synthetic/log',
  kind: 'shell',
};
const consoles: TerminalState = {
  sessionId: 'terminal:A',
  conversation: 'A',
  sessions: [
    {
      id: 'device-1',
      name: 'lab switch',
      target: '192.0.2.10',
      transport: 'telnet',
      state: 'ready',
      detail: '',
      held: 'attach',
      quiet: 0,
      cols: 80,
      rows: 24,
    },
  ],
  profiles: [],
  local: [
    {
      id: 'local:A-terminal',
      terminal: 'A-terminal',
      ordinal: 1,
      state: 'operating',
      allowed: true,
    },
  ],
};
const noop = async () => {};
window.circleDesktop = new Proxy(
  {
    setTheme: noop,
    onWorkspaceEvent: () => () => {},
    onBrowserEvent: () => () => {},
    onTerminalEvent: (_listener: (event: TerminalEvent) => void) => () => {},
    browserState: async () => ({ sessionId: 'none' }),
    terminalState: async () => consoles,
    terminalSnapshot: async () => '',
    terminalInput: async (_session: string, _id: string, data: string) => {
      typed.push(data);
    },
    terminalAttach: async (_session: string, id: string) => {
      taken.push(id);
    },
    runtimeCommand: async (command: any) => {
      if (command.name !== 'workspace-service') return { ok: true };
      const { service, method, params } = command.payload;
      if (service !== 'terminal') throw Error('unexpected service ' + service);
      if (method === 'list') return { ok: true, data: [terminal] };
      if (method === 'write') {
        written.push(params.data);
        return { ok: true };
      }
      if (method === 'resize') return { ok: true };
      if (method === 'replay')
        return {
          ok: true,
          data: {
            snapshot: terminal,
            nextSequence: 0,
            events: [],
            hasMore: false,
          },
        };
      throw Error('unexpected terminal operation ' + method);
    },
  },
  {
    get: (target, key) =>
      key in target
        ? (target as any)[key]
        : key.toString().startsWith('on')
          ? () => () => {}
          : noop,
  },
) as unknown as DesktopBridge;
(window as any).__terminalKeys = { written, typed, taken };
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
