import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopBridge } from '../../desktop/src/contracts';
import { useGitChanges } from '../src/model/git-changes';

// One list of Git's changes on screen, behind a workspace that counts what it is asked.
// The test sets whether a turn runs and how many of its tool calls have ended.
const asked: string[] = [];
// A host that answers without a list, once
let empty = false;
let files: { path: string; status: string }[] = [];
let holdNext = false;
let release: () => void = () => {};
window.circleDesktop = {
  runtimeCommand: async (command: {
    payload?: { service?: string; method?: string };
  }) => {
    asked.push(`${command.payload?.service}.${command.payload?.method}`);
    if (empty) {
      empty = false;
      return { ok: true };
    }
    const response = { revision: String(asked.length), files: [...files] };
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return { ok: true, data: response };
  },
  onWorkspaceEvent: () => () => {},
} as unknown as DesktopBridge;
let set: (
  next: Partial<{
    busy: boolean;
    settled: number;
    active: boolean;
    sessionId: string;
  }>,
) => void = () => {};
function List() {
  const [state, setState] = useState({
    busy: false,
    settled: 0,
    active: true,
    sessionId: 'refresh',
  });
  set = (next) => setState((previous) => ({ ...previous, ...next }));
  const { error, files: shown } = useGitChanges({
    live: true,
    ...state,
  });
  return (
    <p id="list" data-error={error} data-files={JSON.stringify(shown)}>
      {state.busy ? 'busy' : 'idle'} {state.settled}
    </p>
  );
}
Object.assign(window, {
  reads: () => asked.filter((call) => call === 'git.changes').length,
  setList: (
    next: Partial<{
      busy: boolean;
      settled: number;
      active: boolean;
      sessionId: string;
    }>,
  ) => set(next),
  setGitFiles: (next: typeof files) => {
    files = next;
  },
  holdNextGitRead: () => {
    holdNext = true;
  },
  releaseGitRead: () => release(),
  answerNothing: () => {
    empty = true;
  },
});
createRoot(document.getElementById('root')!).render(<List />);
