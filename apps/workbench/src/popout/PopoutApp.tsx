import { Tooltip } from 'radix-ui';
import { useEffect } from 'react';
import { useRuntime } from '../app/context';
import { ModeChromeProvider } from '../features/mode-chrome';
import { NativeBrowser } from '../features/NativeBrowser';
import { TerminalMode } from '../features/TerminalMode';
import { desktopHost } from '../host';
import { t } from '../i18n';
import { connectWorkspaceStreams } from '../model/workspace-client';
import type { PopoutKind } from '../../../desktop/src/contracts';
import '../styles/popout.css';

/**
 * The page of a window a mode of the drawer was popped out into: that one mode of that
 * conversation across the whole window, and the way back into the drawer. It shows the
 * same browser and the same terminals as the drawer would; nothing of the conversation
 * is on it.
 */
export function PopoutApp({
  kind,
  sessionId,
}: {
  kind: PopoutKind;
  sessionId: string;
}) {
  const { snapshot } = useRuntime();
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  const dock = () => void desktopHost()?.popoutDock(kind, sessionId);
  useEffect(() => {
    if (!session) return;
    return connectWorkspaceStreams(session.workspaceId, session.id);
  }, [session?.id, session?.workspaceId]);
  // The conversation was deleted: there is nothing left for this window to show.
  const gone = !session && snapshot.sessions.length > 0;
  useEffect(() => {
    if (gone) dock();
  }, [gone]);
  if (!session)
    return (
      <p className="popout-empty" role="status">
        {t('this conversation is gone')}
      </p>
    );
  return (
    <Tooltip.Provider delayDuration={300}>
      <ModeChromeProvider
        value={{
          canBeWhole: false,
          whole: false,
          onWhole: () => {},
          onDock: dock,
        }}
      >
        {/* The drawer's own markup, so the mode looks as it does there. */}
        <aside
          className="inspector work-drawer popout"
          data-inspector-panel={kind}
          aria-label={t('work drawer')}
        >
          <div className="inspector-body flush">
            <div
              className="inspector-resource-view"
              data-inspector-resource={kind}
            >
              {kind === 'browser' ? (
                <NativeBrowser sessionId={sessionId} />
              ) : (
                <TerminalMode sessionId={sessionId} visible />
              )}
            </div>
          </div>
        </aside>
      </ModeChromeProvider>
    </Tooltip.Provider>
  );
}
