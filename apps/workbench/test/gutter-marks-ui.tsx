import '../src/styles/app.css';
import { Tooltip } from 'radix-ui';
import { createRoot } from 'react-dom/client';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime, currentSession } from '../src/model/state';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
import type { DesktopBridge } from '../../desktop/src/contracts';
import { connectWorkspaceStreams } from '../src/model/workspace-client';
import { FileViewer } from '../src/features/FileViewer';
import { ModeChromeProvider } from '../src/features/mode-chrome';
import * as monaco from 'monaco-editor/editor/editor.api';

// The file viewer on a file that differs from the last commit, behind a workspace that
// answers what the viewer asks: the file itself, and its patch against the last commit.
const query = new URLSearchParams(location.search);
applyTheme(query.get('theme') === 'dark' ? 'dark' : 'light');
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');

const lines = (count: number, prefix = 'line') =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join(
    '\n',
  ) + '\n';
let file = { content: lines(14), revision: 'r1' };
// Lines 3 and 4 changed, line 7 is new, and a line went after line 10.
let patch = `diff --git a/main.ts b/main.ts
index 1111111..2222222 100644
--- a/main.ts
+++ b/main.ts
@@ -2,4 +2,5 @@
 line 2
-old 3
-old 4
+line 3
+line 4
+line 5
 line 6
@@ -11,3 +12,2 @@
 line 11
-gone
 line 12
`;
let patchFails = false;
const calls: { service: string; method: string; params: unknown }[] = [];
const wholeCalls: string[] = [];
let listener: ((event: unknown) => void) | undefined;
let seq = 0;

const runtime = new PreviewRuntime();
runtime.change((state) => {
  const session = currentSession(state);
  session.readOnly = false;
  state.files = [
    {
      id: 'fixture-main',
      workspaceId: session.workspaceId,
      path: 'main.ts',
      content: '',
      language: 'typescript',
    },
  ];
});
Object.defineProperty(runtime, 'mode', { value: 'live' });
const document_ = () => ({
  path: 'main.ts',
  content: file.content,
  revision: file.revision,
});
window.circleDesktop = {
  onWorkspaceEvent: (receive: (event: unknown) => void) => {
    listener = receive;
    return () => {
      listener = undefined;
    };
  },
  runtimeCommand: async (command: any) => {
    const { service, method, params } = command.payload ?? {};
    calls.push({ service, method, params });
    if (service === 'events')
      return {
        ok: true,
        data: { events: [], cursor: { offset: 0, seq: 0 }, hasMore: false },
      };
    if (service === 'documents' && method === 'read')
      return { ok: true, data: document_() };
    if (service === 'documents' && method === 'save') {
      file = {
        content: params.content,
        revision: `r${Number(file.revision.slice(1)) + 1}`,
      };
      return { ok: true, data: document_() };
    }
    if (service === 'git' && method === 'diff')
      return patchFails
        ? { ok: false, error: 'not a git repository' }
        : {
            ok: true,
            data: { text: patch, previews: [], entries: [], revision: 'g1' },
          };
    return { ok: false, error: `unsupported ${service}.${method}` };
  },
} as unknown as DesktopBridge;

Object.assign(window, {
  gutterFixture: {
    /** The cursor goes to the start of the file, where the test types. */
    toTop: () => {
      const editor = monaco.editor.getEditors()[0]!;
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.focus();
    },
    calls,
    wholeCalls,
    /** The patch against the last commit changes, and the file with it. */
    update: (nextPatch: string, content: string) => {
      patch = nextPatch;
      file = {
        content,
        revision: `r${Number(file.revision.slice(1)) + 1}`,
      };
      const session = currentSession(runtime.getSnapshot());
      listener?.({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        service: 'documents',
        resourceId: 'main.ts',
        epoch: 'gutter',
        seq: ++seq,
        at: new Date().toISOString(),
        cursor: { offset: seq, seq },
        data: { paths: ['main.ts'] },
      });
    },
    failPatch: (value: boolean) => {
      patchFails = value;
    },
  },
});
const session = currentSession(runtime.getSnapshot());
connectWorkspaceStreams(session.workspaceId, session.id, () => {});
createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider>
    <RuntimeProvider runtime={runtime}>
      <ModeChromeProvider
        value={{
          canBeWhole: true,
          whole: false,
          onWhole: () => wholeCalls.push('whole'),
        }}
      >
        <div style={{ height: 560, display: 'flex', width: 760 }}>
          <FileViewer path="main.ts" onClose={() => {}} />
        </div>
      </ModeChromeProvider>
    </RuntimeProvider>
  </Tooltip.Provider>,
);
