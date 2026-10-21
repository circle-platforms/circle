import { lazy, Suspense } from 'react';
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

const NativeTerminal = lazy(() =>
  import('../components/NativeTerminal').then((m) => ({
    default: m.NativeTerminal,
  })),
);

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
  if (paused)
    return (
      <div className="terminal-mode">
        <p className="panel-note" role="status">
          {t('terminals belong to a conversation; start one to open them')}
        </p>
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
