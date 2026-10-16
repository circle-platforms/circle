import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { DebugPanel } from '../src/components/DebugPanel';
import { connectWorkspaceStreams } from '../src/model/workspace-client';
const workspaceId = 'debug-ui-fixture';
let eventSequence = 0;
const listeners = new Set<(event: any) => void>();
const pending = new Map<
  number,
  { command: any; resolve: (value: any) => void }
>();
let seq = 0;
let hold = 'stackTrace';
const states: Record<string, any> = {
  A: { status: 'paused', pauseId: 1, output: '', breakpoints: {} },
  B: { status: 'paused', pauseId: 2, output: '', breakpoints: {} },
};
const fixture = ((window as any).debugFixture = {
  session: (_session: string) => {},
  pending: () => [...pending].map(([id, value]) => ({ ...value.command, id })),
  hold: (method: string) => {
    hold = method;
  },
  resolve: (id: number, data: any) => {
    const item = pending.get(id);
    if (!item) throw Error('unknown fixture request');
    pending.delete(id);
    item.resolve({ ok: true, data });
  },
  pause: (sessionId: string, pauseId: number) => {
    states[sessionId] = { ...states[sessionId], pauseId };
    const seq = ++eventSequence;
    for (const listener of listeners)
      listener({
        workspaceId,
        sessionId,
        service: 'debug',
        resourceId: sessionId,
        epoch: 'fixture',
        seq,
        cursor: { seq, offset: seq },
        at: new Date().toISOString(),
        data: {},
      });
  },
});
(window as any).circleDesktop = {
  runtimeCommand: async (command: any) => {
    const { method } = command.payload,
      session = command.sessionId;
    if (method === hold)
      return new Promise((resolve) => pending.set(++seq, { command, resolve }));
    let data: any = {};
    if (method === 'replay')
      data = { events: [], cursor: { offset: 0, seq: 0 }, hasMore: false };
    if (method === 'snapshot') data = states[session];
    if (method === 'stackTrace')
      data = {
        stackFrames: [
          {
            id: session === 'A' ? 1 : 2,
            name: `frame-${session}`,
            source: { name: `${session}.cjs`, path: `/fixture/${session}.cjs` },
            line: states[session].pauseId,
          },
        ],
      };
    if (method === 'scopes')
      data = {
        scopes: [
          {
            name: `scope-${session}`,
            variablesReference: session === 'A' ? 11 : 22,
          },
        ],
      };
    if (method === 'variables')
      data = {
        variables: [
          {
            name: `variable-${session}`,
            value: session,
            variablesReference: 0,
          },
        ],
      };
    if (method === 'evaluate') data = { result: `result-${session}` };
    return { ok: true, data };
  },
  onWorkspaceEvent: (listener: any) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
function Harness() {
  const [session, setSession] = useState('A');
  useEffect(() => connectWorkspaceStreams(workspaceId, session), [session]);
  fixture.session = setSession;
  return (
    <>
      <div data-session={session} />
      <DebugPanel sessionId={session} />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
