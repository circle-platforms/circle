import { createRoot } from 'react-dom/client';
import { RuntimeProvider, useRuntime } from '../src/app/context';
import { RecoveredInputs } from '../src/features/RecoveredInputs';
import { createFixtures } from '../src/preview/fixtures';
import type { RuntimePort } from '../src/model/types';
const snapshot = createFixtures();
const session = snapshot.sessions[0];
session.id = 'recovery-session';
session.draft = 'existing draft';
session.attachments = [];
snapshot.activeSessionId = session.id;
const listeners = new Set<() => void>();
const full = Array.from({ length: 600 }, (_, i) => `preserved line ${i}`).join(
  '\n',
);
const input = {
  id: 'input1',
  kind: 'followUp',
  state: 'recovery_pending',
  order: 1,
  createdAt: 1000,
  updatedAt: 1000,
  payload: {
    text: full,
    display: '[Pasted text #1]',
    pastes: { '1': full },
    attachments: [
      {
        kind: 'image',
        filename: 'test.png',
        mime_type: 'image/png',
        data: 'AAEC',
        sha256: 'a'.repeat(64),
      },
    ],
  },
};
let discarded = false;
const calls: any[] = [];
Object.assign(window, {
  calls,
  circleDesktop: {
    runtimeCommand: async (command: any) => {
      calls.push(command);
      const { method, params } = command.payload;
      if (method === 'list')
        return {
          ok: true,
          data: { version: 1, items: discarded ? [] : [input] },
        };
      if (params.action === 'discard') discarded = true;
      return {
        ok: true,
        data: {
          version: 1,
          items: [input],
          action: params.action,
          applied: true,
        },
      };
    },
  },
});
let state = snapshot;
const runtime = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  updateSessionView: (id: string, patch: object) => {
    state = {
      ...state,
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, ...patch } : s,
      ),
    };
    listeners.forEach((listener) => listener());
    return true;
  },
} as unknown as RuntimePort;
function Fixture() {
  const { snapshot } = useRuntime();
  const s = snapshot.sessions[0];
  return (
    <>
      <RecoveredInputs sessionId={session.id} />
      <textarea aria-label="restored draft" readOnly value={s.draft} />
      <output aria-label="restored media">{s.attachments[0]?.content}</output>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider runtime={runtime}>
    <Fixture />
  </RuntimeProvider>,
);
