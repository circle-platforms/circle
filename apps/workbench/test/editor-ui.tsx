import '../src/styles/app.css';
import { Tooltip } from 'radix-ui';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setLanguage } from '../src/i18n';
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
  createRoot(document.getElementById('root')!).render(
    <Tooltip.Provider>
      <RuntimeProvider runtime={runtime}>
        <button
          onClick={() =>
            fetch('/__editor_workspace?external=1', { method: 'POST' })
          }
        >
          external write
        </button>
        <div style={{ height: 650, display: 'flex' }}>
          <FileViewer path="main.ts" onClose={() => {}} />
        </div>
      </RuntimeProvider>
    </Tooltip.Provider>,
  );
} else createRoot(document.getElementById('root')!).render(<Fixture />);
