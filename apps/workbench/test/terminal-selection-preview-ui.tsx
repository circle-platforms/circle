import { createRoot } from 'react-dom/client';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime } from '../src/model/state';
import {
  TerminalSelectionPreview,
  terminalSelectionDisplay,
} from '../src/components/TerminalSelectionPreview';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
import '../src/styles/app.css';
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
applyTheme(query.get('theme') === 'dark' ? 'dark' : 'light');
const text = Array.from(
  { length: 600 },
  (_, i) => `line ${i + 1}: selected output 中文`,
).join('\n');
const file = {
  id: 'terminal-selection:fixture',
  kind: 'file' as const,
  name: 'zsh · selection',
  mime: 'text/plain',
  content:
    text +
    '\n\n--- terminal capture source ---\n' +
    JSON.stringify(
      {
        kind: 'circle.terminal-selection',
        version: 1,
        captureId: 'fixture',
        label: 'zsh',
        cwd: '/synthetic/project',
        terminalEpoch: 'private-technical-epoch',
        identityVerifiedBy: 'session-scoped terminal replay',
      },
      null,
      2,
    ),
};
const copies: string[] = [];
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: async (value: string) => {
      copies.push(value);
    },
  },
});
const checks = [
  { ...file, id: 'terminal-selection:other' },
  { ...file, id: 'plain' },
  { ...file, content: file.content.replace('"version": 1', '"version": 2') },
  { ...file, content: 'broken json' },
].map((value) => terminalSelectionDisplay(value) === undefined);
Object.assign(window, { previewFixture: { text, file, copies, checks } });
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider runtime={new PreviewRuntime()}>
    <main className="page">
      <details className="context-source" open>
        <summary>{file.name}</summary>
        <TerminalSelectionPreview file={file} />
      </details>
    </main>
  </RuntimeProvider>,
);
