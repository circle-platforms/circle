import { desktopHost, folderOpenMessage, openNativeWorkspace } from '../host';
import { openHome } from '../features/home-selection';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
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
  orderedProjects,
  RECENT_SHOWN,
  recentDetails,
  recentSessions,
  sessionActivityAt,
  visibleSessions,
  type ActivityAge,
} from '../model/session-management';
import type { DialogId, Session } from '../model/types';
import { workspaceLabel } from '../model/workspace-label';
import { platformTitle } from '../plugins/labels';
import { armComposerFocus } from '../model/composer-focus';
import { IconButton } from './common';
import { t, tn } from '../i18n';
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
  const [roving, setRoving] = useState<string | null>(null);
  const anchors = useRef(new Map<string, HTMLAnchorElement>());
  const listRef = useRef<HTMLDivElement>(null);
  // The row at the top of the list, and how far it sits from that edge.
  const anchor = useRef<{ key: string; delta: number } | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [menuFocus, setMenuFocus] = useState<string | null>(null);
  const menuFocusRef = useRef<string | null>(null);
  // A scroll closes popups. They stay closed until the pointer actually moves,
  // so the scroll itself cannot pin a tip over the search box.
  const [scrollClosed, setScrollClosed] = useState(false);
  const scrollClosedRef = useRef(false);
  const pointerAtScroll = useRef<{ x: number; y: number } | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const ignoreScrollClose = useRef(false);
  // Only a real scroll (wheel, touch, or the scrollbar) dismisses a popup.
  // Focusing a row or opening a session can nudge scrollTop, and that must
  // not hide the card under a pointer that has not moved.
  const scrollGesture = useRef(false);
  const seenOrder = useRef<string | null>(null);
  // The row whose title is being edited in place (F2 or rename). A session can
  // be in recent and under its folder; only one of those rows becomes a field.
  const [editing, setEditing] = useState<string | null>(null);
  const editDone = useRef(false);
  const rowKeysRef = useRef<string[]>([]);
  const beginRename = (rowKey: string) => {
    editDone.current = false;
    setEditing(rowKey);
  };
  const commitRename = (sessionId: string, value: string, previous: string) => {
    if (editDone.current) return;
    editDone.current = true;
    setEditing(null);
    const title = value.trim();
    if (!title || title === previous) return;
    perform(() =>
      runtime.change((state) => {
        const target = state.sessions.find((item) => item.id === sessionId);
        if (target) target.title = title;
      }),
    );
  };
  const cancelRename = () => {
    editDone.current = true;
    setEditing(null);
  };
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
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
      const rowKey = rowKeysRef.current.find((key) =>
        key.endsWith(`:${snapshot.activeSessionId}`),
      );
      if (!rowKey) return;
      event.preventDefault();
      beginRename(rowKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapshot.activeSessionId]);
  const goSession = async (id: string) => {
    await runtime.selectSession(id);
    navigate(`/session/${id}`);
    onNavigate?.();
  };
  const newSession = (workspaceId?: string) => {
    // Before the route changes, while the click or the row still owns the
    // keyboard: keys typed during the switch land in the home composer.
    armComposerFocus();
    openHome(navigate, `${location.pathname}${location.search}`, workspaceId);
    onNavigate?.();
  };
  const activityAt = (session: Session) =>
    Date.parse(sessionActivityAt(session)) || 0;
  const projects = orderedProjects(snapshot.workspaces, snapshot.sessions);
  const recent = recentSessions(snapshot.sessions);
  const recentShown = collapsed.includes(RECENT)
    ? []
    : all.includes(RECENT)
      ? recent
      : recent.slice(0, RECENT_SHOWN);
  const groups = projects.map((workspace) => {
    const sessions = visibleSessions(snapshot.sessions)
      .filter(
        (session) =>
          session.workspaceId === workspace.id && !session.archivedAt,
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          activityAt(b) - activityAt(a) ||
          a.id.localeCompare(b.id),
      );
    const shown = collapsed.includes(workspace.id)
      ? []
      : all.includes(workspace.id)
        ? sessions
        : sessions.slice(0, SHOWN);
    return { workspace, sessions, shown };
  });
  const rowKeys = [
    ...recentShown.map((session) => `recent:${session.id}`),
    ...groups.flatMap((group) =>
      group.shown.map((session) => `${group.workspace.id}:${session.id}`),
    ),
  ];
  rowKeysRef.current = rowKeys;
  const orderKey = rowKeys.join('\n');
  // A new message moves rows. Keep the row that was at the top of the view there.
  // Hovering must not run this: a scroll event would close the card that just opened.
  useLayoutEffect(() => {
    const focused = menuFocusRef.current;
    if (focused && !rowKeys.includes(focused)) {
      menuFocusRef.current = null;
      setMenuFocus(null);
    }
    const list = listRef.current;
    const previous = seenOrder.current;
    seenOrder.current = orderKey;
    const saved = anchor.current;
    if (previous === null || previous === orderKey || !list || !saved) return;
    const row = [...list.querySelectorAll<HTMLElement>('[data-row-key]')].find(
      (item) => item.dataset.rowKey === saved.key,
    );
    if (!row) return;
    const delta =
      row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const error = delta - saved.delta;
    if (Math.abs(error) > 1) list.scrollTop += error;
    anchor.current = listAnchor(list);
  });
  const tabKey =
    roving && rowKeys.includes(roving)
      ? roving
      : (rowKeys.find((key) => key === `recent:${current.id}`) ??
        rowKeys.find((key) => key.endsWith(`:${current.id}`)) ??
        rowKeys[0]);
  const onRowKeyDown = (
    rowKey: string,
    event: KeyboardEvent<HTMLAnchorElement>,
  ) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const next =
      rowKeys[rowKeys.indexOf(rowKey) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    setRoving(next);
    revealRow(next);
  };
  const revealRow = (key: string) => {
    const link = anchors.current.get(key);
    const list = listRef.current;
    link?.focus({ preventScroll: true });
    if (!link || !list) return;
    const row = link.closest('.session-row') ?? link;
    const rowBox = row.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    ignoreScrollClose.current = true;
    if (rowBox.top < listBox.top) list.scrollTop -= listBox.top - rowBox.top;
    else if (rowBox.bottom > listBox.bottom)
      list.scrollTop += rowBox.bottom - listBox.bottom;
    ignoreScrollClose.current = false;
    anchor.current = listAnchor(list);
  };
  const pointRow = (key: string, point: { x: number; y: number }) => {
    lastPointer.current = point;
    const origin = pointerAtScroll.current;
    if (scrollClosedRef.current && origin) {
      const moved = Math.hypot(point.x - origin.x, point.y - origin.y);
      if (moved < 4) return;
    }
    pointerAtScroll.current = null;
    scrollClosedRef.current = false;
    setScrollClosed(false);
    setHoveredKey(key);
  };
  const leaveRow = (key: string) => {
    setHoveredKey((current) => (current === key ? null : current));
  };
  const claimMenu = (key: string | null) => {
    menuFocusRef.current = key;
    setMenuFocus(key);
    if (!key) return;
    // Focus takes ownership from a pointer resting over a different row.
    // A later pointer movement can still hand the popup back to that row.
    setHoveredKey(null);
    pointerAtScroll.current = null;
    scrollClosedRef.current = false;
    setScrollClosed(false);
  };
  // The pointer is still on a row after a click. Put that row's card back if
  // the click's render dropped it.
  const keepHover = () => {
    requestAnimationFrame(() => {
      const point = lastPointer.current;
      if (!point || menuFocusRef.current) return;
      const hit = document.elementFromPoint(point.x, point.y);
      const key =
        hit instanceof Element
          ? hit.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey
          : undefined;
      if (!key) return;
      pointerAtScroll.current = null;
      scrollClosedRef.current = false;
      setScrollClosed(false);
      setHoveredKey(key);
    });
  };
  const waiting = new Set(
    snapshot.interactions
      .filter((item) => item.status === 'pending')
      .map((item) => item.sessionId),
  );
  const toggle = (id: string, list: string[], set: (ids: string[]) => void) =>
    set(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  const sessionRows = (sessions: Session[], prefix: string) =>
    sessions.map((session) => {
      const rowKey = `${prefix}:${session.id}`;
      return (
        <SessionRow
          key={rowKey}
          rowKey={rowKey}
          session={session}
          tabIndex={rowKey === tabKey ? 0 : -1}
          details={recentDetails(session, snapshot.workspaces)}
          renaming={renaming}
          editing={editing === rowKey}
          onRename={() => beginRename(rowKey)}
          onRenameCommit={(value) =>
            commitRename(session.id, value, session.title)
          }
          onRenameCancel={cancelRename}
          attention={waiting.has(session.id)}
          running={session.state === 'waiting'}
          onOpen={(id) => {
            perform(async () => {
              await goSession(id);
            });
          }}
          onKeyDown={(event) => onRowKeyDown(rowKey, event)}
          onFocusRow={() => setRoving(rowKey)}
          hovered={hoveredKey === rowKey}
          hoveredKey={hoveredKey}
          menuFocus={menuFocus}
          scrollClosed={scrollClosed}
          listRef={listRef}
          onPoint={(point) => pointRow(rowKey, point)}
          onPointerLeave={() => leaveRow(rowKey)}
          onMenuFocus={claimMenu}
          onKeepHover={keepHover}
          linkRef={(node) => {
            if (node) anchors.current.set(rowKey, node);
            else anchors.current.delete(rowKey);
          }}
          onDialog={onDialog}
        />
      );
    });
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
              <span>{platformTitle(page.id, page.title)}</span>
            </NavLink>
          ))}
        </nav>
      )}
      <div
        className="project-list"
        ref={listRef}
        onPointerMove={(event) => {
          lastPointer.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget)
            scrollGesture.current = true;
        }}
        onWheel={() => {
          scrollGesture.current = true;
        }}
        onTouchMove={() => {
          scrollGesture.current = true;
        }}
        onScroll={(event) => {
          anchor.current = listAnchor(event.currentTarget);
          if (
            ignoreScrollClose.current ||
            !scrollGesture.current ||
            scrollClosedRef.current
          )
            return;
          scrollGesture.current = false;
          pointerAtScroll.current = lastPointer.current;
          scrollClosedRef.current = true;
          setScrollClosed(true);
          setHoveredKey(null);
        }}
      >
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
            {sessionRows(recentShown, RECENT)}
            {!collapsed.includes(RECENT) && recent.length > RECENT_SHOWN && (
              <button
                className="text-button show-more"
                onClick={() => toggle(RECENT, all, setAll)}
              >
                {all.includes(RECENT)
                  ? t('show less')
                  : t('show {n} more', { n: recent.length - RECENT_SHOWN })}
              </button>
            )}
          </section>
        )}
        {groups.map(({ workspace, sessions, shown }) => {
          const open = all.includes(workspace.id);
          return (
            <section className="project" key={workspace.id}>
              <div
                className="project-header"
                title={workspace.path}
                onPointerMove={(event) =>
                  pointRow('header', { x: event.clientX, y: event.clientY })
                }
                onPointerLeave={() => leaveRow('header')}
              >
                <button
                  className="project-name"
                  aria-expanded={!collapsed.includes(workspace.id)}
                  onClick={() => toggle(workspace.id, collapsed, setCollapsed)}
                >
                  {workspaceLabel(workspace)}
                </button>
                <div className="project-actions">
                  <IconButton
                    label={t('new session in {name}', {
                      name: workspaceLabel(workspace),
                    })}
                    tipOpen={scrollClosed ? false : undefined}
                    onClick={() => newSession(workspace.id)}
                  >
                    <Plus size={13} />
                  </IconButton>
                  <WorkspaceMenu
                    workspace={workspace}
                    tipOpen={scrollClosed ? false : undefined}
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
              {sessionRows(shown, workspace.id)}
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
  rowKey,
  session,
  tabIndex,
  details,
  renaming,
  editing,
  onRename,
  onRenameCommit,
  onRenameCancel,
  attention,
  running,
  onOpen,
  onKeyDown,
  onFocusRow,
  hovered,
  hoveredKey,
  menuFocus,
  scrollClosed,
  listRef,
  onPoint,
  onPointerLeave,
  onMenuFocus,
  onKeepHover,
  linkRef,
  onDialog,
}: {
  rowKey: string;
  session: Session;
  tabIndex: number;
  details: { project?: string; age: ActivityAge; absolute?: string };
  renaming: boolean;
  /** The title is being edited in place, so the row is a text field. */
  editing: boolean;
  onRename: () => void;
  onRenameCommit: (value: string) => void;
  onRenameCancel: () => void;
  attention: boolean;
  running: boolean;
  onOpen: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => void;
  onFocusRow: () => void;
  hovered: boolean;
  hoveredKey: string | null;
  menuFocus: string | null;
  scrollClosed: boolean;
  listRef: { current: HTMLDivElement | null };
  onPoint: (point: { x: number; y: number }) => void;
  onPointerLeave: () => void;
  onMenuFocus: (key: string | null) => void;
  onKeepHover: () => void;
  linkRef: (node: HTMLAnchorElement | null) => void;
  onDialog?: (dialog: DialogId, selection?: string) => void;
}) {
  // A function class would be stringified by the tooltip trigger, so the
  // active row would lose its highlight. The same path is used in a project
  // group, and both rows highlight together.
  const active = useMatch({ path: `/session/${session.id}`, end: true });
  const menuButton = useRef<HTMLButtonElement>(null);
  const linkNode = useRef<HTMLAnchorElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [linkFocused, setLinkFocused] = useState(false);
  const [inView, setInView] = useState(true);
  useLayoutEffect(() => {
    const row = menuButton.current?.closest('.session-row') ?? null;
    const visible = rowInView(row, listRef.current);
    setInView((current) => (current === visible ? current : visible));
  });
  const aim = (event: { clientX: number; clientY: number }) =>
    onPoint({ x: event.clientX, y: event.clientY });
  // The card follows the pointer. The tooltip library drops the hover that
  // arrives just after another tip closes, so it cannot be the thing that opens it.
  // The focused … button owns the popup while the pointer rests on its row
  // or nowhere. Moving onto another row lets that row's card replace the tip.
  const keyboardOwns =
    menuFocus !== null && (hoveredKey === null || hoveredKey === menuFocus);
  const cardOpen =
    !renaming &&
    !editing &&
    !menuOpen &&
    !keyboardOwns &&
    !scrollClosed &&
    (hovered || (linkFocused && hoveredKey === null));
  const tipOpen =
    keyboardOwns &&
    menuFocus === rowKey &&
    !editing &&
    !menuOpen &&
    !scrollClosed &&
    inView;
  const row = (
    <div
      className="session-row"
      data-row-key={rowKey}
      onPointerEnter={aim}
      onPointerMove={aim}
      onPointerLeave={onPointerLeave}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {editing ? (
        <>
          <RenameField
            label={t('rename session')}
            defaultValue={session.title === 'new session' ? '' : session.title}
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
          <span className="session-menu-gap" aria-hidden="true" />
        </>
      ) : (
        <>
          <NavLink
            ref={(node) => {
              linkNode.current = node;
              linkRef(node);
            }}
            tabIndex={tabIndex}
            className={active ? 'session-link active' : 'session-link'}
            end
            to={`/session/${session.id}`}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const target = event.target;
              if (target instanceof Element && target.closest('button')) return;
              linkNode.current?.focus({ preventScroll: true });
            }}
            onClick={(event) => {
              event.preventDefault();
              linkNode.current?.focus({ preventScroll: true });
              onOpen(session.id);
              onKeepHover();
            }}
            onFocus={() => {
              setLinkFocused(true);
              onFocusRow();
            }}
            onBlur={() => setLinkFocused(false)}
            onKeyDown={(event) => {
              if (
                event.key === 'ArrowRight' &&
                !event.altKey &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey
              ) {
                event.preventDefault();
                menuButton.current?.focus({ preventScroll: true });
              } else if (menuKey(event)) {
                event.preventDefault();
                setMenuOpen(true);
              } else onKeyDown(event);
            }}
          >
            <span>{sessionTitle(session.title)}</span>
            {attention ? (
              <i className="attention-dot" />
            ) : running ? (
              <i className="running-dot" />
            ) : null}
          </NavLink>
          <SessionMenu
            session={session}
            buttonRef={menuButton}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            tipOpen={tipOpen}
            onFocus={() => onMenuFocus(rowKey)}
            onBlur={() => onMenuFocus(null)}
            onKeyDown={(event) => {
              if (
                event.key === 'ArrowLeft' &&
                !event.altKey &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey
              ) {
                event.preventDefault();
                linkNode.current?.focus({ preventScroll: true });
              } else if (menuKey(event)) {
                event.preventDefault();
                setMenuOpen(true);
              }
            }}
            onRename={onRename}
            onDialog={(dialog, selection) => onDialog?.(dialog, selection)}
          />
        </>
      )}
    </div>
  );
  return (
    <RecentHover details={details} open={cardOpen}>
      {row}
    </RecentHover>
  );
}

function listAnchor(list: HTMLElement) {
  const listTop = list.getBoundingClientRect().top;
  let chosen: HTMLElement | null = null;
  let delta = 0;
  for (const row of list.querySelectorAll<HTMLElement>('[data-row-key]')) {
    const next = row.getBoundingClientRect().top - listTop;
    if (next <= 1) {
      chosen = row;
      delta = next;
    } else if (!chosen) {
      chosen = row;
      delta = next;
      break;
    } else break;
  }
  const key = chosen?.dataset.rowKey;
  return key ? { key, delta } : null;
}

function rowInView(row: Element | null, list: HTMLElement | null) {
  if (!row || !list) return false;
  const listBox = list.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  return rowBox.bottom > listBox.top + 1 && rowBox.top < listBox.bottom - 1;
}

function menuKey(event: { key: string; shiftKey: boolean }) {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

function activityLabel(age: ActivityAge): string {
  if (age.kind === 'raw') return age.text;
  if (age.kind === 'just now') return t('just now');
  if (age.kind === 'minutes')
    return tn(age.n, '{n} minute ago', '{n} minutes ago');
  if (age.kind === 'hours') return tn(age.n, '{n} hour ago', '{n} hours ago');
  return tn(age.n, '{n} day ago', '{n} days ago');
}

function RecentHover({
  details,
  open,
  children,
}: {
  details: { project?: string; age: ActivityAge; absolute?: string };
  open: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root open={open} onOpenChange={() => {}} disableHoverableContent>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="tooltip session-hover"
          side="right"
          align="start"
          sideOffset={8}
          avoidCollisions={false}
        >
          {details.project ? <span>{details.project}</span> : null}
          <span>{activityLabel(details.age)}</span>
          {details.absolute ? <span>{details.absolute}</span> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
