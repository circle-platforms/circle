import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import { t } from '../i18n';
import { NativeResourceBoundary } from '../components/NativeResourceBoundary';
import { TasksPanel } from './TasksPanel';
import { DeliveryCyclePanel } from './DeliveryCyclePanel';
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
  sessionId,
  visible,
  selection,
  children,
  onFile,
  onSession,
  onTask,
}: {
  kind: 'terminal' | 'changes' | 'activity';
  sessionId: string;
  visible: boolean;
  selection: string;
  children: ReactNode;
  onFile: (path: string, line?: number, column?: number) => void;
  onSession: (id: string) => void;
  onTask: (id: string) => void;
}) {
  const { notify } = useRuntime();
  const initial = kind === 'terminal' ? 'terminal' : 'original';
  const [tab, setTab] = useState(initial);
  const [visited, setVisited] = useState<Set<string>>(() => new Set([initial]));
  const select = (next: string) => {
    setVisited((old) => new Set(old).add(next));
    setTab(next);
  };
  useEffect(() => {
    if (kind === 'activity' && selection.startsWith('task:')) select('tasks');
  }, [kind, selection]);
  const tabs =
    kind === 'terminal'
      ? [
          { id: 'terminal', label: t('terminal') },
          { id: 'original', label: t('history') },
        ]
      : kind === 'changes'
        ? [
            { id: 'original', label: t('session changes') },
            { id: 'git', label: t('git workspace') },
            { id: 'delivery', label: t('automatic delivery') },
          ]
        : [
            { id: 'original', label: t('activity') },
            { id: 'tasks', label: t('collaboration tasks') },
            { id: 'debug', label: t('debug') },
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
  return (
    <div className={`workspace-panel-contents workspace-panel-${kind}`}>
      <div
        className="segmented"
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
            id={`inspector-${kind}-tab-${item.id}`}
            role="tab"
            className={tab === item.id ? 'active' : ''}
            aria-selected={tab === item.id}
            aria-controls={`inspector-${kind}-${item.id}`}
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
              document
                .getElementById(`inspector-${kind}-tab-${next.id}`)
                ?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <Suspense fallback={<p role="status">{t('loading developer tools…')}</p>}>
        {tabs
          .filter((item) => visited.has(item.id))
          .map((item) => (
            <div
              key={item.id}
              id={`inspector-${kind}-${item.id}`}
              role="tabpanel"
              aria-labelledby={`inspector-${kind}-tab-${item.id}`}
              className="inspector-resource-view"
              hidden={tab !== item.id}
            >
              <NativeResourceBoundary name={item.label} resetKey={sessionId}>
                {item.id === 'original' ? (
                  children
                ) : item.id === 'terminal' ? (
                  <NativeTerminal
                    sessionId={sessionId}
                    active={visible && tab === 'terminal'}
                  />
                ) : item.id === 'git' ? (
                  <GitPanel
                    sessionId={sessionId}
                    embedded
                    onFile={onFile}
                    onOpenExternal={openExternal}
                  />
                ) : item.id === 'debug' ? (
                  <DebugPanel sessionId={sessionId} embedded onFile={onFile} />
                ) : item.id === 'tasks' ? (
                  <TasksPanel
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
    </div>
  );
}
