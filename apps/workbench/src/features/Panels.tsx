import type { CommandTerminalView } from '../model/command-terminal-client';
import { TerminalSelectionPreview } from '../components/TerminalSelectionPreview';
import { WorkspacePanelContents } from './WorkspacePanelContents';
import { useSources } from '../components/SourceNavigation';
import { desktopHost } from '../host';
import { agentActivityText, agentState } from '../model/activity';
import { NativeBrowser } from './NativeBrowser';
import { usePlugins } from '../plugins/context';
import { PluginBoundary } from '../plugins/Boundary';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  FileText,
  FileCode,
  FileImage,
  FileJson,
  Folder,
  ChevronRight,
  ChevronDown,
  X,
  ArrowUpRight,
  Terminal,
  Globe,
  FileDiff,
  Layers,
  Activity,
  Download,
  Plus,
  RotateCcw,
  ExternalLink,
  Maximize2,
  Minimize2,
  Search,
  Play,
  Users,
  ShieldCheck,
  Check,
} from 'lucide-react';
import { useRuntime } from '../app/context';
import { currentSession, sessionMode } from '../model/state';
import { DiffBlock } from '../components/DiffBlock';
import { EFFORT_TEXT, MODE_TEXT } from './Composer';
import { t, tn } from '../i18n';
import type {
  PanelId,
  Interaction,
  DialogId,
  WorkbenchSnapshot,
} from '../model/types';
import {
  Button,
  IconButton,
  SearchInput,
  Status,
  Facts,
  DataBlock,
  FileChip,
} from '../components/common';
export const PANEL_DEFINITIONS = [
  { id: 'files', label: 'files', icon: Folder, plugin: 'files' },
  { id: 'changes', label: 'changes', icon: FileDiff, plugin: 'files' },
  { id: 'context', label: 'context', icon: Layers },
  { id: 'activity', label: 'activity', icon: Activity, plugin: 'activity' },
  { id: 'browser', label: 'browser', icon: Globe, plugin: 'browser' },
] as const;
// What an attached piece of context is, and what a request asks for.
const ATTACHMENT_KIND: Record<string, () => string> = {
  file: () => t('file'),
  image: () => t('image'),
  document: () => t('document'),
  skill: () => t('skill'),
  paste: () => t('pasted text'),
};
const REQUEST_KIND: Record<string, () => string> = {
  approval: () => t('approval'),
  question: () => t('question'),
  secret: () => t('secret'),
  'plan-exit': () => t('plan exit'),
};
interface Props {
  resourcesPaused?: boolean;
  commandTerminal?: CommandTerminalView;
  debugSourceRequest?: { id: string; path: string; line?: number };
  onOpenTerminal?: (target: { id: string; epoch: string }) => void;
  terminalFocusRequest?: { id: string; epoch: string; requestId: string };
  onExitCommandTerminal?: () => void;
  panel: PanelId;
  selection: string;
  onPanel: (panel: PanelId, selection?: string) => void;
  onClose: () => void;
  onFile: (path: string, line?: number, column?: number) => void;
  visible?: boolean;
  onSession?: (id: string) => void;
  /** The panel across the whole workspace, and the way back to the split. */
  whole: boolean;
  canBeWhole: boolean;
  onWhole: () => void;
  onAgent: (id: string) => void;
  onInteraction: (item: Interaction) => void;
  onDialog: (dialog: DialogId, selection?: string) => void;
}
// The panels the inspector can show: context, then those the enabled components add.
function usePanels() {
  const { registry, enabled } = usePlugins();
  return registry
    .active(enabled)
    .flatMap((plugin) =>
      (plugin.panels ?? []).map((panel) => ({ plugin, panel })),
    );
}
/**
 * The inspector's panels as icons in the top bar, as Claude places them: a click opens
 * that panel, a second click closes it.
 */
export function PanelButtons({
  panel,
  open,
  onPanel,
  onClose,
}: {
  panel: PanelId;
  open: boolean;
  onPanel: (panel: PanelId) => void;
  onClose: () => void;
}) {
  const panels = usePanels();
  const active = panels.some((item) => item.panel.id === panel)
    ? panel
    : 'context';
  const current = panel === 'terminal' ? 'terminal' : active;
  const toggle = (id: PanelId) =>
    open && current === id ? onClose() : onPanel(id);
  return (
    <>
      <IconButton
        label={t('terminal panel')}
        aria-pressed={open && current === 'terminal'}
        className={`icon-button ${open && current === 'terminal' ? 'active' : ''}`}
        onClick={() => toggle('terminal')}
      >
        <Terminal size={16} />
      </IconButton>
      {panels.map(({ panel: item }) => (
        <IconButton
          key={item.id}
          label={t('{title} panel', { title: item.title })}
          aria-pressed={open && current === item.id}
          className={`icon-button ${open && current === item.id ? 'active' : ''}`}
          onClick={() => toggle(item.id)}
        >
          <item.icon size={16} />
        </IconButton>
      ))}
      <IconButton
        label={t('context panel')}
        aria-pressed={open && current === 'context'}
        className={`icon-button ${open && current === 'context' ? 'active' : ''}`}
        onClick={() => toggle('context')}
      >
        <Layers size={16} />
      </IconButton>
    </>
  );
}
// Panels that fill the inspector to its edges, as Claude's terminal, browser and files do.
const FLUSH = new Set<string>(['terminal', 'browser', 'files']);
export function Inspector(props: Props) {
  const { snapshot } = useRuntime();
  const session = currentSession(snapshot);
  const panels = usePanels();
  const selected = panels.find((item) => item.panel.id === props.panel);
  const terminal = props.panel === 'terminal';
  return (
    <aside
      className="inspector"
      data-inspector-panel={props.panel}
      data-inspector-whole-button={props.canBeWhole ? '' : undefined}
    >
      <header className="inspector-title">
        <h2 className="inspector-title-name">
          {terminal
            ? t('terminal')
            : selected
              ? selected.panel.title
              : t('context')}
        </h2>
        <span className="inspector-actions">
          {props.canBeWhole && (
            <IconButton
              label={props.whole ? t('exit full view') : t('full view')}
              aria-pressed={props.whole}
              className={`icon-button ${props.whole ? 'active' : ''}`}
              onClick={props.onWhole}
            >
              {props.whole ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </IconButton>
          )}
          <IconButton label={t('close inspector')} onClick={props.onClose}>
            <X size={15} />
          </IconButton>
        </span>
      </header>
      <div
        className={`inspector-body ${FLUSH.has(props.panel) ? 'flush' : ''}`}
      >
        {props.resourcesPaused && (
          <p
            className="panel-note"
            role="status"
            style={{ overflowWrap: 'anywhere' }}
          >
            {t(
              'Resources belong to {name}. Start a conversation in the selected project to make changes.',
              {
                name:
                  snapshot.workspaces.find(
                    (item) => item.id === session.workspaceId,
                  )?.path ?? session.title,
              },
            )}
          </p>
        )}
        <InspectorResources {...props} sessionId={session.id} panels={panels} />
      </div>
    </aside>
  );
}
function InspectorResources(
  props: Props & { sessionId: string; panels: ReturnType<typeof usePanels> },
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
  return (
    <>
      {[...ids].map((id) => {
        const item = props.panels.find((item) => item.panel.id === id);
        const original =
          id === 'terminal' ? (
            <TerminalPanel embedded onClose={props.onClose} />
          ) : item ? (
            <PluginBoundary name={item.plugin.title}>
              <item.panel.component {...props} sessionId={props.sessionId} />
            </PluginBoundary>
          ) : (
            <ContextPanel {...props} />
          );
        return (
          <div
            key={id}
            hidden={id !== props.panel}
            className="inspector-resource-view"
            data-inspector-resource={id}
          >
            {id === 'terminal' || id === 'changes' || id === 'activity' ? (
              <WorkspacePanelContents
                kind={id}
                resourcesPaused={props.resourcesPaused}
                commandTerminal={
                  id === 'terminal' ? props.commandTerminal : undefined
                }
                debugSourceRequest={
                  id === 'activity' ? props.debugSourceRequest : undefined
                }
                onOpenTerminal={props.onOpenTerminal}
                terminalFocusRequest={props.terminalFocusRequest}
                onExitCommandTerminal={props.onExitCommandTerminal}
                sessionId={props.sessionId}
                visible={!!props.visible && id === props.panel}
                selection={props.selection}
                onFile={props.onFile}
                onSession={props.onSession ?? (() => {})}
                onTask={(task) => props.onPanel('activity', `task:${task}`)}
              >
                {original}
              </WorkspacePanelContents>
            ) : (
              original
            )}
          </div>
        );
      })}
    </>
  );
}
// The workspace's files as a tree, folders first, each level sorted by name.
interface TreeNode {
  name: string;
  path: string;
  folders: Map<string, TreeNode>;
  files: WorkbenchSnapshot['files'];
}
function fileTree(files: WorkbenchSnapshot['files']) {
  const root: TreeNode = { name: '', path: '', folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? node.path + '/' + part : part;
      let next = node.folders.get(part);
      if (!next) {
        next = { name: part, path, folders: new Map(), files: [] };
        node.folders.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  return root;
}
const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
// A file's kind by its extension, for the colour of its icon.
function fileKind(name: string) {
  const extension = name.includes('.') ? name.split('.').at(-1)! : '';
  if (/^(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(extension)) return 'image';
  if (/^(json|jsonc|ya?ml|toml|lock|ini|env)$/i.test(extension)) return 'data';
  if (/^(md|mdx|txt|rst)$/i.test(extension)) return 'text';
  if (extension) return 'code';
  return 'plain';
}
function FileIcon({ name }: { name: string }) {
  const kind = fileKind(name);
  const Icon =
    kind === 'image'
      ? FileImage
      : kind === 'data'
        ? FileJson
        : kind === 'code'
          ? FileCode
          : FileText;
  return <Icon size={14} className={`file-icon ${kind}`} aria-hidden />;
}
export function FilesPanel({
  selection,
  onFile,
}: Pick<Props, 'selection' | 'onFile'>) {
  const { snapshot } = useRuntime();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const panel = useRef<HTMLDivElement>(null);
  const session = currentSession(snapshot);
  // The folders around the open file stay open, so it shows in the tree.
  useEffect(() => {
    const parts = selection.split('/').slice(0, -1);
    if (!parts.length) return;
    setOpen((old) => {
      const next = new Set(old);
      parts.forEach((_, index) =>
        next.add(parts.slice(0, index + 1).join('/')),
      );
      return next.size === old.size ? old : next;
    });
  }, [selection]);
  const files = snapshot.files.filter(
    (file) =>
      file.workspaceId === session.workspaceId &&
      file.path.toLowerCase().includes(query.toLowerCase()),
  );
  const tree = fileTree(files);
  const native =
    snapshot.workspaces.find(
      (workspace) => workspace.id === session.workspaceId,
    )?.origin === 'native';
  // While a filter is typed every folder that holds a match is open.
  const isOpen = (path: string) => !!query || open.has(path);
  const toggle = (path: string) =>
    setOpen((old) => {
      const next = new Set(old);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const rows = (node: TreeNode, depth: number): ReactNode[] => [
    ...[...node.folders.values()]
      .sort((a, b) => byName(a.name, b.name))
      .flatMap((folder) => [
        <button
          key={'d:' + folder.path}
          className="tree-folder"
          aria-expanded={isOpen(folder.path)}
          style={{ '--depth': depth } as CSSProperties}
          onClick={() => toggle(folder.path)}
        >
          {isOpen(folder.path) ? (
            <ChevronDown size={13} aria-hidden />
          ) : (
            <ChevronRight size={13} aria-hidden />
          )}
          <span>{folder.name}</span>
        </button>,
        ...(isOpen(folder.path) ? rows(folder, depth + 1) : []),
      ]),
    ...[...node.files]
      .sort((a, b) =>
        byName(a.path.split('/').at(-1)!, b.path.split('/').at(-1)!),
      )
      .map((file) => {
        const name = file.path.split('/').at(-1)!;
        return (
          <button
            className={`tree-file ${selection === file.path ? 'active' : ''}`}
            key={file.id}
            title={file.path}
            style={{ '--depth': depth } as CSSProperties}
            onClick={() => onFile(file.path)}
          >
            <FileIcon name={name} />
            <span>{name}</span>
            {file.status && (
              <small className={file.status}>
                {file.status === 'added' ? 'A' : 'M'}
              </small>
            )}
          </button>
        );
      }),
  ];
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
      <div className="file-tree">{rows(tree, 0)}</div>
      {(!native || !(files.length || query)) && (
        <p className="panel-note">
          {native ? t('trust this folder to browse files') : t('sample files')}
        </p>
      )}
      {!!query && !files.length && (
        <p className="panel-note">{t('no matching files')}</p>
      )}
    </div>
  );
}
export function ChangesPanel({ onFile }: Pick<Props, 'onFile'>) {
  const { snapshot, runtime } = useRuntime();
  if (runtime.mode === 'live') return <LiveChanges onFile={onFile} />;
  return <SampleChanges onFile={onFile} />;
}
// What this session changed on disk while the app ran, each file against its version
// before the session's first change to it.
function LiveChanges({ onFile }: Pick<Props, 'onFile'>) {
  const { snapshot } = useRuntime();
  const session = currentSession(snapshot);
  const workspace = snapshot.workspaces.find(
    (item) => item.id === session.workspaceId,
  );
  const changes = session.changes ?? [];
  const shown = (path: string) =>
    workspace && path.startsWith(workspace.path + '/')
      ? path.slice(workspace.path.length + 1)
      : path;
  return (
    <>
      <div className="inspector-heading">
        <h2>{t('changes')}</h2>
        <span>{tn(changes.length, '{n} file', '{n} files')}</span>
      </div>
      {changes.length ? (
        changes.map((change) => (
          <div className="change-entry" key={change.path}>
            <button
              className="change-file"
              disabled={change.kind === 'deleted'}
              onClick={() => onFile(shown(change.path))}
            >
              <FileText size={15} />
              <span>
                {shown(change.path)}
                <small className={change.kind}>
                  {change.kind === 'added'
                    ? t('added')
                    : change.kind === 'deleted'
                      ? t('deleted')
                      : t('modified')}
                </small>
              </span>
              <ChevronRight size={13} />
            </button>
            <DiffBlock diff={change.diff} compact />
          </div>
        ))
      ) : (
        <p className="muted">{t('no files changed in this session yet')}</p>
      )}
    </>
  );
}
function SampleChanges({ onFile }: Pick<Props, 'onFile'>) {
  const { snapshot, runtime, notify } = useRuntime();
  const session = currentSession(snapshot);
  const changes = snapshot.files.filter(
    (file) => file.workspaceId === session.workspaceId && file.status,
  );
  return (
    <>
      <div className="inspector-heading">
        <h2>changes</h2>
        <span>{changes.length} files</span>
      </div>
      <div className="change-summary">
        <FileDiff size={18} />
        <div>
          <strong>working changes</strong>
          <p>sample · not applied to disk</p>
        </div>
      </div>
      {changes.map((file) => (
        <button
          className="change-file"
          key={file.id}
          onClick={() => onFile(file.path)}
        >
          <FileText size={15} />
          <span>
            {file.path}
            <small>{file.status}</small>
          </span>
          <ChevronRight size={13} />
        </button>
      ))}
      <div className="panel-section">
        <h3>review</h3>
        <p>
          Compare the proposed content with the original. Accepting a proposal
          needs the connected runtime.
        </p>
        <Button
          disabled={session.readOnly || !changes.length}
          onClick={() => {
            runtime.request('apply-changes', {
              fileIds: changes.map((file) => file.id),
            });
            notify('apply request recorded; no workspace file changed');
          }}
        >
          request apply
          <ArrowUpRight size={12} />
        </Button>
      </div>
    </>
  );
}
export function ContextPanel({ onDialog }: Pick<Props, 'onDialog'>) {
  const sources = useSources();
  const { snapshot, runtime, perform } = useRuntime();
  const session = currentSession(snapshot);
  const workspace = snapshot.workspaces.find(
    (item) => item.id === session.workspaceId,
  )!;
  const { registry, enabled } = usePlugins();
  const widgets = registry.widgets(enabled, 'widgets');
  return (
    <>
      <div className="inspector-heading">
        <h2>{t('session context')}</h2>
        <button className="text-button" onClick={() => onDialog('session')}>
          {t('details')}
          <ArrowUpRight size={12} />
        </button>
      </div>
      <Facts
        values={{
          [t('workspace')]: (
            <span className="context-workspace-path" title={workspace.path}>
              <bdi dir="ltr">{workspace.path}</bdi>
            </span>
          ),
          [t('model')]: session.model,
          [t('effort')]: EFFORT_TEXT[session.effort]?.label() ?? session.effort,
          [t('mode')]: MODE_TEXT[sessionMode(session)].label(),
          [t('connection')]: snapshot.runtime?.configured
            ? t('configured')
            : t('not configured'),
        }}
      />
      <div className="panel-section">
        <h3>{t('instructions')}</h3>
        {!workspace.instructions.length && (
          <p className="muted">{t('no instruction files loaded')}</p>
        )}
        {workspace.instructions.map((item) => (
          <details key={item.path ?? item.name} className="context-source">
            <summary>
              <FileText size={14} />
              {item.name.split(/[\\/]/).pop()}
            </summary>
            {item.path && (
              <button
                className="text-button"
                onClick={() => sources?.openFile(item.path!)}
              >
                {item.path}
              </button>
            )}
            <pre>{item.content}</pre>
          </details>
        ))}
      </div>
      <div className="panel-section">
        <h3>
          {t('attached context')} <span>{session.attachments.length}</span>
        </h3>
        {session.attachments.length ? (
          session.attachments.map((file) => (
            <details className="context-source" key={file.id}>
              <summary>
                <FileText size={14} />
                {file.name}
                <span>{ATTACHMENT_KIND[file.kind]?.() ?? file.kind}</span>
              </summary>
              {file.kind === 'image' ? (
                <img
                  className="attachment-image"
                  src={file.content}
                  alt={file.name}
                />
              ) : (
                <TerminalSelectionPreview file={file} />
              )}
              {file.truncated && (
                <p className="panel-note">
                  {t('preview truncated; original file not stored')}
                </p>
              )}
              <Button
                onClick={() =>
                  perform(() =>
                    runtime.change((state) => {
                      currentSession(state).attachments = currentSession(
                        state,
                      ).attachments.filter((item) => item.id !== file.id);
                    }),
                  )
                }
              >
                {t('remove')}
              </Button>
            </details>
          ))
        ) : (
          <p className="muted">{t('no files or skills attached')}</p>
        )}
      </div>
      {widgets.map(({ plugin, widget }) => (
        <PluginBoundary key={widget.id} name={plugin.title}>
          <widget.component sessionId={session.id} />
        </PluginBoundary>
      ))}
      {runtime.mode !== 'live' && (
        <div className="panel-section">
          <h3>
            {t('unsent actions')}{' '}
            <span>
              {
                snapshot.requests.filter(
                  (item) => item.sessionId === session.id,
                ).length
              }
            </span>
          </h3>
          {snapshot.requests
            .filter((item) => item.sessionId === session.id)
            .slice(0, 8)
            .map((request) => (
              <details className="context-source" key={request.id}>
                <summary>
                  {request.kind}
                  <small>{t('not sent')}</small>
                </summary>
                <DataBlock title={t('request')} value={request} />
              </details>
            ))}
        </div>
      )}
    </>
  );
}
export function ActivityPanel({
  selection,
  onAgent,
  onInteraction,
  onDialog,
}: Pick<Props, 'selection' | 'onAgent' | 'onInteraction' | 'onDialog'>) {
  const { snapshot, runtime, perform } = useRuntime();
  const session = currentSession(snapshot);
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState(selection);
  useEffect(() => setSelected(selection), [selection]);
  const job = snapshot.jobs.find((item) => item.id === selected);
  const jobs = snapshot.jobs.filter(
    (item) => all || item.sessionId === session.id,
  );
  const interactions = snapshot.interactions.filter(
    (item) => item.sessionId === session.id,
  );
  return (
    <>
      <div className="inspector-heading">
        <h2>{t('activity')}</h2>
        <button className="text-button" onClick={() => setAll(!all)}>
          {all ? t('this session') : t('all sessions')}
        </button>
      </div>
      {job ? (
        <div className="job-detail">
          <button className="text-button" onClick={() => setSelected('')}>
            ← {t('jobs')}
          </button>
          <h3>
            {job.id} · {job.title}
          </h3>
          <Status value={job.state} />
          <Facts
            values={{
              [t('elapsed')]: job.elapsed,
              [t('output')]: job.outputPath,
              [t('stop')]: job.stopRequested
                ? t('requested · unverified')
                : t('not requested'),
            }}
          />
          <pre>{job.output}</pre>
          <div className="detail-actions">
            {job.state === 'running' || job.state === 'waiting' ? (
              <Button
                disabled={job.stopRequested}
                onClick={() => onDialog('job-stop', job.id)}
              >
                {t('request stop')}
              </Button>
            ) : (
              <Button
                onClick={() =>
                  perform(() => {
                    runtime.change((state) => {
                      state.jobs = state.jobs.filter(
                        (item) => item.id !== job.id,
                      );
                    });
                    setSelected('');
                  })
                }
              >
                {t('remove from preview')}
              </Button>
            )}
            {job.agentId && (
              <Button onClick={() => onAgent(job.agentId!)}>
                {t('agent record')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="panel-section first">
            <h3>
              {t('jobs')} <span>{jobs.length}</span>
            </h3>
            {jobs.map((item) => (
              <button
                className="activity-row"
                key={item.id}
                onClick={() => setSelected(item.id)}
              >
                <Terminal size={15} />
                <span>
                  <strong>
                    {item.id} · {item.title}
                  </strong>
                  <small>
                    {item.sessionId !== session.id
                      ? t('other session') + ' · '
                      : ''}
                    {item.elapsed}
                    {item.stopRequested ? ' · ' + t('stop requested') : ''}
                  </small>
                </span>
                <Status value={item.state} />
              </button>
            ))}
          </div>
          <div className="panel-section">
            <h3>{t('subagents')}</h3>
            {snapshot.agents
              .filter((agent) => agent.sessionId === session.id)
              .map((agent) => (
                <button
                  className="activity-row"
                  key={agent.id}
                  onClick={() => onAgent(agent.id)}
                >
                  <Users size={15} />
                  <span>
                    <strong>{agent.name}</strong>
                    <small>{agentActivityText(agent)}</small>
                  </span>
                  <Status value={agentState(agent)} />
                </button>
              ))}
          </div>
        </>
      )}
      <div className="panel-section">
        <h3>
          {t('requests')}{' '}
          <span>
            {interactions.filter((item) => item.status === 'pending').length}
          </span>
        </h3>
        {interactions.map((item) => (
          <button
            className="activity-row"
            key={item.id}
            onClick={() => onInteraction(item)}
          >
            <ShieldCheck size={15} />
            <span>
              <strong>{item.title}</strong>
              <small>
                {REQUEST_KIND[item.kind]?.() ?? item.kind} ·{' '}
                {item.status === 'pending'
                  ? runtime.mode === 'live'
                    ? t('waiting for your response')
                    : 'sample request'
                  : runtime.mode === 'live'
                    ? t('response sent to Circle')
                    : 'response saved locally'}
              </small>
            </span>
            <ChevronRight size={13} />
          </button>
        ))}
      </div>
    </>
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
      </div>
      <div className="browser-empty">
        <Globe size={32} />
        <h3>{t('no browser attached')}</h3>
        <p>{t('browser preview only')}</p>
      </div>
    </>
  );
}
// What each session's terminal printed, kept while the app runs: switching panels or
// closing the inspector does not clear it.
const terminalOutput = new Map<string, string[]>();
export function TerminalPanel({
  onClose,
  embedded = false,
}: {
  onClose: () => void;
  embedded?: boolean;
}) {
  const { runtime, snapshot, perform } = useRuntime();
  const session = currentSession(snapshot);
  const [input, setInput] = useState('');
  const greeting = () => [
    runtime.mode === 'live' ? 'Circle shell' : 'terminal not connected',
    runtime.mode === 'live'
      ? t('Commands run in this session workspace.')
      : 'commands stay in the preview request log',
  ];
  const [output, setLines] = useState<string[]>(
    () => terminalOutput.get(session.id) ?? greeting(),
  );
  const setOutput = (update: (lines: string[]) => string[]) =>
    setLines((lines) => {
      const next = update(lines);
      terminalOutput.set(session.id, next);
      return next;
    });
  useEffect(() => {
    setInput('');
    setLines(terminalOutput.get(session.id) ?? greeting());
  }, [session.id]);
  return (
    <section className={`terminal-pane ${embedded ? 'embedded' : ''}`}>
      <header hidden={embedded}>
        <span>
          <Terminal size={14} />
          {t('terminal')}{' '}
          <small>
            {
              snapshot.workspaces.find(
                (workspace) => workspace.id === session.workspaceId,
              )?.name
            }
          </small>
        </span>
        <div>
          <span className="muted small">
            {runtime.mode === 'live' ? t('connected') : t('not connected')}
          </span>
          <IconButton label={t('close terminal')} onClick={onClose}>
            <X size={13} />
          </IconButton>
        </div>
      </header>
      <pre>{output.join('\n')}</pre>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim()) {
            if (runtime.mode === 'live') {
              const command = input;
              setInput('');
              setOutput((lines) => [...lines, '$ ' + command]);
              perform(async () => {
                const result = (await runtime.request('execute', {
                  command,
                })) as {
                  output: string;
                  exit_code?: number;
                  job?: { id: string };
                };
                setOutput((lines) => [
                  ...lines,
                  result.output,
                  result.job
                    ? t('background job {id}', { id: result.job.id })
                    : t('exit {code}', {
                        code: result.exit_code ?? t('unknown'),
                      }),
                ]);
              });
              return;
            }
            runtime.request('execute', { command: input });
            setOutput((lines) => [
              ...lines,
              '$ ' + input,
              'not executed · runtime connection required',
            ]);
            setInput('');
          }
        }}
      >
        <span>›</span>
        <input
          aria-label={t('terminal command')}
          value={input}
          placeholder={t('enter a command…')}
          onChange={(event) => setInput(event.target.value)}
        />
        <button aria-label={t('record terminal command')}>
          <ArrowUpRight size={14} />
        </button>
      </form>
    </section>
  );
}
