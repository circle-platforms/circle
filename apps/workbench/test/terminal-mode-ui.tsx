import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { createFixtures } from '../src/preview/fixtures';
import { connectWorkspaceStreams } from '../src/model/workspace-client';
import { setLanguage } from '../src/i18n';

// A conversation with two shells, a command Circle runs, and two device consoles, behind a
// fake desktop host that records what the interface asks of it.
const query = new URLSearchParams(location.search),
  data = createFixtures();
data.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
data.sessions = data.sessions.slice(0, 1).map((session) => ({
  ...session,
  id: 'A',
  title: 'terminal row',
  state: 'idle',
  messages: [],
  attachments: [],
}));
data.activeSessionId = 'A';
// Circle's first command in terminal 1 waits for an answer, as the runtime words it.
data.interactions = [
  {
    id: 'approval-tab',
    sessionId: 'A',
    kind: 'approval',
    title: 'terminal_send needs your permission',
    tool: 'terminal_send',
    command: 'npm run test -- reconnect',
    reason: 'runs a shell command',
    input: {
      session: 'local:terminal-1',
      terminal: 'local:terminal-1',
      ordinal: 1,
      first_use: true,
    },
    choices: ['approve', 'always', 'reject'],
    status: 'pending',
    revision: 1,
  },
];
data.requests = [];
data.agents = [];
// The command Circle runs in the background has a job, and the job names its terminal.
data.jobs = [
  {
    id: 'A:job-1',
    sessionId: 'A',
    kind: 'command',
    title: 'npm run test -- reconnect',
    state: 'running',
    elapsed: '14s',
    output: '',
    outputPath: 'preview/background_jobs/j1.log',
    stopRequested: false,
    terminal: { id: 'terminal-3', epoch: 'fixture' },
  },
];
const runtime = new PreviewRuntime({
  getItem: () => JSON.stringify(data),
  setItem: () => {},
  removeItem: () => {},
});
const workspaceId = data.workspaces[0].id;
const listeners = new Set<(event: unknown) => void>();
const terminalListeners = new Set<(event: unknown) => void>();
let seq = 0;
const calls: Array<{ call: string; args: unknown[] }> = [];
const record = (call: string, ...args: unknown[]) => calls.push({ call, args });

const shell = (n: number) => ({
  id: `terminal-${n}`,
  owner: 'A',
  sessionId: 'A',
  epoch: 'fixture',
  cwd: '/synthetic/orbit-api',
  shell: 'zsh',
  pid: 41000 + n,
  args: [],
  label: 'zsh',
  cols: 80,
  rows: 24,
  status: 'running',
  startedAt: new Date(n * 1000).toISOString(),
  lastSequence: 0,
  logPath: '/synthetic/log',
  kind: 'shell',
  // The main process stores each shell's tab number as it makes it
  tabNumber: n as number | undefined,
});
let items: any[] = [
  shell(1),
  shell(2),
  {
    ...shell(3),
    label: 'command',
    tabNumber: undefined,
    startedAt: new Date(3000).toISOString(),
    managedCommand: {
      executionId: 'exec-1',
      executionEpoch: 'fixture-run',
      toolCallId: 'call-1',
      displayCommand: 'npm run test -- reconnect',
      ownership: 'pty-group',
      commandPid: 52003,
      completion: {
        kind: 'pty-group',
        descendantCoverage: {
          state: 'unknown',
          reason: 'coverage-unavailable',
          observedAt: 1,
        },
      },
    },
  },
  // A command Circle runs in the foreground: it has a terminal, and no tab.
  {
    ...shell(4),
    label: 'command',
    tabNumber: undefined,
    startedAt: new Date(4000).toISOString(),
    managedCommand: {
      executionId: 'exec-2',
      executionEpoch: 'fixture-run',
      toolCallId: 'call-2',
      displayCommand: 'ls -la',
      ownership: 'pty-group',
      commandPid: 52004,
      completion: {
        kind: 'pty-group',
        descendantCoverage: {
          state: 'unknown',
          reason: 'coverage-unavailable',
          observedAt: 1,
        },
      },
    },
  },
];
const publish = (item: any) => {
  const event = {
    workspaceId,
    sessionId: 'A',
    service: 'terminal',
    resourceId: item.id,
    epoch: 'terminal-mode-journal',
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

let devices: any[] = [
  {
    id: 't1',
    name: 'core-switch',
    target: '10.0.0.1:22',
    transport: 'ssh',
    state: 'ready',
    detail: '',
    held: '',
    quiet: 4000,
    // opened after terminal 2 and before the command below
    startedAt: 2500,
    cols: 80,
    rows: 24,
  },
  {
    id: 't2',
    name: 'rack-pdu',
    target: '10.0.0.20:23',
    transport: 'telnet',
    state: 'ready',
    detail: '',
    held: '',
    quiet: 100,
    // the last thing that came to be
    startedAt: 3500,
    cols: 80,
    rows: 24,
  },
];
const profiles = [
  {
    name: 'core-switch',
    transport: 'ssh',
    target: '10.0.0.1:22',
    user: 'admin',
  },
  {
    name: 'edge-router',
    transport: 'ssh',
    target: '10.0.1.1:22',
    user: 'admin',
  },
];
// What Circle is doing in each shell of yours, as the runtime tells the window.
let local: any[] = [1, 2].map((n) => ({
  id: `local:terminal-${n}`,
  terminal: `terminal-${n}`,
  ordinal: n,
  state: 'idle',
  allowed: false,
}));
let asking: null | {
  token: string;
  host: string;
  keyType: string;
  fingerprint: string;
  privateHost: boolean;
} = null;
const state = () => ({
  sessionId: 'terminal:A',
  conversation: 'A',
  sessions: devices,
  profiles,
  local,
  ...(asking ? { pendingKey: asking } : {}),
});
const pushState = () => {
  for (const listener of terminalListeners)
    listener({ kind: 'state', state: state() });
};
const text = (value: string) => btoa(value);

window.circleDesktop = {
  setTheme: async () => {},
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  browserState: async () => ({ sessionId: 'none' }),
  onTerminalEvent: (receive: any) => {
    terminalListeners.add(receive);
    return () => terminalListeners.delete(receive);
  },
  terminalState: async () => state(),
  terminalSnapshot: async (_: string, id: string) =>
    text(`${id} $ show interfaces\r\nGi1/0/24 notconnect\r\n`),
  terminalConnect: async (_: string, name: string) => {
    record('terminalConnect', name);
    return state();
  },
  terminalConnectTarget: async (_: string, target: any) => {
    record('terminalConnectTarget', target);
    if (target.host === 'unreachable.invalid')
      throw new Error('could not reach unreachable.invalid');
    // A device nobody has a key for: the login stops and the panel is asked.
    if (target.host === 'newkey.invalid' || target.host === 'refused.invalid') {
      asking = {
        token: 'fixture-token',
        host: `${target.host}:${target.port ?? 22}`,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:fixture',
        privateHost: true,
      };
      pushState();
      return state();
    }
    devices = [
      ...devices,
      {
        id: 't3',
        name: target.host,
        target: `${target.host}:${target.port ?? 22}`,
        transport: target.transport,
        state: 'ready',
        detail: '',
        held: '',
        quiet: 10,
        cols: 80,
        rows: 24,
      },
    ];
    pushState();
    return state();
  },
  terminalAttach: async (_: string, id: string) => {
    record('terminalAttach', id);
    devices = devices.map((row) =>
      row.id === id ? { ...row, held: 'attach' } : row,
    );
    local = local.map((row) =>
      row.id === id ? { ...row, state: 'held', held: 'attach' } : row,
    );
    pushState();
    return state();
  },
  terminalDetach: async (_: string, id: string) => {
    record('terminalDetach', id);
    devices = devices.map((row) =>
      row.id === id ? { ...row, held: '' } : row,
    );
    local = local.map((row) =>
      row.id === id
        ? { ...row, state: 'idle', held: undefined, reason: undefined }
        : row,
    );
    pushState();
    return state();
  },
  terminalStop: async (_: string, id: string) => {
    record('terminalStop', id);
    local = local.map((row) =>
      row.id === id ? { ...row, state: 'idle' } : row,
    );
    pushState();
    return state();
  },
  terminalDisconnect: async (_: string, id: string) => {
    record('terminalDisconnect', id);
    devices = devices.filter((row) => row.id !== id);
    pushState();
    return state();
  },
  // The answer either opens the console it was waiting for, or says why it did
  // not: a button that changes nothing is the one fault nobody can see.
  terminalHostKey: async (_: string, decision: string) => {
    record('terminalHostKey', decision);
    if (!asking)
      throw new Error(
        'that device key question is no longer open; connect again to see it',
      );
    if (asking.host.startsWith('refused.'))
      throw new Error(`could not sign in to ${asking.host}`);
    asking = null;
    devices = [
      ...devices,
      {
        id: 't4',
        name: 'newkey.invalid',
        target: 'newkey.invalid:22',
        transport: 'ssh',
        state: 'ready',
        detail: '',
        held: 'attach',
        quiet: 10,
        cols: 80,
        rows: 24,
        startedAt: 9000,
      },
    ];
    pushState();
    return { ...state(), opened: 't4' };
  },
  terminalInput: async (_: string, id: string, data: string) => {
    record('terminalInput', id, data);
  },
  terminalResize: async () => {},
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
    record(`terminal.${method}`, params);
    if (method === 'list')
      return {
        ok: true,
        data: command.sessionId === 'A' ? structuredClone(items) : [],
      };
    if (method === 'create') {
      // The lowest number no open shell's tab is using
      const used = new Set(
        items
          .filter((one) => !one.hidden && !one.managedCommand)
          .map((one) => one.tabNumber),
      );
      let number = 1;
      while (used.has(number)) number++;
      const item = { ...shell(items.length + 1), tabNumber: number };
      items = [...items, item];
      return { ok: true, data: item };
    }
    const item = items.find((one) => one.id === params?.id) ?? items[0];
    if (method === 'close' || method === 'signal') {
      if (method === 'close') item.status = 'exited';
      publish(item);
      return { ok: true, data: item };
    }
    // A closed tab leaves the row and gives its number back
    if (method === 'hide') {
      item.hidden = true;
      delete item.tabNumber;
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
connectWorkspaceStreams(workspaceId, 'A');
Object.assign(window, {
  terminalModeFixture: {
    calls,
    /** What Circle is doing in one of your shells changes, as the runtime tells it. */
    circle: (n: number, patch: Record<string, unknown>) => {
      local = local.map((row) =>
        row.ordinal === n ? { ...row, ...patch } : row,
      );
      pushState();
    },
    /**
     * A terminal tool the conversation is running or asking about, before the
     * runtime's row has said so. An empty status clears it.
     */
    working: (status: 'running' | 'waiting' | '') => {
      runtime.change((draft) => {
        const session = draft.sessions.find((item) => item.id === 'A');
        if (!session) return;
        session.messages = status
          ? [
              {
                id: 'tool-wait',
                parentId: null,
                role: 'tool',
                text: '',
                at: '2026-10-20T00:00:00.000Z',
                tool: {
                  id: 'call-wait',
                  name: 'terminal_wait',
                  input: { session: 'local:terminal-1' },
                  output: '',
                  status,
                },
              },
            ]
          : [];
      });
    },
    /** The running command ends, with an exit code. */
    endCommand: (exitCode: number) => {
      const item = items.find((one) => one.id === 'terminal-3')!;
      Object.assign(item, {
        status: 'exited',
        exitCode,
        managedCommand: {
          ...item.managedCommand,
          completion: {
            ...item.managedCommand.completion,
            rootExit: { exitCode },
          },
        },
      });
      publish(item);
    },
  },
});
setLanguage(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en');
location.hash = '/session/A';
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={[]} />,
);
