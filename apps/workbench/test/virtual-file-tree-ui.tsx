import '../src/styles/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from 'radix-ui';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime, currentSession } from '../src/model/state';
import { FilesPanel } from '../src/features/Panels';
import { applyTheme } from '../src/theme';
const runtime = new PreviewRuntime();
const originalOwner = currentSession(runtime.getSnapshot()).id;
const paths = Array.from(
  { length: 50000 },
  (_, n) =>
    `group${String(Math.floor(n / 500)).padStart(3, '0')}/file${String(n % 500).padStart(3, '0')}.ts`,
);
runtime.change((state) => {
  const session = currentSession(state);
  state.sessions.push({
    ...session,
    id: 'tree-other',
    title: 'other tree owner',
  });
  state.files = paths.map((path) => ({
    id: path,
    path,
    workspaceId: session.workspaceId,
    content: '',
    language: 'typescript',
  }));
});
applyTheme(
  new URL(location.href).searchParams.get('theme') === 'light'
    ? 'light'
    : 'dark',
);
function Fixture() {
  const [selection, setSelection] = useState(paths.at(-1)!);
  const [calls, setCalls] = useState<string[]>([]);
  return (
    <Tooltip.Provider>
      <RuntimeProvider runtime={runtime}>
        <button
          onClick={() =>
            runtime.change((state) => {
              state.activeSessionId =
                state.activeSessionId === 'tree-other'
                  ? originalOwner
                  : 'tree-other';
            })
          }
        >
          switch tree owner
        </button>
        <button
          onClick={() =>
            runtime.change((state) => {
              state.fileListings = {
                [currentSession(state).workspaceId]: {
                  loaded: 2000,
                  complete: false,
                  truncated: false,
                },
              };
            })
          }
        >
          loading listing
        </button>
        <button
          onClick={() =>
            runtime.change((state) => {
              state.fileListings = {
                [currentSession(state).workspaceId]: {
                  loaded: 2000,
                  complete: true,
                  truncated: true,
                },
              };
            })
          }
        >
          partial listing
        </button>
        <textarea aria-label="retained draft" defaultValue="my draft" />
        <output aria-label="selected path">{selection}</output>
        <output aria-label="open calls">{JSON.stringify(calls)}</output>
        <button onClick={() => setSelection(paths[3])}>
          reveal early file
        </button>
        <div className="inspector" style={{ height: 480, width: 360 }}>
          <div style={{ height: '100%', display: 'flex' }}>
            <FilesPanel
              selection={selection}
              onFile={(path) => {
                setSelection(path);
                setCalls((old) => [...old, path]);
              }}
            />
          </div>
        </div>
      </RuntimeProvider>
    </Tooltip.Provider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
