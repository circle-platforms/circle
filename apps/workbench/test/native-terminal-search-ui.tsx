import { Tooltip } from 'radix-ui';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { NativeTerminal } from '../src/components/NativeTerminal';
import { TerminalMode } from '../src/features/TerminalMode';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime } from '../src/model/state';
import { createFixtures } from '../src/preview/fixtures';
import { applyTheme } from '../src/theme';
import '../src/styles/app.css';
import '../src/styles/workbench-unified.css';
import '../src/styles/developer-workbench.css';
import '../src/styles/panes.css';
const options = new URLSearchParams(location.search);
const embedded = options.get('embedded') === 'true';
const late = options.get('late') === 'true';
applyTheme(options.get('theme') === 'dark' ? 'dark' : 'light');
(window as any).__terminalTimings = [];
if (options.get('timing') !== 'off')
  (window as any).__circleNativeTerminalTiming = (record: unknown) => {
    (window as any).__terminalTimings.push(record);
    if (options.get('timing') === 'throw')
      throw Error('synthetic timing observer failure');
  };
const lines = Array.from(
  { length: 600 },
  (_, i) => `CIRCLE_TERMINAL_LINE_${String(i + 1).padStart(4, '0')}_中文`,
);
let release!: () => void;
const blocked = new Promise<void>((resolve) => {
  release = resolve;
});
let ready = false,
  requests = 0,
  copied = '';
const snapshot = (sessionId: string) => ({
  id: sessionId + '-terminal',
  owner: sessionId,
  sessionId,
  epoch: 'fixture',
  cwd: '/fixture',
  shell: 'synthetic',
  args: [],
  label: 'fixture terminal',
  cols: 120,
  rows: 24,
  status: options.get('error')
    ? 'failed'
    : options.get('status') === 'exited'
      ? 'exited'
      : 'running',
  ...(options.get('status') === 'exited' || options.get('error')
    ? { exitCode: 1, exitReason: options.get('reason') ?? '' }
    : {}),
  ...(options.get('error') ? { error: options.get('error') } : {}),
  startedAt: new Date(0).toISOString(),
  lastSequence: late ? (ready ? 2 : 0) : 1,
  logPath: '/fixture/log',
  kind: 'shell',
});
// The terminal reads the conversation, its jobs and its folder from the runtime.
const data = createFixtures();
data.sessions = data.sessions.slice(0, 2).map((session, index) => ({
  ...session,
  id: index ? 'B' : 'A',
  state: 'idle',
}));
data.activeSessionId = 'A';
data.jobs = [];
const runtime = new PreviewRuntime({
  getItem: () => JSON.stringify(data),
  setItem: () => {},
  removeItem: () => {},
});
(window as any).circleDesktop = {
  copyText: async (text: string) => {
    copied = text;
  },
  onWorkspaceEvent: () => () => {},
  // Device consoles: none in this fixture.
  onTerminalEvent: () => () => {},
  terminalState: async (sessionId: string) => ({
    sessionId: 'terminal:' + sessionId,
    conversation: sessionId,
    sessions: [],
    profiles: [],
  }),
  runtimeCommand: async (command: any) => {
    const { method, params } = command.payload;
    const item = snapshot(command.sessionId);
    if (method === 'list') return { ok: true, data: [item] };
    if (method === 'resize' || method === 'write') return { ok: true };
    if (method === 'replay') {
      requests++;
      if (!ready && !late) await blocked;
      const sequence = late ? (ready ? 2 : 0) : 1;
      const parts = late
        ? [
            '\u001b[32m' + lines[0].slice(0, -2),
            lines[0].slice(-2) +
              '\u001b[0m\r\n' +
              lines.slice(1).join('\r\n') +
              '\r\n',
          ]
        : [lines.join('\r\n') + '\r\n'];
      const events = parts
        .slice(0, sequence)
        .map((data, index) => ({
          terminalId: item.id,
          owner: item.owner,
          sessionId: item.sessionId,
          epoch: item.epoch,
          sequence: index + 1,
          kind: 'data',
          at: new Date(0).toISOString(),
          data,
        }))
        .filter((event) => event.sequence > params.afterSequence)
        .slice(0, params.limit ?? 128);
      const nextSequence = events.at(-1)?.sequence ?? params.afterSequence;
      return {
        ok: true,
        data: {
          snapshot: snapshot(command.sessionId),
          nextSequence,
          events,
          hasMore: nextSequence < sequence,
        },
      };
    }
    throw Error('unexpected fixture operation ' + method);
  },
};
function Fixture() {
  const [session, setSession] = useState('A');
  const [mounted, setMounted] = useState(true);
  const [open, setOpen] = useState(false);
  (window as any).__terminalFixture = {
    release: () => {
      ready = true;
      release();
    },
    requests: () => requests,
    copied: () => copied,
    lines,
    switchSession: () => setSession('B'),
    unmount: () => setMounted(false),
    remount: () => setMounted(true),
  };
  // Embedded, the terminal is the drawer's terminal mode: the top bar's button opens it
  // and a second press closes it, and the mode stays mounted while it is closed.
  if (embedded)
    return (
      <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
        <button
          aria-label="terminal panel"
          aria-pressed={open}
          onClick={() => setOpen(!open)}
        >
          terminal panel
        </button>
        <div
          className="inspector-resource-host"
          hidden={!open}
          style={{ flex: 1, minHeight: 0, display: open ? 'flex' : 'none' }}
        >
          <aside className="inspector work-drawer" style={{ flex: 1 }}>
            <div className="inspector-body flush">
              <div
                className="inspector-resource-view"
                data-inspector-resource="terminal"
              >
                {mounted && <TerminalMode sessionId={session} visible={open} />}
              </div>
            </div>
          </aside>
        </div>
      </div>
    );
  return (
    <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
      {mounted && <NativeTerminal sessionId={session} />}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider runtime={runtime}>
    <Tooltip.Provider>
      <Fixture />
    </Tooltip.Provider>
  </RuntimeProvider>,
);
