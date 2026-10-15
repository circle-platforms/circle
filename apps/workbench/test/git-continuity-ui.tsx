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
  Object.assign(window, { __gitSetSession: setSessionId });
  return <GitPanel sessionId={sessionId} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
