import { createRoot } from 'react-dom/client';
import { RuntimeProvider, useRuntime } from '../src/app/context';
import { createFixtures } from '../src/preview/fixtures';
import { LiveRuntime } from '../src/model/live';
import type { DesktopBridge } from '../../desktop/src/contracts';
import '../src/styles/app.css';

// The window's notices over a live session whose host fails one command: the message box
// sends as the composer does, and the notice shows as the window shows it.
const snapshot = createFixtures();
const session = snapshot.sessions[0];
session.id = 'notice-session';
session.draft = '';
session.attachments = [];
snapshot.activeSessionId = session.id;
snapshot.runtime = { connected: true, configured: true };
const calls: { name: string; payload: unknown }[] = [];
const host = {
  runtimeCommand: async (command: { name: string; payload: unknown }) => {
    calls.push({ name: command.name, payload: command.payload });
    if (command.name === 'load-skill')
      return { ok: false, error: 'skill not found' };
    return { ok: true, data: {} };
  },
  runtimeState: async () => ({ seq: 1, connected: true, snapshot }),
  onRuntime: () => () => {},
} as unknown as DesktopBridge;
const runtime = new LiveRuntime(host, { seq: 1, connected: true, snapshot });
Object.assign(window, { calls, runtime });
function Fixture() {
  const { snapshot, notice, act } = useRuntime();
  const current = snapshot.sessions.find((item) => item.id === session.id);
  return (
    <main style={{ padding: 24 }}>
      <textarea
        aria-label="message"
        value={current?.draft ?? ''}
        onChange={(event) =>
          runtime.updateSessionView(session.id, { draft: event.target.value })
        }
      />
      <button
        aria-label="send message"
        onClick={() => act(() => runtime.send())}
      >
        send
      </button>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider runtime={runtime}>
    <Fixture />
  </RuntimeProvider>,
);
