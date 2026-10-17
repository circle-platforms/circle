import { MemoryRouter } from 'react-router-dom';
import { Tooltip } from 'radix-ui';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime } from '../src/model/state';
import { setLanguage, t } from '../src/i18n';
import '../src/styles/app.css';
import { applyTheme } from '../src/theme';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { GitPanel } from '../src/components/GitPanel';
Object.assign(window, {
  circleDesktop: {
    runtimeCommand: async (command: unknown) =>
      await fetch('/test-git-command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
      }).then((response) => response.json()),
  },
});
function Fixture() {
  const [sessionId, setSessionId] = useState('continuity');
  Object.assign(window, {
    __gitSetSession: (id: string) => flushSync(() => setSessionId(id)),
    __gitTheme: applyTheme,
    __gitLanguage: setLanguage,
  });
  return (
    <aside className="inspector" style={{ width: '100%', height: '100vh' }}>
      <header className="inspector-title">
        <h2>{t('git workspace')}</h2>
      </header>
      <div className="inspector-body">
        <GitPanel
          sessionId={sessionId}
          embedded
          onFile={(path) => Object.assign(window, { __gitOpened: path })}
        />
      </div>
    </aside>
  );
}
const runtime = new PreviewRuntime();
applyTheme('light');
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <RuntimeProvider runtime={runtime}>
      <Tooltip.Provider>
        <Fixture />
      </Tooltip.Provider>
    </RuntimeProvider>
  </MemoryRouter>,
);
