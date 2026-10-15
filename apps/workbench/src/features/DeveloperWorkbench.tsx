import { lazy, Suspense, useState, type ReactNode } from 'react';
import { t } from '../i18n';
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
type Dock = 'terminal' | 'git' | 'debug' | 'tasks';
const dockLabels = {
  terminal: () => t('terminal'),
  git: () => t('git workspace'),
  debug: () => t('debug'),
  tasks: () => t('collaboration tasks'),
};

/** Layout changes move CSS grid areas; live surfaces retain the same React identity. */
export function DeveloperWorkbench({
  layout,
  sessionId,
  conversation,
  editor,
  onFile,
  onSession,
}: {
  layout: WorkbenchLayout;
  sessionId: string;
  conversation: ReactNode;
  editor: ReactNode;
  onFile: (path: string, line?: number, column?: number) => void;
  onSession: (id: string) => void;
}) {
  const [dock, setDock] = useState<Dock>('terminal');
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState<Set<Dock>>(new Set());
  const [mobile, setMobile] = useState<'conversation' | 'editor'>(
    'conversation',
  );
  const select = (next: Dock) => {
    setVisited((previous) => new Set(previous).add(next));
    setDock(next);
    setOpen(true);
  };
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
      <div className="developer-conversation">{conversation}</div>
      <div className="developer-editor">
        {editor ?? (
          <div className="empty-state">
            <h3>{t('open a file to start editing')}</h3>
            <p>{t('use quick open or choose a source in the conversation')}</p>
          </div>
        )}
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
                <NativeTerminal
                  sessionId={sessionId}
                  active={open && dock === 'terminal'}
                />
              </div>
            )}
            {visited.has('git') && (
              <div
                id="dock-git"
                role="tabpanel"
                aria-labelledby="dock-tab-git"
                hidden={dock !== 'git'}
              >
                <GitPanel sessionId={sessionId} onFile={onFile} />
              </div>
            )}
            {visited.has('debug') && (
              <div
                id="dock-debug"
                role="tabpanel"
                aria-labelledby="dock-tab-debug"
                hidden={dock !== 'debug'}
              >
                <DebugPanel sessionId={sessionId} onFile={onFile} />
              </div>
            )}
            {visited.has('tasks') && (
              <div
                id="dock-tasks"
                role="tabpanel"
                aria-labelledby="dock-tab-tasks"
                hidden={dock !== 'tasks'}
              >
                <TasksPanel sessionId={sessionId} onSession={onSession} />
              </div>
            )}
          </Suspense>
        </div>
      </div>
    </section>
  );
}
