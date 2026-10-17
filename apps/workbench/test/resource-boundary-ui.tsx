import { createRoot } from 'react-dom/client';
import '../src/styles/app.css';
import { useState } from 'react';
import { NativeResourceBoundary } from '../src/components/NativeResourceBoundary';
import '../src/styles/developer-workbench.css';
let broken = false;
function IndependentResource() {
  if (broken) throw Error('controlled resource render failure');
  return <input aria-label="terminal search" defaultValue="retained query" />;
}
function Fixture() {
  const [revision, setRevision] = useState(0);
  const [resource, setResource] = useState('first');
  return (
    <main data-revision={revision}>
      <label>
        conversation draft
        <textarea
          aria-label="conversation draft"
          defaultValue="working draft"
        />
      </label>
      <label>
        editor buffer
        <textarea aria-label="editor buffer" defaultValue="unsaved source" />
      </label>
      <button
        onClick={() => {
          broken = true;
          setRevision((value) => value + 1);
        }}
      >
        fail resource
      </button>
      <button
        onClick={() => {
          broken = false;
        }}
      >
        repair source
      </button>
      <button
        onClick={() => {
          broken = false;
          setResource('second');
        }}
      >
        choose healthy resource
      </button>
      <NativeResourceBoundary name="terminal" resetKey={resource}>
        <IndependentResource />
      </NativeResourceBoundary>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
