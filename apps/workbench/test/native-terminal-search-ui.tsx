import { Tooltip } from 'radix-ui';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { NativeTerminal } from '../src/components/NativeTerminal';
import { applyTheme } from '../src/theme';
import '../src/styles/app.css';
const options = new URLSearchParams(location.search);
const embedded = options.get('embedded') === 'true';
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
  status: 'running',
  startedAt: new Date(0).toISOString(),
  lastSequence: 1,
  logPath: '/fixture/log',
  kind: 'shell',
});
(window as any).circleDesktop = {
  copyText: async (text: string) => {
    copied = text;
  },
  onWorkspaceEvent: () => () => {},
  runtimeCommand: async (command: any) => {
    const { method, params } = command.payload;
    const item = snapshot(command.sessionId);
    if (method === 'list') return { ok: true, data: [item] };
    if (method === 'resize' || method === 'write') return { ok: true };
    if (method === 'replay') {
      requests++;
      if (!ready) await blocked;
      return {
        ok: true,
        data: {
          snapshot: item,
          nextSequence: 1,
          events:
            params.afterSequence < 1
              ? [
                  {
                    terminalId: item.id,
                    owner: item.owner,
                    sessionId: item.sessionId,
                    epoch: item.epoch,
                    sequence: 1,
                    kind: 'data',
                    at: new Date(0).toISOString(),
                    data: lines.join('\r\n') + '\r\n',
                  },
                ]
              : [],
          hasMore: false,
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
  const [tab, setTab] = useState('history');
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
  };
  return (
    <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
      {embedded && (
        <>
          <button
            aria-label="terminal panel"
            aria-pressed={open}
            onClick={() => setOpen(!open)}
          >
            terminal panel
          </button>
          <div role="tablist" aria-label="terminal sections">
            {['terminal', 'history'].map((item) => (
              <button
                key={item}
                id={`inspector-terminal-tab-${item}`}
                role="tab"
                aria-selected={tab === item}
                onClick={() => setTab(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </>
      )}
      <div
        className={embedded ? 'inspector-body flush' : undefined}
        style={{
          flex: 1,
          minHeight: 0,
          display: embedded && (!open || tab !== 'terminal') ? 'none' : 'flex',
        }}
        id={embedded ? 'inspector-terminal-terminal' : undefined}
      >
        {mounted && (
          <NativeTerminal
            sessionId={session}
            active={!embedded || (open && tab === 'terminal')}
            embedded={embedded}
          />
        )}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider>
    <Fixture />
  </Tooltip.Provider>,
);
