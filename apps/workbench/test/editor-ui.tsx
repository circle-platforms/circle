import '../src/styles/app.css';
import { Tooltip } from 'radix-ui';
import { useEffect, useState } from 'react';
import { connectWorkspaceStreams } from '../src/model/workspace-client';
import { createRoot } from 'react-dom/client';
import { setLanguage, locale } from '../src/i18n';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime, currentSession } from '../src/model/state';
import type { DesktopBridge } from '../../desktop/src/contracts';
import { applyTheme } from '../src/theme';
setLanguage(
  new URL(location.href).searchParams.get('lang') === 'zh-CN' ? 'zh-CN' : 'en',
);
import * as monaco from 'monaco-editor/editor/editor.api';
// Fixture inspection proves presentation switches preserve actual editor state.
Object.assign(window, {
  editorReadingState: () => {
    const editor = monaco.editor
      .getEditors()
      .find((item) => item.getModel()?.uri.path.endsWith('/AGENTS.md'));
    const model = editor?.getModel();
    return {
      editorId: editor?.getId(),
      uri: model?.uri.toString(),
      version: model?.getVersionId(),
      selection: editor?.getSelection(),
      content: model?.getValue(),
    };
  },
});
const { NativeCodeEditor, setEditorDocument } =
  await import('../src/features/NativeCodeEditor');
applyTheme('dark');
setEditorDocument('fixture', {
  path: 'main.ts',
  content: 'const amount = 1;\n',
  revision: 'initial',
});
function Fixture() {
  const [diff, setDiff] = useState(false);
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState('const amount = 1;\n');
  const [saves, setSaves] = useState(0);
  const [selection, setSelection] = useState<{
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }>();
  return (
    <>
      <button onClick={() => setDiff((current) => !current)}>
        toggle diff
      </button>
      <button onClick={() => setOpen((current) => !current)}>
        toggle editor
      </button>
      <button
        onClick={() =>
          applyTheme(
            document.documentElement.dataset.theme === 'dark'
              ? 'light'
              : 'dark',
          )
        }
      >
        toggle theme
      </button>
      <button onClick={() => setLanguage(locale() === 'en' ? 'zh-CN' : 'en')}>
        toggle language
      </button>
      <button
        onClick={() =>
          setSelection({
            startLineNumber: 1,
            startColumn: 7,
            endLineNumber: 1,
            endColumn: 13,
          })
        }
      >
        repeat source location
      </button>
      <button
        onClick={() =>
          setSelection({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 6,
          })
        }
      >
        other source location
      </button>
      <output aria-label="content">{value}</output>
      <output aria-label="saves">{saves}</output>
      <div style={{ height: 500, display: 'flex' }}>
        {open && (
          <NativeCodeEditor
            workspaceId="fixture"
            sessionId="fixture"
            path="main.ts"
            value={value}
            original="const amount = 0;\n"
            language="typescript"
            readOnly={false}
            diff={diff}
            live={false}
            selection={selection}
            onChange={setValue}
            onSave={() => setSaves((count) => count + 1)}
            onNavigate={async () => {}}
          />
        )}
      </div>
    </>
  );
}
const nativeFixture = new URL(location.href).searchParams.has('viewer');
if (nativeFixture) {
  window.circleDesktop = {
    copyText: async (text) => {
      const response = await fetch('/__editor_workspace?copy-diagnostics=1', {
        method: 'POST',
        body: text,
      });
      const reply = await response.json();
      if (reply.ok === false) throw Error(reply.error);
      document.documentElement.dataset.diagnosticCopies = String(
        Number(document.documentElement.dataset.diagnosticCopies ?? 0) + 1,
      );
    },
    onWorkspaceEvent: (listener) => {
      const source = new EventSource('/__editor_events');
      source.onmessage = (message) => {
        const event = JSON.parse(message.data);
        const session = currentSession(runtime.getSnapshot());
        listener({
          ...event,
          workspaceId: session.workspaceId,
          sessionId: session.id,
        });
      };
      return () => source.close();
    },
    runtimeCommand: async (command) => {
      const response = await fetch('/__editor_workspace', {
        method: 'POST',
        body: JSON.stringify(command),
      });
      const reply = await response.json();
      if (command.payload?.service === 'events' && reply.ok) {
        const session = currentSession(runtime.getSnapshot());
        reply.data.events = reply.data.events.map((event: object) => ({
          ...event,
          workspaceId: session.workspaceId,
          sessionId: session.id,
        }));
      }
      return reply;
    },
  } as DesktopBridge;
  const { FileViewer } = await import('../src/features/FileViewer');
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
  function NativeFixture() {
    useEffect(() => {
      const session = currentSession(runtime.getSnapshot());
      return connectWorkspaceStreams(
        session.workspaceId,
        session.id,
        (error) => {
          throw error;
        },
      );
    }, []);
    const [target, setTarget] = useState('main.ts');
    return (
      <Tooltip.Provider>
        <RuntimeProvider runtime={runtime}>
          <button onClick={() => setTarget('main.ts')}>open main</button>
          <button onClick={() => setTarget('lib.ts')}>open lib</button>
          <button onClick={() => setTarget('AGENTS.md')}>open rules</button>
          <button
            onClick={() =>
              fetch('/__editor_workspace?external=1', { method: 'POST' })
            }
          >
            external write
          </button>
          <button
            onClick={() =>
              fetch('/__editor_workspace?rename=1', { method: 'POST' })
            }
          >
            external rename
          </button>
          <button
            onClick={() =>
              fetch('/__editor_workspace?delete=1', { method: 'POST' })
            }
          >
            external delete
          </button>
          <button
            onClick={() =>
              fetch('/__editor_workspace?badconfig=1', { method: 'POST' })
            }
          >
            break project config
          </button>
          <button
            onClick={() =>
              fetch('/__editor_workspace?goodconfig=1', { method: 'POST' })
            }
          >
            fix project config
          </button>
          <div style={{ height: 650, display: 'flex' }}>
            <FileViewer
              path={target}
              onNavigate={(path) => setTarget(path)}
              onClose={() => {}}
            />
          </div>
        </RuntimeProvider>
      </Tooltip.Provider>
    );
  }
  createRoot(document.getElementById('root')!).render(<NativeFixture />);
} else createRoot(document.getElementById('root')!).render(<Fixture />);
