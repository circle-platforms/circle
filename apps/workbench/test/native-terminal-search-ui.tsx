import { Tooltip } from 'radix-ui';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { NativeTerminal } from '../src/components/NativeTerminal';
import '../src/styles/app.css';
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
    <div style={{ height: 600 }}>
      {mounted && <NativeTerminal sessionId={session} />}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider>
    <Fixture />
  </Tooltip.Provider>,
);
