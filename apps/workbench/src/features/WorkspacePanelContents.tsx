import {
  commandTerminalRequest,
  type CommandTerminalView,
} from '../model/command-terminal-client';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import { t } from '../i18n';
import { NativeResourceBoundary } from '../components/NativeResourceBoundary';
import { TasksPanel } from './TasksPanel';
import { DeliveryCyclePanel } from './DeliveryCyclePanel';
import { appendTerminalSelection } from '../model/terminal-context';
import { workspaceCall } from '../model/workspace-client';
import { developerToolsEnabled } from '../plugins/developer';
import { activityTabWhenDebugHidden, forcedActivityTab } from './activity-tabs';
import type { TerminalReplay } from '../../../desktop/src/workspace/terminal';
const NativeTerminal = lazy(() =>
  import('../components/NativeTerminal').then((m) => ({
    default: m.NativeTerminal,
  })),
);
const GitPanel = lazy(() =>
  import('../components/GitPanel').then((m) => ({ default: m.GitPanel })),
);
const DebugPanel = lazy(() =>
  import('../components/DebugPanel').then((m) => ({ default: m.DebugPanel })),
);

/** Native resources use the existing inspector's tabs and lifetime, without another workbench. */
export function WorkspacePanelContents({
  kind,
  resourcesPaused = false,
  commandTerminal,
  debugSourceRequest,
  onOpenTerminal,
  terminalFocusRequest,
  onExitCommandTerminal,
  sessionId,
  visible,
  selection,
  children,
  onFile,
  onSession,
  onTask,
}: {
  kind: 'terminal' | 'changes' | 'activity';
  resourcesPaused?: boolean;
  commandTerminal?: CommandTerminalView;
  debugSourceRequest?: { id: string; path: string; line?: number };
  onOpenTerminal?: (target: { id: string; epoch: string }) => void;
  terminalFocusRequest?: { id: string; epoch: string; requestId: string };
  onExitCommandTerminal?: () => void;
  sessionId: string;
  visible: boolean;
  selection: string;
  children: ReactNode;
  onFile: (path: string, line?: number, column?: number) => void;
  onSession: (id: string) => void;
  onTask: (id: string) => void;
}) {
  const { runtime, snapshot, notify } = useRuntime();
  const showDebug = developerToolsEnabled(snapshot.extensions);
  const workspaceRoot = snapshot.workspaces.find(
    (workspace) =>
      workspace.id ===
      snapshot.sessions.find((session) => session.id === sessionId)
        ?.workspaceId,
  )?.path;
  const panelId = (name: string) => `inspector-${kind}-${name}`;
  const initial = kind === 'terminal' ? 'terminal' : 'original';
  const [tab, setTab] = useState(initial);
  const [visited, setVisited] = useState<Set<string>>(() => new Set([initial]));
  const select = (next: string) => {
    setVisited((old) => new Set(old).add(next));
    setTab(next);
  };
  useEffect(() => {
    const forced = forcedActivityTab({
      kind,
      selection,
      showDebug,
      hasSourceRequest: !!debugSourceRequest,
    });
    if (forced) select(forced);
    // The current tab is intentionally not a dependency: after a debug-file
    // request the person can still open tasks or the activity list.
  }, [kind, selection, debugSourceRequest?.id, showDebug]);
  useEffect(() => {
    const next = activityTabWhenDebugHidden(kind, showDebug, tab);
    if (next) select(next);
  }, [kind, showDebug, tab]);
  const tabs =
    kind === 'terminal'
      ? [
          { id: 'terminal', label: t('terminal') },
          { id: 'original', label: t('command history') },
        ]
      : kind === 'changes'
        ? [
            { id: 'original', label: t('session changes') },
            { id: 'git', label: t('git') },
            { id: 'delivery', label: t('automatic delivery') },
          ]
        : [
            { id: 'original', label: t('activity') },
            { id: 'tasks', label: t('tasks') },
            ...(showDebug ? [{ id: 'debug', label: t('debug') }] : []),
          ];
  const openExternal = (url: string) => {
    try {
      const target = new URL(url);
      if (
        target.protocol !== 'https:' ||
        target.hostname !== 'github.com' ||
        target.username ||
        target.password
      )
        throw Error(t('external link is not allowed'));
      const host = desktopHost();
      if (host?.openExternal)
        void host.openExternal(target.href).catch((e) => notify(String(e)));
      else window.open(target.href, '_blank', 'noopener,noreferrer');
    } catch (e) {
      notify(String(e));
    }
  };
  const resourceName =
    workspaceRoot ??
    snapshot.sessions.find((item) => item.id === sessionId)?.title ??
    '';
  return (
    <div className={`workspace-panel-contents workspace-panel-${kind}`}>
      {resourcesPaused && kind === 'changes' && (
        <p
          className="panel-note"
          role="status"
          style={{ overflowWrap: 'anywhere' }}
        >
          {t(
            'Resources belong to {name}. Start a conversation in the selected project to make changes.',
            { name: resourceName },
          )}
        </p>
      )}
      <div
        className="segmented workspace-resource-tabs"
        role="tablist"
        aria-label={
          kind === 'changes'
            ? t('changes')
            : kind === 'activity'
              ? t('activity')
              : t('terminal')
        }
      >
        {tabs.map((item, index) => (
          <button
            key={item.id}
            id={panelId(`tab-${item.id}`)}
            role="tab"
            className={tab === item.id ? 'active' : ''}
            aria-selected={tab === item.id}
            aria-controls={panelId(item.id)}
            aria-label={item.label}
            title={item.label}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => select(item.id)}
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
                return;
              e.preventDefault();
              const next =
                tabs[
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? tabs.length - 1
                      : (index +
                          (e.key === 'ArrowRight' ? 1 : -1) +
                          tabs.length) %
                        tabs.length
                ]!;
              select(next.id);
              document.getElementById(panelId(`tab-${next.id}`))?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <fieldset
        disabled={resourcesPaused && kind === 'changes'}
        style={{ display: 'contents' }}
      >
        <Suspense
          fallback={<p role="status">{t('loading developer tools…')}</p>}
        >
          {tabs
            .filter((item) => visited.has(item.id))
            .map((item) => (
              <div
                key={item.id}
                id={panelId(item.id)}
                role="tabpanel"
                aria-labelledby={panelId(`tab-${item.id}`)}
                className="inspector-resource-view"
                hidden={tab !== item.id}
              >
                <NativeResourceBoundary name={item.label} resetKey={sessionId}>
                  {item.id === 'original' ? (
                    children
                  ) : item.id === 'terminal' ? (
                    <NativeTerminal
                      embedded
                      sessionId={sessionId}
                      commandTerminal={commandTerminal}
                      focusRequest={terminalFocusRequest}
                      onExitCommandTerminal={onExitCommandTerminal}
                      active={visible && tab === 'terminal'}
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
                  ) : item.id === 'git' ? (
                    <GitPanel
                      sessionId={sessionId}
                      embedded
                      onFile={onFile}
                      onOpenExternal={openExternal}
                    />
                  ) : item.id === 'debug' ? (
                    <DebugPanel
                      sourceRequest={debugSourceRequest}
                      workspaceRoot={workspaceRoot}
                      onOpenTerminal={onOpenTerminal}
                      sessionId={sessionId}
                      embedded
                      onFile={onFile}
                    />
                  ) : item.id === 'tasks' ? (
                    <TasksPanel
                      embedded
                      sessionId={sessionId}
                      onSession={onSession}
                      focusTaskId={
                        selection.startsWith('task:')
                          ? selection.slice(5)
                          : undefined
                      }
                    />
                  ) : (
                    <DeliveryCyclePanel
                      sessionId={sessionId}
                      active={visible && tab === 'delivery'}
                      onTask={onTask}
                      onOpenExternal={openExternal}
                    />
                  )}
                </NativeResourceBoundary>
              </div>
            ))}
        </Suspense>
      </fieldset>
    </div>
  );
}
