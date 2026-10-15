import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  NativeCodeEditor,
  setEditorDocument,
} from '../src/features/NativeCodeEditor';
import { applyTheme } from '../src/theme';
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
createRoot(document.getElementById('root')!).render(<Fixture />);
