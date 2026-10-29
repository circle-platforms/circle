import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { createFixtures } from '../src/preview/fixtures';
import { connectWorkspaceStreams } from '../src/model/workspace-client';
import { setLanguage } from '../src/i18n';

// Three shells of one conversation in the terminal mode, behind a desktop that answers a
// rename, a new shell and a restart as the main process does, refuses a name it would
// refuse, and keeps the row's order for every window: an order it is given comes back in
// the state it sends. As the main process does, it announces a new shell before it
// answers the request, and the test can hold that answer back. Each shell has printed
// one line that names it, which "copy complete output" copies.
const query = new URLSearchParams(location.search);
const data = createFixtures();
data.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
data.sessions = data.sessions.slice(0, 1).map((session) => ({
  ...session,
  id: 'A',
  title: 'tab menu',
  state: 'idle',
  messages: [],
  draft: '',
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
const terminalListeners = new Set<(event: unknown) => void>();
let seq = 0;
const calls: { method: string; params: unknown }[] = [];
let order: string[] | undefined;
type Shell = Record<string, unknown> & { id: string };
const shell = (n: number): Shell => ({
  id: `term-${n}`,
  owner: 'A',
  sessionId: 'A',
  epoch: 'fixture',
  cwd: '/synthetic/workspace',
  shell: 'zsh',
  pid: 42000 + n,
  args: [],
  label: 'zsh',
  cols: 80,
  rows: 24,
  status: 'running',
  startedAt: new Date(n * 1000).toISOString(),
  lastSequence: 1,
  logPath: '/synthetic/log',
  kind: 'shell',
  tabNumber: n,
});
let items: Shell[] = [shell(1), shell(2), shell(3)];
const copied: string[] = [];
// The answer to a create or a restart the test holds back, after the shell is announced.
let holding = false;
let held: { method: string; release: () => void } | undefined;
const answer = async (method: string, data: unknown) => {
  if (holding) {
    holding = false;
    await new Promise<void>((release) => {
      held = { method, release };
    });
    held = undefined;
  }
  return { ok: true, data };
};
const publish = (item: Shell) => {
  const event = {
    workspaceId,
    sessionId: 'A',
    service: 'terminal',
    resourceId: item.id,
    epoch: 'tab-menu-journal',
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
const state = () => ({
  sessionId: 'terminal:A',
  conversation: 'A',
  sessions: [],
  profiles: [],
  ...(order ? { order: [...order] } : {}),
});
const tell = () => {
  for (const listener of terminalListeners)
    listener({ kind: 'state', state: state() });
};
window.circleDesktop = {
  setTheme: async () => {},
  onTerminalEvent: (listener: (event: unknown) => void) => {
    terminalListeners.add(listener);
    return () => terminalListeners.delete(listener);
  },
  terminalState: async () => state(),
  terminalArrange: async (_sessionId: string, next: string[]) => {
    calls.push({ method: 'arrange', params: next });
    order = [...next];
    tell();
    return state();
  },
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  browserState: async () => ({ sessionId: 'none' }),
  onWorkspaceEvent: (receive: (event: unknown) => void) => {
    listeners.add(receive);
    return () => listeners.delete(receive);
  },
  copyText: async (text: string) => {
    copied.push(text);
  },
  runtimeCommand: async (command: {
    payload?: { service?: string; method?: string; params?: any };
  }) => {
    const { service, method, params } = command.payload ?? {};
    if (service === 'events')
      return {
        ok: true,
        data: { events: [], cursor: { offset: seq, seq }, hasMore: false },
      };
    if (service !== 'terminal') return { ok: true, data: [] };
    if (method !== 'list' && method !== 'replay' && method !== 'resize')
      calls.push({ method: method!, params });
    if (method === 'list') return { ok: true, data: structuredClone(items) };
    if (method === 'create') {
      // The lowest number no open tab is using, as the main process gives a new shell
      const used = new Set(
        items.filter((one) => !one.hidden).map((one) => one.tabNumber),
      );
      let number = 1;
      while (used.has(number)) number++;
      const next: Shell = { ...shell(items.length + 1), tabNumber: number };
      items = [...items, next];
      publish(next);
      return answer('create', structuredClone(next));
    }
    const item = items.find((one) => one.id === params?.id);
    if (method === 'replay')
      return {
        ok: true,
        data: {
          snapshot: item,
          events:
            item && params.afterSequence < 1
              ? [
                  {
                    terminalId: item.id,
                    owner: 'A',
                    sessionId: 'A',
                    epoch: item.epoch,
                    sequence: 1,
                    kind: 'data',
                    at: new Date().toISOString(),
                    data: `output of ${item.id}\r\n`,
                  },
                ]
              : [],
          nextSequence: 1,
          hasMore: false,
        },
      };
    if (!item) return { ok: true, data: {} };
    if (method === 'rename') {
      const label = String(params.label ?? '').trim();
      if (!label) return { ok: false, error: 'the terminal name is empty' };
      if (/[\u0000-\u001f\u007f-\u009f]/.test(label))
        return {
          ok: false,
          error: 'the terminal name cannot hold tabs or control characters',
        };
      Object.assign(item, { label, named: true });
      publish(item);
      return { ok: true, data: structuredClone(item) };
    }
    if (method === 'restart') {
      const next: Shell = {
        ...shell(items.length + 1),
        label: item.label,
        ...(item.named ? { named: true } : {}),
        tabNumber: item.tabNumber,
        restartOf: item.id,
      };
      Object.assign(item, { status: 'exited', hidden: true });
      delete item.tabNumber;
      items = [...items, next];
      publish(next);
      publish(item);
      return answer('restart', structuredClone(next));
    }
    if (method === 'close') {
      item.status = 'exited';
      publish(item);
      return { ok: true, data: structuredClone(item) };
    }
    if (method === 'hide') {
      item.hidden = true;
      delete item.tabNumber;
      publish(item);
      return { ok: true, data: structuredClone(item) };
    }
    return { ok: true, data: structuredClone(item) };
  },
} as unknown as NonNullable<Window['circleDesktop']>;
connectWorkspaceStreams(workspaceId, 'A');
Object.assign(window, {
  tabMenuFixture: {
    calls,
    copied,
    // Another window of the conversation dragged the row: the main process says so
    arrangedElsewhere: (next: string[]) => {
      order = [...next];
      tell();
    },
    // The next create or restart announces its shell and then waits to answer
    hold: () => {
      holding = true;
    },
    held: () => held?.method ?? '',
    release: () => held?.release(),
  },
});
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
location.hash = '/session/A';
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={[]} />,
);
