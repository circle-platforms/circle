import { createRoot } from 'react-dom/client';
import { RuntimeProvider } from '../src/app/context';
import { SafeFileUndo } from '../src/features/SafeFileUndo';
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
const session = snapshot.sessions[0]!;
session.id = 'undo-session';
session.draft = 'retain the working draft';
session.mode = query.has('readonly') ? 'plan' : 'manual';
snapshot.activeSessionId = session.id;
snapshot.runtime = { connected: true, configured: true };
const paths = [
  'src/alpha.ts',
  'src/deep/long-file-name-with-visible-full-path.ts',
];
const calls: unknown[] = [];
const receipts: unknown[] = [];
const files: Record<string, string> = Object.fromEntries(
  paths.map((path) => [path, 'after text-tool edit']),
);
let resolvePending: (() => void) | undefined;
let failRestore = query.has('failure');
const update = { seq: 1, connected: true, snapshot };
const host = {
  onRuntime: () => () => {},
  runtimeState: async () => update,
  runtimeCommand: async (command: any) => {
    calls.push(structuredClone(command));
    if (query.has('deferred'))
      await new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
    let reply;
    if (command.name === 'preview-file-undo') {
      reply = {
        ok: true,
        data: query.has('invalidPreview')
          ? {}
          : {
              id: 'preview-token-1',
              turnId: 'turn-1',
              paths,
              conflicts: query.has('conflict') ? [paths[1]] : [],
              unsupported: ['shell effects'],
            },
      };
    } else if (command.name === 'restore-turn-files') {
      if (failRestore) {
        failRestore = false;
        reply = {
          ok: false,
          error: 'controlled restore failure; no files restored',
        };
      } else if (query.has('unconfirmed')) reply = { ok: true, data: {} };
      else {
        for (const path of paths) files[path] = 'before text-tool edit';
        reply = { ok: true, data: { restored: true, turnId: 'turn-1', paths } };
      }
    } else throw Error('unexpected command');
    receipts.push(structuredClone(reply));
    return reply;
  },
} as unknown as DesktopBridge;
const runtime = new LiveRuntime(host, update);
Object.assign(window, {
  undoFixture: {
    calls,
    receipts,
    files,
    resolve: () => resolvePending?.(),
    snapshot: () => JSON.stringify(runtime.getSnapshot()),
  },
});
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider runtime={runtime}>
    <main style={{ padding: 20, maxWidth: 600 }}>
      <textarea aria-label="working draft" defaultValue={session.draft} />
      <SafeFileUndo
        sessionId={session.id}
        turnId="turn-1"
        disabled={query.has('disabled')}
      />
    </main>
  </RuntimeProvider>,
);
