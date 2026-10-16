import { setLanguage } from '../src/i18n';
import '../src/styles/app.css';
import { applyTheme } from '../src/theme';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
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
    __gitSetSession: setSessionId,
    __gitTheme: applyTheme,
    __gitLanguage: setLanguage,
  });
  applyTheme('light');
  return <GitPanel sessionId={sessionId} embedded />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
