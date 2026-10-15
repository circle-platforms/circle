import '../src/styles/app.css';
import { Tooltip } from 'radix-ui';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setLanguage, locale } from '../src/i18n';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime, currentSession } from '../src/model/state';
import type { DesktopBridge } from '../../desktop/src/contracts';
import { applyTheme } from '../src/theme';
setLanguage(
  new URL(location.href).searchParams.get('lang') === 'zh-CN' ? 'zh-CN' : 'en',
);
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
      return response.json();
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
    const [target, setTarget] = useState('main.ts');
    return (
      <Tooltip.Provider>
        <RuntimeProvider runtime={runtime}>
          <button onClick={() => setTarget('main.ts')}>open main</button>
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
