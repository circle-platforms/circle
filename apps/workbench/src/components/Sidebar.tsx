import { desktopHost, folderOpenMessage, openNativeWorkspace } from '../host';
import { openHome } from '../features/home-selection';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useMatch, useNavigate } from 'react-router-dom';
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
import { Tooltip } from 'radix-ui';
import { useRuntime } from '../app/context';
import { usePlugins } from '../plugins/context';
import { currentSession, sessionTitle } from '../model/state';
import {
  recentDetails,
  recentSessions,
  sidebarProjects,
  visibleSessions,
} from '../model/session-management';
import type { DialogId, Session } from '../model/types';
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
/** Collapse state for the recent list. It is not a workspace id. */
const RECENT = 'recent';

export function Sidebar({
  onSearch,
  onNavigate,
  onDialog,
  renaming = false,
}: {
  onSearch: () => void;
  onNavigate?: () => void;
  onDialog?: (dialog: DialogId, selection?: string) => void;
  /** The rename dialog is open, so a recent hover must not stay up over it. */
  renaming?: boolean;
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
  const goSession = async (id: string) => {
    await runtime.selectSession(id);
    navigate(`/session/${id}`);
    onNavigate?.();
  };
  const newSession = (workspaceId?: string) => {
    openHome(navigate, `${location.pathname}${location.search}`, workspaceId);
    onNavigate?.();
  };
  // The open folder first, then the others by their latest session.
  const latest = (id: string) =>
    snapshot.sessions
      .filter((session) => session.workspaceId === id)
      .reduce(
        (value, session) => Math.max(value, Date.parse(session.updatedAt) || 0),
        0,
      );
  const projects = sidebarProjects(snapshot.workspaces, snapshot.sessions).sort(
    (a, b) =>
      a.id === current.workspaceId
        ? -1
        : b.id === current.workspaceId
          ? 1
          : latest(b.id) - latest(a.id),
  );
  const recent = recentSessions(snapshot.sessions);
  const waiting = new Set(
    snapshot.interactions
      .filter((item) => item.status === 'pending')
      .map((item) => item.sessionId),
  );
  const toggle = (id: string, list: string[], set: (ids: string[]) => void) =>
    set(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  const sessionRows = (sessions: Session[], hover: boolean) =>
    sessions.map((session) => (
      <SessionRow
        key={session.id}
        session={session}
        details={
          hover ? recentDetails(session, snapshot.workspaces) : undefined
        }
        renaming={renaming}
        attention={waiting.has(session.id)}
        running={session.state === 'waiting'}
        onOpen={(id) => {
          perform(async () => {
            await goSession(id);
          });
        }}
        onDialog={onDialog}
      />
    ));
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
        {recent.length > 0 && (
          <section className="project">
            <div className="project-header">
              <button
                className="project-name"
                aria-expanded={!collapsed.includes(RECENT)}
                onClick={() => toggle(RECENT, collapsed, setCollapsed)}
              >
                {t('recent')}
              </button>
            </div>
            {sessionRows(
              collapsed.includes(RECENT)
                ? []
                : all.includes(RECENT)
                  ? recent
                  : recent.slice(0, SHOWN),
              true,
            )}
            {!collapsed.includes(RECENT) && recent.length > SHOWN && (
              <button
                className="text-button show-more"
                onClick={() => toggle(RECENT, all, setAll)}
              >
                {all.includes(RECENT)
                  ? t('show less')
                  : t('show {n} more', { n: recent.length - SHOWN })}
              </button>
            )}
          </section>
        )}
        {projects.map((workspace) => {
          const sessions = visibleSessions(snapshot.sessions)
            .filter(
              (session) =>
                session.workspaceId === workspace.id && !session.archivedAt,
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
                  onClick={() => toggle(workspace.id, collapsed, setCollapsed)}
                >
                  {workspace.name}
                </button>
                <div className="project-actions">
                  <IconButton
                    label={t('new session in {name}', { name: workspace.name })}
                    onClick={() => newSession(workspace.id)}
                  >
                    <Plus size={13} />
                  </IconButton>
                  <WorkspaceMenu
                    workspace={workspace}
                    onNew={() => newSession(workspace.id)}
                    onCollapseAll={() =>
                      setCollapsed([
                        ...(recent.length > 0 ? [RECENT] : []),
                        ...projects.map((item) => item.id),
                      ])
                    }
                  />
                </div>
              </div>
              {sessionRows(
                collapsed.includes(workspace.id)
                  ? []
                  : open
                    ? sessions
                    : sessions.slice(0, SHOWN),
                false,
              )}
              {!collapsed.includes(workspace.id) && sessions.length > SHOWN && (
                <button
                  className="text-button show-more"
                  onClick={() => toggle(workspace.id, all, setAll)}
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
                  openHome(
                    navigate,
                    `${location.pathname}${location.search}`,
                    selected,
                  );
                  onNavigate?.();
                }
              } catch (error) {
                notify(folderOpenMessage(error));
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

function SessionRow({
  session,
  details,
  renaming,
  attention,
  running,
  onOpen,
  onDialog,
}: {
  session: Session;
  details?: { project?: string; relative: string; absolute?: string };
  renaming: boolean;
  attention: boolean;
  running: boolean;
  onOpen: (id: string) => void;
  onDialog?: (dialog: DialogId, selection?: string) => void;
}) {
  // A function class would be stringified by the tooltip trigger, so the
  // active row would lose its highlight. The same path is used in a project
  // group, and both rows highlight together.
  const active = useMatch({ path: `/session/${session.id}`, end: true });
  const link = (
    <NavLink
      className={active ? 'session-link active' : 'session-link'}
      end
      to={`/session/${session.id}`}
      onClick={(event) => {
        event.preventDefault();
        onOpen(session.id);
      }}
    >
      <span>{sessionTitle(session.title)}</span>
      {attention ? (
        <i className="attention-dot" />
      ) : running ? (
        <i className="running-dot" />
      ) : null}
    </NavLink>
  );
  return (
    <div className="session-row">
      {details ? (
        <RecentHover details={details} suppressed={renaming}>
          {link}
        </RecentHover>
      ) : (
        link
      )}
      <SessionMenu
        session={session}
        onDialog={(dialog, selection) => onDialog?.(dialog, selection)}
      />
    </div>
  );
}

function RecentHover({
  details,
  suppressed,
  children,
}: {
  details: { project?: string; relative: string; absolute?: string };
  suppressed: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (suppressed) setOpen(false);
  }, [suppressed]);
  return (
    <Tooltip.Root
      open={suppressed ? false : open}
      onOpenChange={(next) => {
        if (!suppressed) setOpen(next);
      }}
      disableHoverableContent
    >
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="tooltip session-hover"
          side="right"
          sideOffset={8}
        >
          {details.project ? <span>{details.project}</span> : null}
          <span>{t('updated {time}', { time: details.relative })}</span>
          {details.absolute ? <span>{details.absolute}</span> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
