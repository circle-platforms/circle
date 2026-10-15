import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import { NativeResourceBoundary } from '../components/NativeResourceBoundary';
import { DeliveryCyclePanel } from './DeliveryCyclePanel';
import { TasksPanel } from './TasksPanel';
import '../styles/developer-workbench.css';
const NativeTerminal = lazy(() =>
  import('../components/NativeTerminal').then((module) => ({
    default: module.NativeTerminal,
  })),
);
const GitPanel = lazy(() =>
  import('../components/GitPanel').then((module) => ({
    default: module.GitPanel,
  })),
);
const DebugPanel = lazy(() =>
  import('../components/DebugPanel').then((module) => ({
    default: module.DebugPanel,
  })),
);
export type WorkbenchLayout = 'task' | 'developer';
export type DeveloperDock = 'terminal' | 'git' | 'debug' | 'tasks' | 'delivery';
type Dock = DeveloperDock;
const dockLabels = {
  terminal: () => t('terminal'),
  git: () => t('git workspace'),
  debug: () => t('debug'),
  tasks: () => t('collaboration tasks'),
  delivery: () => t('automatic delivery'),
};

/** Layout changes move CSS grid areas; live surfaces retain the same React identity. */
export function DeveloperWorkbench({
  layout,
  sessionId,
  conversation,
  editor,
  onFile,
  onSession,
  openDock,
}: {
  layout: WorkbenchLayout;
  sessionId: string;
  conversation: ReactNode;
  editor: ReactNode;
  onFile: (path: string, line?: number, column?: number) => void;
  onSession: (id: string) => void;
  openDock?: { dock: DeveloperDock; id: number };
}) {
  const { notify } = useRuntime();
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
      if (
        host &&
        'openExternal' in host &&
        typeof host.openExternal === 'function'
      )
        void Promise.resolve(host.openExternal(target.href)).catch((error) =>
          notify(String(error)),
        );
      else window.open(target.href, '_blank', 'noopener,noreferrer');
    } catch (error) {
      notify(String(error));
    }
  };
  const [dock, setDock] = useState<Dock>('terminal');
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState<Set<Dock>>(new Set());
  const [focusTask, setFocusTask] = useState<string>();
  const [mobile, setMobile] = useState<'conversation' | 'editor'>(
    'conversation',
  );
  const select = (next: Dock) => {
    setVisited((previous) => new Set(previous).add(next));
    setDock(next);
    setOpen(true);
  };
  useEffect(() => {
    if (openDock) select(openDock.dock);
  }, [openDock?.id]);
  return (
    <section
      className="developer-workbench"
      data-layout={layout}
      data-editor={!!editor}
      data-mobile={mobile}
      data-dock-open={open}
    >
      <div className="workbench-mobile-tabs">
        <button onClick={() => setMobile('conversation')}>
          {t('conversation')}
        </button>
        <button onClick={() => setMobile('editor')}>{t('editor')}</button>
      </div>
      <div className="developer-conversation">
        <NativeResourceBoundary name={t('conversation')}>
          {conversation}
        </NativeResourceBoundary>
      </div>
      <div className="developer-editor">
        <NativeResourceBoundary name={t('editor')}>
          {editor ?? (
            <div className="empty-state">
              <h3>{t('open a file to start editing')}</h3>
              <p>
                {t('use quick open or choose a source in the conversation')}
              </p>
            </div>
          )}
        </NativeResourceBoundary>
      </div>
      <div className="developer-dock">
        <div
          className="developer-dock-tabs"
          role="tablist"
          aria-label={t('developer tools')}
        >
          {(Object.keys(dockLabels) as Dock[]).map((item) => (
            <button
              id={`dock-tab-${item}`}
              role="tab"
              key={item}
              aria-selected={open && dock === item}
              aria-controls={`dock-${item}`}
              tabIndex={dock === item ? 0 : -1}
              onKeyDown={(event) => {
                if (
                  !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const tabs = Object.keys(dockLabels) as Dock[];
                const index =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : (tabs.indexOf(item) +
                          (event.key === 'ArrowRight' ? 1 : -1) +
                          tabs.length) %
                        tabs.length;
                const next = tabs[index]!;
                select(next);
                document.getElementById(`dock-tab-${next}`)?.focus();
              }}
              onClick={() => select(item)}
            >
              {dockLabels[item]()}
            </button>
          ))}
          <button
            className="dock-toggle"
            onClick={() => {
              if (!open) select(dock);
              else setOpen(false);
            }}
            aria-expanded={open}
          >
            {open ? t('hide tools') : t('show tools')}
          </button>
        </div>
        <div className="developer-dock-body" hidden={!open}>
          <Suspense
            fallback={<p role="status">{t('loading developer tools…')}</p>}
          >
            {visited.has('terminal') && (
              <div
                id="dock-terminal"
                role="tabpanel"
                aria-labelledby="dock-tab-terminal"
                hidden={dock !== 'terminal'}
              >
                <NativeResourceBoundary name={t('terminal')}>
                  <NativeTerminal
                    sessionId={sessionId}
                    active={open && dock === 'terminal'}
                  />
                </NativeResourceBoundary>
              </div>
            )}
            {visited.has('git') && (
              <div
                id="dock-git"
                role="tabpanel"
                aria-labelledby="dock-tab-git"
                hidden={dock !== 'git'}
              >
                <NativeResourceBoundary name={t('git workspace')}>
                  <GitPanel
                    sessionId={sessionId}
                    onFile={onFile}
                    onOpenExternal={openExternal}
                  />
                </NativeResourceBoundary>
              </div>
            )}
            {visited.has('debug') && (
              <div
                id="dock-debug"
                role="tabpanel"
                aria-labelledby="dock-tab-debug"
                hidden={dock !== 'debug'}
              >
                <NativeResourceBoundary name={t('debug')}>
                  <DebugPanel sessionId={sessionId} onFile={onFile} />
                </NativeResourceBoundary>
              </div>
            )}
            {visited.has('delivery') && (
              <div
                id="dock-delivery"
                role="tabpanel"
                aria-labelledby="dock-tab-delivery"
                hidden={dock !== 'delivery'}
              >
                <NativeResourceBoundary name={t('automatic delivery')}>
                  <DeliveryCyclePanel
                    sessionId={sessionId}
                    active={open && dock === 'delivery'}
                    onOpenExternal={openExternal}
                    onTask={(id) => {
                      setFocusTask(id);
                      select('tasks');
                    }}
                  />
                </NativeResourceBoundary>
              </div>
            )}
            {visited.has('tasks') && (
              <div
                id="dock-tasks"
                role="tabpanel"
                aria-labelledby="dock-tab-tasks"
                hidden={dock !== 'tasks'}
              >
                <NativeResourceBoundary name={t('collaboration tasks')}>
                  <TasksPanel
                    sessionId={sessionId}
                    onSession={onSession}
                    focusTaskId={focusTask}
                  />
                </NativeResourceBoundary>
              </div>
            )}
          </Suspense>
        </div>
      </div>
    </section>
  );
}
