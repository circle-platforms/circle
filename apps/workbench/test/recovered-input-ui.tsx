import { createRoot } from 'react-dom/client';
import { RuntimeProvider, useRuntime } from '../src/app/context';
import { RecoveredInputs } from '../src/features/RecoveredInputs';
import { createFixtures } from '../src/preview/fixtures';
import { LiveRuntime } from '../src/model/live';
import type { DesktopBridge } from '../../desktop/src/contracts';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
import '../src/styles/app.css';
const query = new URLSearchParams(location.search);
applyTheme(query.get('theme') === 'dark' ? 'dark' : 'light');
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
const snapshot = createFixtures();
const session = snapshot.sessions[0];
session.id = 'recovery-session';
session.draft = 'existing draft';
session.attachments = [];
snapshot.activeSessionId = session.id;
snapshot.runtime = { connected: true, configured: true };
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
let storageFails = new URLSearchParams(location.search).has('storageFailure');
Object.assign(window, {
  allowRecoveryStorage: () => {
    storageFails = false;
  },
});
const host = {
  ...window.circleDesktop,
  onRuntime: () => () => {},
} as unknown as DesktopBridge;
const runtime = new LiveRuntime(
  host,
  { seq: 1, connected: true, snapshot },
  {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => {
      if (storageFails)
        throw new DOMException(
          'controlled quota failure',
          'QuotaExceededError',
        );
      localStorage.setItem(key, value);
    },
  },
);
function Fixture() {
  const { snapshot } = useRuntime();
  const s = snapshot.sessions[0];
  return (
    <section className="composer-area">
      <RecoveredInputs sessionId={session.id} />
      <textarea aria-label="restored draft" readOnly value={s.draft} />
      <output aria-label="restored media">{s.attachments[0]?.content}</output>
    </section>
  );
}
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider runtime={runtime}>
    <Fixture />
  </RuntimeProvider>,
);
