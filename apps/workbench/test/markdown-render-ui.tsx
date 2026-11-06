import '../src/styles/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '../src/components/Markdown';
import { SourceNavigation } from '../src/components/SourceNavigation';

declare global {
  interface Window {
    markdownParses: number;
    opened: { path: string; render: number }[];
    renderAgain: () => void;
    setText: (text: string) => void;
  }
}
window.markdownParses = 0;
window.opened = [];
// A window's own render, as every publication makes one: a new `onFile` each time.
function App() {
  const [render, setRender] = useState(0);
  const [text, setText] = useState('first text with a [source](README.md#L1)');
  window.renderAgain = () => setRender((value) => value + 1);
  window.setText = setText;
  return (
    <SourceNavigation onFile={(path) => window.opened.push({ path, render })}>
      <output data-testid="render">{render}</output>
      <Markdown text={text} />
    </SourceNavigation>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
