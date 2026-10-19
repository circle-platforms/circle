import { lazy, Suspense } from 'react';
import {
  commandTerminalRequest,
  type CommandTerminalView,
} from '../model/command-terminal-client';
import { useRuntime } from '../app/context';
import { t } from '../i18n';
import { NativeResourceBoundary } from '../components/NativeResourceBoundary';
import { appendTerminalSelection } from '../model/terminal-context';
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
}: {
  commandTerminal?: CommandTerminalView;
  onExitCommandTerminal?: () => void;
  sessionId: string;
  visible: boolean;
}) {
  const { runtime } = useRuntime();
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
              appendTerminalSelection(runtime, capture, () =>
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
              )
            }
          />
        </NativeResourceBoundary>
      </Suspense>
    </div>
  );
}
