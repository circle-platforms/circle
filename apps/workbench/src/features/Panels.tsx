import { ResizableContextIndex } from '../components/ResizableContextIndex';
import { VirtualFileTree } from '../components/VirtualFileTree';
import { buildFileTreeRows } from '../model/virtual-file-tree';
import { changedFiles } from '../model/changed-files';
import { sessionChangeRows, type ChangeRow } from '../model/changes';
import { useGitChanges } from '../model/git-changes';
import { useOwnerState } from '../model/owner-state';
import type { CommandTerminalView } from '../model/command-terminal-client';
import { TerminalMode } from './TerminalMode';
import { AgentsMode } from './AgentsMode';
import { ModeButtons, ModeChromeProvider, useModeChrome } from './mode-chrome';
import { desktopHost } from '../host';
import { isAgentActive } from '../model/activity';
import { FileIcon } from '../components/FileIcon';
import { NativeBrowser } from './NativeBrowser';
import { usePlugins } from '../plugins/context';
import { PluginBoundary } from '../plugins/Boundary';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  ArrowUpRight,
  Bot,
  ExternalLink,
  Folder,
  Globe,
  LayoutDashboard,
  Search,
  SquareTerminal,
} from 'lucide-react';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import { t, tn } from '../i18n';
import type { PanelId, Interaction, DialogId } from '../model/types';
import { IconButton, SearchInput } from '../components/common';

/** The narrowest a drawer can be and show a file with the tree beside it. */
const DOCUMENT_AND_TREE = 620;
/** What the drawer was asked to show, such as a file or an address, and the mode it was
 * asked of. */
export interface DrawerSelection {
  panel: PanelId;
  value: string;
}
interface Props {
  fileView?: ReactNode;
  filePath?: string;
  fileOwnerKey?: string;
  resourcesPaused?: boolean;
  commandTerminal?: CommandTerminalView;
  onExitCommandTerminal?: () => void;
  panel: PanelId;
  /** The modes that are in windows of their own. */
  popped?: ReadonlySet<string>;
  /** Take the browser or the terminal out into a window of its own. */
  onPopOut?: (kind: 'browser' | 'terminal') => void;
  /** Each mode is given only what was meant for it, and nothing else's. */
  selection: DrawerSelection;
  onPanel: (panel: PanelId, selection?: string) => void;
  onClose: () => void;
  onFile: (path: string, line?: number, column?: number) => void;
  /** Opens a file in the subagent's own workspace. */
  onAgentFile: (path: string, line?: number, column?: number) => void;
  visible?: boolean;
  onSession?: (id: string) => void;
  /** The subagent open in the subagents mode, if one is. */
  agent?: string | null;
  /** Select a subagent, or none. */
  onAgent: (id: string | null) => void;
  onInteraction: (item: Interaction) => void;
  onDialog: (dialog: DialogId, selection?: string) => void;
}
// The modes the drawer can show: those the enabled components add, then the subagents
// and the terminal, which are Circle's own.
function usePanels() {
  const { registry, enabled } = usePlugins();
  return registry
    .active(enabled)
    .flatMap((plugin) =>
      (plugin.panels ?? []).map((panel) => ({ plugin, panel })),
    );
}
/**
 * The overview, then the work drawer's modes, as icons: a name shows when the pointer
 * rests on one. The overview is a column of its own beside the conversation, so a
 * divider sets it apart. Repeating the open mode closes the drawer.
 */
export function PanelButtons({
  panel,
  open,
  overviewShown,
  onOverview,
  onPanel,
  onClose,
  popped = new Set(),
}: {
  panel: PanelId;
  open: boolean;
  overviewShown: boolean;
  onOverview: () => void;
  onPanel: (panel: PanelId) => void;
  onClose: () => void;
  /** The modes that are in windows of their own: marked, and pressed to bring forward. */
  popped?: ReadonlySet<string>;
}) {
  const panels = usePanels();
  const { snapshot } = useRuntime();
  const session = currentSession(snapshot);
  const subagents = snapshot.agents.filter(
    (agent) =>
      agent.sessionId === session.id && !agent.task && isAgentActive(agent),
  ).length;
  const commands = snapshot.jobs.filter(
    (job) =>
      job.sessionId === session.id &&
      job.kind === 'command' &&
      ['running', 'waiting', 'stopping'].includes(job.state),
  ).length;
  const modes = [
    ...panels.map(({ panel: item }) => ({
      id: item.id,
      title: item.title,
      icon: item.icon,
      badge: 0,
    })),
    { id: 'agents', title: t('subagents'), icon: Bot, badge: subagents },
    {
      id: 'terminal',
      title: t('terminal'),
      icon: SquareTerminal,
      badge: commands,
    },
  ];
  // The click that opens a panel must not leave that button focused. The next
  // Enter (the address bar's) would otherwise activate it and close the panel.
  const blurAfterPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button === 0) event.currentTarget.blur();
  };
  return (
    <nav className="drawer-mode-toolbar" aria-label={t('work drawer')}>
      <button
        className={`drawer-mode-button ${overviewShown ? 'active' : ''}`}
        aria-label={t('{title} panel', { title: t('overview') })}
        title={t('overview')}
        aria-pressed={overviewShown}
        onClick={onOverview}
        onPointerUp={blurAfterPress}
      >
        <LayoutDashboard size={15} aria-hidden />
      </button>
      <span
        className="drawer-mode-divider"
        role="separator"
        aria-orientation="vertical"
      />
      {modes.map((item) => (
        <button
          key={item.id}
          className={`drawer-mode-button ${open && panel === item.id ? 'active' : ''}${popped.has(item.id) ? ' popped' : ''}`}
          aria-label={t('{title} panel', { title: item.title })}
          title={
            popped.has(item.id)
              ? t('{title} is in its own window', { title: item.title })
              : item.title
          }
          aria-pressed={open && panel === item.id}
          onClick={() =>
            open && panel === item.id && !popped.has(item.id)
              ? onClose()
              : onPanel(item.id)
          }
          onPointerUp={blurAfterPress}
        >
          <item.icon size={15} aria-hidden />
          {item.badge > 0 && (
            <i className="drawer-mode-badge" aria-label={String(item.badge)}>
              {item.badge}
            </i>
          )}
        </button>
      ))}
    </nav>
  );
}
/**
 * The work drawer: the open mode, below the top bar's buttons. Each mode has its own
 * toolbar and no title, so there is nothing to close it but its button and Escape.
 */
export function Inspector(props: Props) {
  const { snapshot } = useRuntime();
  const session = currentSession(snapshot);
  const panels = usePanels();
  return (
    <aside
      className="inspector work-drawer"
      aria-label={t('work drawer')}
      data-inspector-panel={props.panel}
    >
      <div className="inspector-body flush">
        <InspectorResources {...props} sessionId={session.id} panels={panels} />
      </div>
    </aside>
  );
}
function InspectorResources(
  props: Props & {
    sessionId: string;
    panels: ReturnType<typeof usePanels>;
  },
) {
  const [visited, setVisited] = useState<Set<string>>(
    () => new Set([props.panel]),
  );
  useEffect(() => {
    setVisited((old) =>
      old.has(props.panel) ? old : new Set(old).add(props.panel),
    );
  }, [props.panel]);
  const ids = new Set([...visited, props.panel]);
  // What the drawer offers every mode: the full view. A mode adds what is its own.
  const chrome = useModeChrome();
  return (
    <>
      {[...ids].map((id) => {
        const item = props.panels.find((item) => item.panel.id === id);
        const own = props.selection.panel === id ? props.selection.value : '';
        const resourceSelection =
          id === 'files' &&
          (!props.fileOwnerKey || props.fileOwnerKey === props.sessionId)
            ? (props.filePath ?? own)
            : own;
        const original =
          id === 'agents' ? (
            <AgentsMode
              selection={props.agent ?? ''}
              onSelect={props.onAgent}
              onFile={props.onAgentFile}
              onDialog={props.onDialog}
            />
          ) : item ? (
            <PluginBoundary name={item.plugin.title}>
              <item.panel.component
                {...props}
                visible={!!props.visible && id === props.panel}
                selection={resourceSelection}
                sessionId={props.sessionId}
              />
            </PluginBoundary>
          ) : id === 'terminal' ? null : (
            <p className="panel-note">{t('plugin disabled')}</p>
          );
        const canPopOut = id === 'browser' || id === 'terminal';
        return (
          <ModeChromeProvider
            key={id}
            value={{
              ...(chrome ?? { canBeWhole: false, whole: false, onWhole() {} }),
              ...(canPopOut && props.onPopOut
                ? { onPopOut: () => props.onPopOut!(id) }
                : {}),
              poppedOut: canPopOut && !!props.popped?.has(id),
            }}
          >
            <div
              hidden={id !== props.panel}
              className="inspector-resource-view"
              data-inspector-resource={id}
            >
              {id === 'files' ? (
                <DrawerFiles
                  index={original}
                  filePath={props.filePath}
                  ownerKey={props.fileOwnerKey ?? props.sessionId}
                >
                  {props.fileView}
                </DrawerFiles>
              ) : id === 'terminal' ? (
                <TerminalMode
                  paused={props.resourcesPaused}
                  commandTerminal={props.commandTerminal}
                  onExitCommandTerminal={props.onExitCommandTerminal}
                  sessionId={props.sessionId}
                  visible={!!props.visible && id === props.panel}
                />
              ) : (
                original
              )}
            </div>
          </ModeChromeProvider>
        );
      })}
    </>
  );
}
/**
 * The files mode: the tree alone until a file is opened, then the file with the tree
 * beside it. The tree stays mounted either way, so its folders and scroll are kept, and
 * closing the file never recreates the tree. A drawer too narrow for both shows the file
 * alone, and the tree comes back when the file is closed.
 */
function DrawerFiles({
  index,
  filePath,
  ownerKey,
  children,
}: {
  index: ReactNode;
  filePath?: string;
  ownerKey: string;
  children: ReactNode;
}) {
  const documentBox = useRef<HTMLElement>(null);
  const [room, setRoom] = useState(true);
  useEffect(() => {
    const node = documentBox.current;
    if (!node) return;
    const measure = () => {
      if (node.clientWidth > 0) setRoom(node.clientWidth >= DOCUMENT_AND_TREE);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const beside = !!filePath && room;
  return (
    <section
      className={`drawer-document ${filePath ? 'has-file' : 'list-only'}`}
      ref={documentBox}
    >
      <div className="drawer-document-layout">
        <div className="drawer-document-content" hidden={!filePath}>
          {children}
        </div>
        <ResizableContextIndex
          className="drawer-context-index"
          ownerKey={ownerKey}
          resourceKey="files"
          open={!filePath || beside}
        >
          {index}
        </ResizableContextIndex>
      </div>
    </section>
  );
}
export function FilesPanel({
  selection,
  visible,
  onFile,
  onDialog,
}: { selection: string } & Pick<Props, 'onFile' | 'visible'> &
  Partial<Pick<Props, 'onDialog'>>) {
  const { snapshot, runtime } = useRuntime();
  const session = currentSession(snapshot);
  const listing = snapshot.fileListings?.[session.workspaceId];
  const live = runtime.mode === 'live';
  // The names Git says differ from the last commit are coloured, with the letter that
  // says how. Where there is no repository, this conversation's own changes stand in.
  const git = useGitChanges({
    sessionId: session.id,
    live,
    active: !!visible,
    busy: session.state !== 'idle',
  });
  const workspacePath = snapshot.workspaces.find(
    (workspace) => workspace.id === session.workspaceId,
  )?.path;
  const owner = JSON.stringify([session.workspaceId, session.id]);
  const [query, setQuery] = useOwnerState(owner, '');
  const [open, setOpen] = useOwnerState<Set<string>>(owner, new Set());
  const panel = useRef<HTMLDivElement>(null);
  // Opening a source reveals its ancestors without replacing the retained editor.
  useEffect(() => {
    const parts = selection.split('/').slice(0, -1);
    setOpen((old) => {
      const next = new Set(old);
      parts.forEach((_, index) =>
        next.add(parts.slice(0, index + 1).join('/')),
      );
      return next.size === old.size ? old : next;
    });
  }, [selection, owner]);
  const workspaceFiles = useMemo(
    () =>
      snapshot.files.filter((file) => file.workspaceId === session.workspaceId),
    [snapshot.files, session.workspaceId],
  );
  const changed = useMemo(() => {
    const own: ChangeRow[] = sessionChangeRows(session.changes, workspacePath);
    if (live) return changedFiles(git.files ?? own);
    // The preview has no repository: its sample files with a status are the changes.
    const sample = workspaceFiles
      .filter((file) => file.status)
      .map((file) => ({
        path: file.path,
        letter: file.status === 'added' ? ('A' as const) : ('M' as const),
      }));
    return changedFiles([...own, ...sample]);
  }, [live, git.files, session.changes, workspacePath, workspaceFiles]);
  const tree = useMemo(
    () =>
      buildFileTreeRows(
        workspaceFiles.map((file) => file.path),
        open,
        query,
      ),
    [workspaceFiles, open, query],
  );
  const native =
    snapshot.workspaces.find(
      (workspace) => workspace.id === session.workspaceId,
    )?.origin === 'native';
  const toggle = (path: string) =>
    setOpen((old) => {
      const next = new Set(old);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <div className="files-panel" ref={panel}>
      <span className="panel-header-name">
        <Folder size={14} aria-hidden />
        {t('files')}
      </span>
      <span className="panel-header-actions">
        <IconButton
          label={t('search files')}
          onClick={() =>
            panel.current
              ?.querySelector<HTMLInputElement>('.search-field input')
              ?.focus()
          }
        >
          <Search size={14} />
        </IconButton>
      </span>
      <SearchInput
        value={query}
        onChange={setQuery}
        label={t('filter files')}
        placeholder={t('filter files…')}
      />
      <VirtualFileTree
        rows={tree.rows}
        selectedPath={selection}
        ownerKey={owner}
        filterKey={query}
        ariaLabel={t('files')}
        onToggle={toggle}
        onSelect={onFile}
        renderIcon={(row) =>
          !row.folder ? <FileIcon name={row.name} /> : null
        }
        rowClassName={(row) => {
          const letter = changed.letters.get(row.path);
          return row.folder
            ? changed.folders.has(row.path)
              ? 'has-changes'
              : ''
            : letter && letter !== 'D'
              ? `changed-${letter}`
              : '';
        }}
        renderTrailing={(row) => {
          if (row.folder)
            return changed.folders.has(row.path) ? (
              <i
                className="file-dot"
                title={t('has changes')}
                aria-label={t('has changes')}
              />
            ) : null;
          const letter = changed.letters.get(row.path);
          return letter && letter !== 'D' ? (
            <small
              className="file-letter"
              data-letter={letter}
              title={letter === 'A' ? t('added') : t('modified')}
            >
              {letter}
            </small>
          ) : null;
        }}
      />
      {listing && (
        <div
          className="file-listing-status"
          role={listing.error ? 'alert' : 'status'}
        >
          <span>
            {tn(listing.loaded, '{n} file loaded', '{n} files loaded')}
          </span>
          {!listing.complete && !listing.error && (
            <span>{t('loading file list…')}</span>
          )}
          {listing.truncated && <span>{t('file list is incomplete')}</span>}
          {listing.error && (
            <span title={listing.error}>{t('could not load file list')}</span>
          )}
        </div>
      )}
      {(!native || (!listing && !(workspaceFiles.length || query))) && (
        <p className="panel-note">
          {native ? t('trust this folder to browse files') : t('sample files')}
        </p>
      )}
      {!!query && !tree.matchedCount && (!listing || listing.complete) && (
        <p className="panel-note">{t('no matching files')}</p>
      )}
      {onDialog && (
        <div className="file-index-footer">
          <button type="button" onClick={() => onDialog('external-files')}>
            <ExternalLink size={14} aria-hidden />
            <span>{t('external files')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
export function BrowserPanel({ selection }: { selection?: string } = {}) {
  return desktopHost() ? (
    <NativeBrowser target={selection} />
  ) : (
    <BrowserPlaceholder />
  );
}
function BrowserPlaceholder() {
  const { runtime, notify } = useRuntime();
  const [url, setUrl] = useState('https://app.example.test');
  return (
    <>
      <div className="browser-address">
        <Globe size={13} />
        <input
          aria-label={t('browser address')}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <IconButton
          label={t('request navigation')}
          onClick={() => {
            try {
              const parsed = new URL(url);
              if (!['https:', 'http:'].includes(parsed.protocol)) throw Error();
              runtime.request('browser.navigate', { url });
              notify(t('navigation saved for preview'));
            } catch {
              notify(t('enter an http or https URL'));
            }
          }}
        >
          <ArrowUpRight size={14} />
        </IconButton>
        <ModeButtons popOut />
      </div>
      <div className="browser-empty">
        <Globe size={32} />
        <h3>{t('no browser attached')}</h3>
        <p>{t('browser preview only')}</p>
      </div>
    </>
  );
}
