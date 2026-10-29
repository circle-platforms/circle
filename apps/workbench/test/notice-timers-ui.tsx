import { createRoot } from 'react-dom/client';
import { RuntimeProvider, useRuntime } from '../src/app/context';
import { createFixtures } from '../src/preview/fixtures';
import { LiveRuntime } from '../src/model/live';
import type { DesktopBridge } from '../../desktop/src/contracts';
import type { RuntimeUpdate } from '../../desktop/src/runtime-protocol';
import '../src/styles/app.css';

// The window's notices over a live session whose host fails one command: the message box
// sends as the composer does, and the notice shows as the window shows it.
const snapshot = createFixtures();
const session = snapshot.sessions[0];
session.id = 'notice-session';
session.draft = '';
session.attachments = [];
const other = structuredClone(session);
other.id = 'notice-session-b';
other.title = 'another conversation';
other.messages = [];
other.leafId = null;
other.hiddenIds = [];
other.undoStack = [];
snapshot.sessions = [session, other];
snapshot.activeSessionId = session.id;
snapshot.runtime = { connected: true, configured: true };
const calls: { name: string; payload: unknown }[] = [];
const shareCalls: unknown[] = [];
let listener: ((update: RuntimeUpdate) => void) | undefined;
let current: RuntimeUpdate = { seq: 1, connected: true, snapshot };
let releaseShare: () => void = () => {};
const host = {
  runtimeCommand: async (command: { name: string; payload: unknown }) => {
    calls.push({ name: command.name, payload: command.payload });
    if (command.name === 'load-skill')
      return { ok: false, error: 'skill not found' };
    if (command.name === 'share') {
      // The share answer comes only when the test says so: it can land while
      // the window looks at another conversation, as #302 describes.
      shareCalls.push(command.payload);
      await new Promise<void>((done) => {
        releaseShare = done;
      });
      return { ok: true, data: { path: 'D:/synthetic/share.json' } };
    }
    return { ok: true, data: {} };
  },
  runtimeState: async () => current,
  onRuntime: (callback: (update: RuntimeUpdate) => void) => {
    listener = callback;
    return () => {
      listener = undefined;
    };
  },
} as unknown as DesktopBridge;
const runtime = new LiveRuntime(host, current);
Object.assign(window, {
  calls,
  shareCalls,
  runtime,
  releaseShare: () => releaseShare(),
  setActive: (id: string) => {
    current = {
      seq: current.seq + 1,
      connected: true,
      snapshot: { ...current.snapshot, activeSessionId: id },
    };
    listener?.(current);
  },
});
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
