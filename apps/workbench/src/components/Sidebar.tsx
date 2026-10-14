import { desktopHost, openNativeWorkspace } from '../host';
import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { DropdownMenu } from 'radix-ui';
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
  MoreHorizontal,
} from 'lucide-react';
import { useRuntime } from '../app/context';
import { usePlugins } from '../plugins/context';
import { currentSession, sessionTitle } from '../model/state';
import type { DialogId, PanelId } from '../model/types';
import { IconButton } from './common';
import { t } from '../i18n';
import { UpdateChip } from '../features/Update';
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

export function Sidebar({
  onSearch,
  onNavigate,
  onDialog,
  onPanel,
}: {
  onSearch: () => void;
  onNavigate?: () => void;
  onDialog?: (dialog: DialogId, choice?: string) => void;
  onPanel?: (panel: PanelId) => void;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  // The pages of the extensions that are on, such as circle-server's
  const { registry, enabled } = usePlugins();
  const pluginPages = registry.pages(enabled);
  const navigate = useNavigate();
  const location = useLocation();
  const current = currentSession(snapshot);
  const [all, setAll] = useState<string[]>([]);
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
  const projects = [...snapshot.workspaces].sort((a, b) =>
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
            .filter((session) => session.workspaceId === workspace.id)
            .sort(
              (a, b) =>
                Number(b.pinned) - Number(a.pinned) ||
                (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
            );
          const open = all.includes(workspace.id);
          return (
            <section className="project" key={workspace.id}>
              <div className="project-header" title={workspace.path}>
                <span>{workspace.name}</span>
                <IconButton
                  label={t('new session in {name}', { name: workspace.name })}
                  onClick={() => newSession(workspace.id)}
                >
                  <Plus size={13} />
                </IconButton>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="icon-button"
                      aria-label={t('more {name}', { name: workspace.name })}
                    >
                      <MoreHorizontal size={13} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="dropdown"
                      align="start"
                      sideOffset={4}
                    >
                      <DropdownMenu.Item
                        onSelect={() => newSession(workspace.id)}
                      >
                        {t('new session in {name}', { name: workspace.name })}
                      </DropdownMenu.Item>
                      {desktopHost() && (
                        <DropdownMenu.Item
                          onSelect={() =>
                            void perform(async () => {
                              await desktopHost()?.revealWorkspace(
                                workspace.id,
                              );
                            })
                          }
                        >
                          {t('show in folder')}
                        </DropdownMenu.Item>
                      )}
                      {!workspace.builtIn && (
                        <DropdownMenu.Item
                          onSelect={() =>
                            onDialog?.('delete-workspace', workspace.id)
                          }
                        >
                          {t('delete workspace')}
                        </DropdownMenu.Item>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
              {(open ? sessions : sessions.slice(0, SHOWN)).map((session) => (
                <div className="session-row" key={session.id}>
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
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        className="icon-button"
                        aria-label={t('more {title}', {
                          title: sessionTitle(session.title),
                        })}
                      >
                        <MoreHorizontal size={13} />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="dropdown"
                        align="start"
                        sideOffset={4}
                      >
                        <DropdownMenu.Item
                          onSelect={() =>
                            perform(() =>
                              runtime.change((state) => {
                                const target = state.sessions.find(
                                  (item) => item.id === session.id,
                                );
                                if (target) target.pinned = !target.pinned;
                              }),
                            )
                          }
                        >
                          {session.pinned ? t('unpin') : t('pin')}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelect={() =>
                            perform(async () => {
                              if (session.id !== current.id)
                                await goSession(session.id);
                              onPanel?.('files');
                            })
                          }
                        >
                          {t('show all files')}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelect={() => onDialog?.('rename', session.id)}
                        >
                          {t('rename')}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          disabled={session.id === current.id}
                          onSelect={() =>
                            onDialog?.('delete-session', session.id)
                          }
                        >
                          {t('delete')}
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              ))}
              {sessions.length > SHOWN && (
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
