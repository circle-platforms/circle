import { Tooltip } from 'radix-ui';
import { useEffect, useState } from 'react';
import { useRuntime } from '../app/context';
import { ModeChromeProvider } from '../features/mode-chrome';
import { NativeBrowser } from '../features/NativeBrowser';
import { TerminalMode } from '../features/TerminalMode';
import { desktopHost } from '../host';
import { t } from '../i18n';
import { DraftProvider } from '../app/draft';
import type { AddToDraft } from '../model/draft-attachments';
import { connectWorkspaceStreams } from '../model/workspace-client';
import { applyTheme } from '../theme';
import type { PopoutKind } from '../../../desktop/src/contracts';
import '../styles/popout.css';

// What a mode adds to a message box goes to the main window, which keeps the drafts: a
// page screenshot or a terminal selection, and nothing else.
const toMainWindow: AddToDraft = async (sessionId, attachment) => {
  const host = desktopHost();
  const { id, name, kind, mime, size, content } = attachment;
  if (
    !host?.popoutAttach ||
    (kind !== 'image' && kind !== 'file') ||
    mime === undefined ||
    size === undefined
  )
    throw Error(t('action failed'));
  try {
    return await host.popoutAttach(sessionId, {
      id,
      name,
      kind,
      mime,
      size,
      content,
    });
  } catch (error) {
    // The main process says so in English; the window says it in its language.
    if (
      error instanceof Error &&
      error.message === 'the main window did not answer'
    )
      throw Error(t('the main window did not answer'));
    throw error;
  }
};

/**
 * The page of a window a mode of the drawer was popped out into: that one mode of that
 * conversation across the whole window, and the way back into the drawer. It shows the
 * same browser and the same terminals as the drawer would; nothing of the conversation
 * is on it. What it adds to the message box goes to the main window's.
 */
export function PopoutApp({
  kind,
  sessionId,
}: {
  kind: PopoutKind;
  sessionId: string;
}) {
  const { snapshot, notice, notify } = useRuntime();
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  const dock = () => void desktopHost()?.popoutDock(kind, sessionId);
  useEffect(() => {
    if (!session) return;
    return connectWorkspaceStreams(session.workspaceId, session.id, (error) =>
      notify(String(error)),
    );
  }, [session?.id, session?.workspaceId]);
  // The theme and the text size the main window has, and the system's light or dark
  // while the theme follows it.
  const { theme, textSize } = snapshot.settings;
  useEffect(() => {
    const apply = () => applyTheme(theme, textSize);
    apply();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme, textSize]);
  // An address the main window opened for this browser, as its drawer would have. Taking
  // one hands it over once, so what was taken is kept even by an effect run again.
  const [address, setAddress] = useState<{ url: string; request: number }>();
  useEffect(() => {
    const host = desktopHost();
    if (kind !== 'browser' || !host?.popoutAddress) return;
    const take = () =>
      void host.popoutAddress!().then(
        (url) => {
          if (url)
            setAddress((last) => ({ url, request: (last?.request ?? 0) + 1 }));
        },
        () => {},
      );
    const stop = host.onPopoutAddress?.(take) ?? (() => {});
    take();
    return stop;
  }, [kind]);
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
      <DraftProvider value={toMainWindow}>
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
                  <NativeBrowser
                    sessionId={sessionId}
                    target={address?.url}
                    targetRequest={address?.request}
                  />
                ) : (
                  <TerminalMode sessionId={sessionId} visible />
                )}
              </div>
            </div>
          </aside>
        </ModeChromeProvider>
      </DraftProvider>
      {/* Notices, as the main window shows them */}
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </Tooltip.Provider>
  );
}
