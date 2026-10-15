import { desktopHost, openNativeWorkspace } from '../host';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  Settings2,
  Blocks,
  Plug,
  BookOpen,
  Command,
  ShieldCheck,
  MessagesSquare,
  Terminal,
  FolderPlus,
  SlidersHorizontal,
} from 'lucide-react';
import { useRuntime } from '../app/context';
import { usePlugins } from '../plugins/context';
import { currentSession, sessionListed, sessionTitle } from '../model/state';
import { workspaceLabel } from '../model/workspace-label';
import type { DialogId } from '../model/types';
import { IconButton } from './common';
import { t } from '../i18n';
import { UpdateChip } from '../features/Update';
import { SessionMenu, WorkspaceMenu } from './SessionMenus';
// The labels are functions so they follow the interface language when it changes.
export const NAVIGATION = [
  { id: 'models', label: () => t('models'), icon: Blocks },
  { id: 'skills', label: () => t('skills'), icon: BookOpen },
  { id: 'commands', label: () => t('commands'), icon: Command },
  { id: 'mcp', label: () => t('mcp servers'), icon: Plug },
  { id: 'extensions', label: () => t('extensions'), icon: Blocks },
  { id: 'tools', label: () => t('tools'), icon: Terminal },
  { id: 'approvals', label: () => t('approvals'), icon: ShieldCheck },
  { id: 'settings', label: () => t('settings'), icon: Settings2 },
] as const;
/** The pages under customize, as Claude gathers skills, connectors and tools. */
export const CUSTOMIZE = [
  'skills',
  'commands',
  'mcp',
  'extensions',
  'tools',
  'approvals',
] as const;
const SHOWN = 8;

function RenameField({
  label,
  defaultValue,
  onCommit,
  onCancel,
}: {
  label: string;
  defaultValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const selectAll = () => {
      input.focus();
      input.setSelectionRange(0, input.value.length);
      input.scrollLeft = 0;
    };
    selectAll();
    const frame = requestAnimationFrame(selectAll);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <input
      ref={ref}
      className="session-rename"
      aria-label={label}
      defaultValue={defaultValue}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          onCommit(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={(event) => onCommit(event.currentTarget.value)}
    />
  );
}

export function Sidebar({
  onSearch,
  onNavigate,
  onDialog,
}: {
  onSearch: () => void;
  onNavigate?: () => void;
  onDialog?: (dialog: DialogId, selection?: string) => void;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  // The pages of the extensions that are on, such as hub's
  const { registry, enabled } = usePlugins();
  const pluginPages = registry.pages(enabled);
  const navigate = useNavigate();
  const location = useLocation();
  const current = currentSession(snapshot);
  const [all, setAll] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameDone = useRef(false);
  const beginRename = (id: string) => {
    renameDone.current = false;
    setRenaming(id);
  };
  const commitRename = (sessionId: string, value: string, previous: string) => {
    if (renameDone.current) return;
    renameDone.current = true;
    setRenaming(null);
    const title = value.trim();
    if (!title || title === previous) return;
    perform(() =>
      runtime.change((state) => {
        const target = state.sessions.find((item) => item.id === sessionId);
        if (target) target.title = title;
      }),
    );
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'F2' || event.ctrlKey || event.metaKey || event.altKey)
        return;
      if (document.querySelector('[role="dialog"]')) return;
      if (document.documentElement.dataset.keyCapture) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      )
        return;
      event.preventDefault();
      beginRename(snapshot.activeSessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapshot.activeSessionId]);
  const goSession = async (id: string) => {
    await runtime.selectSession(id);
    navigate(`/session/${id}`);
    onNavigate?.();
  };
  const newSession = (workspaceId?: string) =>
    perform(async () => {
      const id = await runtime.newSession(workspaceId);
      navigate(`/session/${id}`);
      onNavigate?.();
    });
  // The open folder first, then the others by their latest session.
  const latest = (id: string) =>
    snapshot.sessions
      .filter((session) => session.workspaceId === id)
      .reduce(
        (value, session) => Math.max(value, Date.parse(session.updatedAt) || 0),
        0,
      );
  const projects = snapshot.workspaces
    .filter((workspace) =>
      snapshot.sessions.some(
        (session) =>
          session.workspaceId === workspace.id && !session.archivedAt,
      ),
    )
    .sort((a, b) =>
      a.id === current.workspaceId
        ? -1
        : b.id === current.workspaceId
          ? 1
          : latest(b.id) - latest(a.id),
    );
  const waiting = new Set(
    snapshot.interactions
      .filter((item) => item.status === 'pending')
      .map((item) => item.sessionId),
  );
  const customizing = CUSTOMIZE.some(
    (id) => location.pathname === '/page/' + id,
  );
  const connection =
    runtime.mode !== 'live'
      ? 'preview'
      : !snapshot.runtime?.connected
        ? 'stopped'
        : snapshot.runtime.configured
          ? 'ready'
          : 'not-configured';
  return (
    <aside className="sidebar">
      <header className="brand">
        <span className="circle-logo" />
        <strong>circle</strong>
      </header>
      <button className="sidebar-search" onClick={onSearch}>
        <Search size={14} />
        <span>{t('search')}</span>
      </button>
      <nav className="sidebar-primary">
        <button className="sidebar-item" onClick={() => newSession()}>
          <Plus size={15} />
          <span>{t('new session')}</span>
        </button>
        <NavLink
          to="/page/skills"
          className={customizing ? 'sidebar-item active' : 'sidebar-item'}
          onClick={onNavigate}
        >
          <SlidersHorizontal size={15} />
          <span>{t('customize')}</span>
        </NavLink>
        <NavLink
          to="/page/sessions"
          className={({ isActive }) =>
            isActive ? 'sidebar-item active' : 'sidebar-item'
          }
          onClick={onNavigate}
        >
          <MessagesSquare size={15} />
          <span>{t('all sessions')}</span>
        </NavLink>
      </nav>
      {pluginPages.length > 0 && (
        <nav className="sidebar-primary" aria-label={t('platform')}>
          <div className="section-label">
            <span>{t('platform')}</span>
          </div>
          {pluginPages.map(({ page }) => (
            <NavLink
              key={page.id}
              to={`/page/${page.id}`}
              className={({ isActive }) =>
                isActive ? 'sidebar-item active' : 'sidebar-item'
              }
              onClick={onNavigate}
            >
              <page.icon size={15} />
              <span>{page.title}</span>
            </NavLink>
          ))}
        </nav>
      )}
      <div className="project-list">
        {projects.map((workspace) => {
          const sessions = snapshot.sessions
            .filter(
              (session) =>
                session.workspaceId === workspace.id &&
                !session.archivedAt &&
                sessionListed(session),
            )
            .sort(
              (a, b) =>
                Number(b.pinned) - Number(a.pinned) ||
                (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
            );
          const open = all.includes(workspace.id);
          return (
            <section className="project" key={workspace.id}>
              <div className="project-header" title={workspace.path}>
                <button
                  className="project-name"
                  aria-expanded={!collapsed.includes(workspace.id)}
                  onClick={() =>
                    setCollapsed((ids) =>
                      ids.includes(workspace.id)
                        ? ids.filter((id) => id !== workspace.id)
                        : [...ids, workspace.id],
                    )
                  }
                >
                  {workspaceLabel(workspace)}
                </button>
                <div className="project-actions">
                  <IconButton
                    label={t('new session in {name}', {
                      name: workspaceLabel(workspace),
                    })}
                    onClick={() => newSession(workspace.id)}
                  >
                    <Plus size={13} />
                  </IconButton>
                  <WorkspaceMenu
                    workspace={workspace}
                    onNew={() => newSession(workspace.id)}
                    onCollapseAll={() =>
                      setCollapsed(projects.map((item) => item.id))
                    }
                  />
                </div>
              </div>
              {(collapsed.includes(workspace.id)
                ? []
                : open
                  ? sessions
                  : sessions.slice(0, SHOWN)
              ).map((session) => (
                <div className="session-row" key={session.id}>
                  {renaming === session.id ? (
                    <>
                      <RenameField
                        label={t('rename session')}
                        defaultValue={
                          session.title === 'new session' ? '' : session.title
                        }
                        onCommit={(value) =>
                          commitRename(session.id, value, session.title)
                        }
                        onCancel={() => {
                          renameDone.current = true;
                          setRenaming(null);
                        }}
                      />
                      <span className="session-menu-gap" aria-hidden="true" />
                    </>
                  ) : (
                    <NavLink
                      className={({ isActive }) =>
                        isActive ? 'session-link active' : 'session-link'
                      }
                      to={`/session/${session.id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        perform(async () => {
                          await goSession(session.id);
                        });
                      }}
                    >
                      <span>{sessionTitle(session.title)}</span>
                      {waiting.has(session.id) ? (
                        <i className="attention-dot" />
                      ) : session.state === 'waiting' ? (
                        <i className="running-dot" />
                      ) : null}
                    </NavLink>
                  )}
                  {renaming !== session.id && (
                    <SessionMenu
                      session={session}
                      onRename={() => beginRename(session.id)}
                      onDialog={(dialog, selection) =>
                        onDialog?.(dialog, selection)
                      }
                    />
                  )}
                </div>
              ))}
              {!collapsed.includes(workspace.id) && sessions.length > SHOWN && (
                <button
                  className="text-button show-more"
                  onClick={() =>
                    setAll(
                      open
                        ? all.filter((id) => id !== workspace.id)
                        : [...all, workspace.id],
                    )
                  }
                >
                  {open
                    ? t('show less')
                    : t('show {n} more', { n: sessions.length - SHOWN })}
                </button>
              )}
            </section>
          );
        })}
        {desktopHost() && (
          <button
            className="sidebar-item"
            onClick={async () => {
              try {
                const selected = await openNativeWorkspace(runtime);
                if (selected) {
                  navigate('/session/' + runtime.getSnapshot().activeSessionId);
                  onNavigate?.();
                }
              } catch (error) {
                notify(
                  error instanceof Error
                    ? error.message
                    : t('folder could not be opened'),
                );
              }
            }}
          >
            <FolderPlus size={15} />
            <span>{t('open folder')}</span>
          </button>
        )}
      </div>
      <UpdateChip />
      {snapshot.extensions.some((item) => item.status) && (
        <div className="extension-status" aria-label={t('extension status')}>
          {snapshot.extensions.map((item) =>
            item.status ? (
              <span
                key={item.id}
                className={`status extension-lamp-${item.status.lamp}`}
                title={item.name}
              >
                <i />
                {item.status.text}
              </span>
            ) : null,
          )}
        </div>
      )}
      <footer className="sidebar-footer">
        <button
          className="connection-status"
          data-state={connection}
          onClick={() => {
            if (connection === 'ready') navigate('/page/models');
            else onDialog?.(connection === 'preview' ? 'preview' : 'connect');
            onNavigate?.();
          }}
        >
          <i />
          <span>
            {connection === 'preview'
              ? 'frontend preview'
              : connection === 'stopped'
                ? t('runtime stopped')
                : connection === 'not-configured'
                  ? t('connect a model')
                  : current.model}
          </span>
        </button>
        <IconButton
          label={t('settings')}
          onClick={() => {
            navigate('/page/settings');
            onNavigate?.();
          }}
        >
          <Settings2 size={15} />
        </IconButton>
      </footer>
    </aside>
  );
}
