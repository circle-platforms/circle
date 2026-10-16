import type { CommandTerminalView } from '../model/command-terminal-client';
import { TerminalSelectionPreview } from '../components/TerminalSelectionPreview';
import { WorkspacePanelContents } from './WorkspacePanelContents';
import { useSources } from '../components/SourceNavigation';
import { desktopHost } from '../host';
import { agentActivityText, agentState } from '../model/activity';
import { NativeBrowser } from './NativeBrowser';
import { usePlugins } from '../plugins/context';
import { PluginBoundary } from '../plugins/Boundary';
import { useEffect, useState } from 'react';
import {
  FileText,
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
import type { PanelId, Interaction, DialogId } from '../model/types';
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
  commandTerminal?: CommandTerminalView;
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
export function Inspector(props: Props) {
  const { snapshot } = useRuntime();
  const session = currentSession(snapshot);
  const panels = usePanels();
  const selected = panels.find((item) => item.panel.id === props.panel);
  const terminal = props.panel === 'terminal';
  return (
    <aside className="inspector">
      <header className="inspector-title">
        <h2>
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
      <div className={`inspector-body ${terminal ? 'flush' : ''}`}>
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
                commandTerminal={
                  id === 'terminal' ? props.commandTerminal : undefined
                }
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
export function FilesPanel({
  selection,
  onFile,
}: Pick<Props, 'selection' | 'onFile'>) {
  const { snapshot } = useRuntime();
  const [query, setQuery] = useState('');
  const session = currentSession(snapshot);
  const files = snapshot.files.filter(
    (file) =>
      file.workspaceId === session.workspaceId &&
      file.path.toLowerCase().includes(query.toLowerCase()),
  );
  const folders = [
    ...new Set(
      files.map((file) =>
        file.path.includes('/') ? file.path.split('/')[0]! : 'root',
      ),
    ),
  ];
  return (
    <>
      <div className="inspector-heading">
        <h2>{t('files')}</h2>
        <span>
          {snapshot.workspaces.find(
            (workspace) => workspace.id === session.workspaceId,
          )?.origin === 'native'
            ? t('local workspace')
            : 'sample workspace'}
        </span>
      </div>
      <SearchInput
        value={query}
        onChange={setQuery}
        label={t('search files')}
        placeholder={t('find a file…')}
      />
      <div className="file-tree">
        {folders.map((folder) => (
          <div key={folder}>
            {folder !== 'root' && (
              <div className="tree-folder">
                <ChevronDown size={12} />
                <Folder size={14} />
                {folder}
              </div>
            )}
            {files
              .filter(
                (file) =>
                  (file.path.includes('/')
                    ? file.path.split('/')[0]
                    : 'root') === folder,
              )
              .map((file) => (
                <button
                  className={selection === file.path ? 'active' : ''}
                  key={file.id}
                  onClick={() => onFile(file.path)}
                >
                  <FileText size={14} />
                  <span>{file.path.split('/').at(-1)}</span>
                  {file.status && (
                    <small className={file.status}>
                      {file.status === 'added' ? 'A' : 'M'}
                    </small>
                  )}
                </button>
              ))}
          </div>
        ))}
      </div>
      <p className="panel-note">
        {snapshot.workspaces.find(
          (workspace) => workspace.id === session.workspaceId,
        )?.origin === 'native'
          ? files.length || query
            ? t('The folder Circle works in, read through granted handles.')
            : t(
                'Trust this folder to list its files here, or open it again with open folder.',
              )
          : 'Files shown here are isolated sample data. Opening a file does not access your disk.'}
      </p>
    </>
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
      <p className="panel-note">
        {t(
          'Files this session changed while the app was open, each against its version before the first change.',
        )}
      </p>
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
          [t('workspace')]: workspace.path,
          [t('model')]: session.model,
          [t('effort')]: EFFORT_TEXT[session.effort]?.() ?? session.effort,
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
              {item.name}
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
            {t('pending requests')}{' '}
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
          aria-label="browser address"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <IconButton
          label="request navigation"
          onClick={() => {
            try {
              const parsed = new URL(url);
              if (!['https:', 'http:'].includes(parsed.protocol)) throw Error();
              runtime.request('browser.navigate', { url });
              notify('navigation requested; no browser is attached');
            } catch {
              notify('enter an http or https URL');
            }
          }}
        >
          <ArrowUpRight size={14} />
        </IconButton>
      </div>
      <div className="browser-empty">
        <Globe size={32} />
        <h3>no browser attached</h3>
        <p>
          The desktop host will display the browser that the agent is using.
        </p>
        <span className="label">layout preview</span>
      </div>
      <div className="panel-section">
        <h3>same session, shared view</h3>
        <p>
          Page observation and control will refer to one browser session.
          Navigation requests are currently saved locally.
        </p>
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
