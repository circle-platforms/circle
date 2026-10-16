import { setTerminalAccessibility } from '../src/terminal-accessibility';
import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { createFixtures } from '../src/preview/fixtures';
import { connectWorkspaceStreams } from '../src/model/workspace-client';
import { setLanguage } from '../src/i18n';
const query = new URLSearchParams(location.search),
  data = createFixtures();
data.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
data.sessions = data.sessions.slice(0, 2).map((session, index) => ({
  ...session,
  id: index ? 'B' : 'A',
  title: index ? 'alternate' : 'terminal tab geometry',
  state: 'idle',
  messages: [],
  draft: index ? 'other draft' : 'preserved parent draft',
  attachments: [],
}));
data.activeSessionId = 'A';
data.interactions = [];
data.requests = [];
data.agents = [];
data.jobs = [];
const runtime = new PreviewRuntime({
  getItem: () => JSON.stringify(data),
  setItem: () => {},
  removeItem: () => {},
});
const workspaceId = data.workspaces[0].id;
const listeners = new Set<(event: unknown) => void>();
let seq = 0;
const writes: Array<{ id: string; data: string }> = [];
let items = Array.from({ length: 9 }, (_, index) => ({
  id: 'terminal-' + (index + 1),
  owner: 'A',
  sessionId: 'A',
  epoch: 'fixture',
  cwd: '/synthetic/workspace',
  shell: 'zsh',
  args: [],
  label: index === 1 ? 'debug' : 'zsh',
  cols: 80,
  rows: 24,
  status: 'running',
  startedAt: new Date(0).toISOString(),
  lastSequence: 0,
  logPath: '/synthetic/log',
  kind: 'shell',
}));
const publish = (item: (typeof items)[number]) => {
  const event = {
    workspaceId,
    sessionId: 'A',
    service: 'terminal',
    resourceId: item.id,
    epoch: 'tab-fixture-journal',
    seq: ++seq,
    at: new Date().toISOString(),
    cursor: { offset: seq, seq },
    data: {
      terminalId: item.id,
      owner: 'A',
      sessionId: 'A',
      epoch: item.epoch,
      sequence: item.lastSequence,
      kind: 'snapshot',
      at: new Date().toISOString(),
      snapshot: item,
    },
  };
  for (const listener of listeners) listener(event);
};
window.circleDesktop = {
  setTheme: async () => {},
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  browserState: async () => ({ sessionId: 'none' }),
  onWorkspaceEvent: (receive: any) => {
    listeners.add(receive);
    return () => listeners.delete(receive);
  },
  runtimeCommand: async (command: any) => {
    const { service, method, params } = command.payload ?? {};
    if (service === 'events')
      return {
        ok: true,
        data: { events: [], cursor: { offset: seq, seq }, hasMore: false },
      };
    if (service !== 'terminal') return { ok: true, data: [] };
    if (method === 'list')
      return {
        ok: true,
        data: command.sessionId === 'A' ? structuredClone(items) : [],
      };
    if (method === 'create') {
      const item = {
        ...items[0],
        id: 'terminal-' + (items.length + 1),
        label: 'zsh',
        lastSequence: 0,
      };
      items = [...items, item];
      return { ok: true, data: item };
    }
    if (method === 'write') writes.push({ id: params.id, data: params.data });
    const item = items.find((item) => item.id === params?.id) ?? items[0];
    if (method === 'close') {
      item.status = 'exited';
      publish(item);
      return { ok: true, data: item };
    }
    if (method === 'replay')
      return {
        ok: true,
        data: {
          snapshot: item,
          events: [],
          nextSequence: item.lastSequence,
          hasMore: false,
        },
      };
    return { ok: true, data: item };
  },
} as unknown as NonNullable<Window['circleDesktop']>;
const accessibilityListeners = new Set<
  (state: { supported: boolean; enabled: boolean; revision: number }) => void
>();
let accessibility = { supported: true, enabled: true, revision: 0 };
if (query.has('accessibility'))
  Object.assign(window.circleDesktop!, {
    nativeAccessibility: async () => accessibility,
    onNativeAccessibility: (
      listener: (state: typeof accessibility) => void,
    ) => {
      accessibilityListeners.add(listener);
      return () => accessibilityListeners.delete(listener);
    },
  });
connectWorkspaceStreams(workspaceId, 'A');
Object.assign(window, {
  terminalTabsFixture: {
    accessibility: (enabled: boolean, supported = true) => {
      accessibility = {
        enabled,
        supported,
        revision: accessibility.revision + 1,
      };
      for (const listener of accessibilityListeners) listener(accessibility);
    },
    accessibilityChoice: setTerminalAccessibility,
    log: () => {
      const item = items.at(-1)!;
      item.lastSequence++;
      item.cwd = '/synthetic/log-update';
      publish(item);
    },
    reorder: () => {
      items = [items.at(-1)!, ...items.slice(0, -1)];
    },
    writes,
    observed: () => ({ ids: items.map((item) => item.id), seq }),
  },
});
setLanguage('en');
location.hash = '/session/A';
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={[]} />,
);
