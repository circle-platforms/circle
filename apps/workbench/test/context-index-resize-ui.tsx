import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ResizableContextIndex } from '../src/components/ResizableContextIndex';
import { applyTheme } from '../src/theme';
import '../src/styles/app.css';
applyTheme(
  new URLSearchParams(location.search).get('theme') === 'light'
    ? 'light'
    : 'dark',
);
function Fixture() {
  const [owner, setOwner] = useState('owner-a');
  const [open, setOpen] = useState(true);
  const [resource, setResource] = useState('files');
  return (
    <>
      <header>
        <button
          onClick={() =>
            setResource((value) => (value === 'files' ? 'git' : 'files'))
          }
        >
          switch resource
        </button>
        <button onClick={() => setOwner('owner-a')}>owner a</button>
        <button onClick={() => setOwner('owner-b')}>owner b</button>
        <button onClick={() => setOpen((value) => !value)}>toggle index</button>
      </header>
      <section
        className="resize-fixture"
        style={{
          display: 'flex',
          position: 'relative',
          height: 'calc(100vh - 44px)',
          width: '100%',
          minWidth: 0,
        }}
      >
        <main style={{ flex: 1, minWidth: 0 }}>
          <textarea
            aria-label="document draft"
            defaultValue="retained document"
          />
          <div data-document-marker>same document</div>
        </main>
        <ResizableContextIndex
          ownerKey={`${new URLSearchParams(location.search).get('theme')}:${owner}`}
          resourceKey={resource}
          open={open}
        >
          <input aria-label="index filter" defaultValue="retained filter" />
        </ResizableContextIndex>
      </section>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
