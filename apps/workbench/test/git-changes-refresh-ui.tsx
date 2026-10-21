import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopBridge } from '../../desktop/src/contracts';
import { useGitChanges } from '../src/model/git-changes';

// One list of Git's changes on screen, behind a workspace that counts what it is asked.
// The test sets whether a turn runs and how many of its tool calls have ended.
const asked: string[] = [];
// A host that answers without a list, once
let empty = false;
window.circleDesktop = {
  runtimeCommand: async (command: {
    payload?: { service?: string; method?: string };
  }) => {
    asked.push(`${command.payload?.service}.${command.payload?.method}`);
    if (empty) {
      empty = false;
      return { ok: true };
    }
    return { ok: true, data: { revision: String(asked.length), files: [] } };
  },
  onWorkspaceEvent: () => () => {},
} as unknown as DesktopBridge;
let set: (next: { busy: boolean; settled: number }) => void = () => {};
function List() {
  const [state, setState] = useState({ busy: false, settled: 0 });
  set = setState;
  const { error } = useGitChanges({
    sessionId: 'refresh',
    live: true,
    active: true,
    ...state,
  });
  return (
    <p id="list" data-error={error}>
      {state.busy ? 'busy' : 'idle'} {state.settled}
    </p>
  );
}
Object.assign(window, {
  reads: () => asked.filter((call) => call === 'git.changes').length,
  setList: (next: { busy: boolean; settled: number }) => set(next),
  answerNothing: () => {
    empty = true;
  },
});
createRoot(document.getElementById('root')!).render(<List />);
