import { lazy, Suspense, useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import { PaneEmpty } from '../components/common';
import {
  commandTerminalRequest,
  type CommandTerminalView,
} from '../model/command-terminal-client';
import { useRuntime } from '../app/context';
import { t } from '../i18n';
import { NativeResourceBoundary } from '../components/NativeResourceBoundary';
import { appendTerminalSelection } from '../model/terminal-context';
import { useAddToDraft } from '../app/draft';
import { workspaceCall } from '../model/workspace-client';
import type { TerminalReplay } from '../../../desktop/src/workspace/terminal';

type TerminalView =
  typeof import('../components/NativeTerminal').NativeTerminal;
// Once loaded, the terminal is rendered directly. Through `lazy` its first showing would
// still suspend, and React keeps a suspense fallback up for about 300ms.
let loadedTerminal: TerminalView | undefined;
const loadTerminal = () =>
  import('../components/NativeTerminal').then((m) => {
    loadedTerminal = m.NativeTerminal;
    return m;
  });
const LazyTerminal = lazy(() =>
  loadTerminal().then((m) => ({
    default: m.NativeTerminal,
  })),
);
// The terminal and its xterm code are large. They load once the window is idle, so the
// first time the terminal opens it does not wait for them.
if (typeof window !== 'undefined') {
  const preload = () => void loadTerminal().catch(() => {});
  if (window.requestIdleCallback)
    window.requestIdleCallback(preload, { timeout: 4000 });
  else setTimeout(preload, 1500);
}

/** The terminal mode: this conversation's terminals, as tabs, in the drawer. */
export function TerminalMode({
  commandTerminal,
  onExitCommandTerminal,
  sessionId,
  visible,
  paused = false,
}: {
  commandTerminal?: CommandTerminalView;
  onExitCommandTerminal?: () => void;
  sessionId: string;
  visible: boolean;
  /** Home: no conversation is open, so there are no terminals to show. */
  paused?: boolean;
}) {
  const { runtime } = useRuntime();
  // In a window of its own, the message box is the main window's. Every hook is called
  // before home's early return, so the hooks keep their order when home is left.
  const addToDraft = useAddToDraft();
  // Chosen once per mount: switching from the lazy component to the loaded one later
  // would remount the terminal and drop its connection.
  const [NativeTerminal] = useState(() => loadedTerminal ?? LazyTerminal);
  if (paused)
    return (
      <div className="terminal-mode">
        <PaneEmpty icon={SquareTerminal} title={t('terminal')}>
          <p>
            {t('terminals belong to a conversation; start one to open them')}
          </p>
        </PaneEmpty>
      </div>
    );
  return (
    <div className="terminal-mode">
      <Suspense fallback={<p role="status">{t('loading terminal…')}</p>}>
        <NativeResourceBoundary name={t('terminal')} resetKey={sessionId}>
          <NativeTerminal
            embedded
            sessionId={sessionId}
            commandTerminal={commandTerminal}
            onExitCommandTerminal={onExitCommandTerminal}
            active={visible}
            onAddToDraft={(capture) =>
              appendTerminalSelection(
                runtime,
                capture,
                () =>
                  commandTerminal
                    ? commandTerminalRequest(
                        commandTerminal.viewSessionId,
                        commandTerminal.resolved.target,
                        () => {},
                      )<TerminalReplay>('replay', {
                        id: capture.terminalId,
                        afterSequence: capture.outputSequence,
                        limit: 1,
                      })
                    : workspaceCall<TerminalReplay>(
                        capture.sourceSessionId,
                        'terminal',
                        'replay',
                        {
                          id: capture.terminalId,
                          afterSequence: capture.outputSequence,
                          limit: 1,
                        },
                      ),
                addToDraft,
              )
            }
          />
        </NativeResourceBoundary>
      </Suspense>
    </div>
  );
}
