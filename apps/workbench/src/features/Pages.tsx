import { recordedDecision, recordedTitle } from '../model/decisions';
import { usePlugins } from '../plugins/context';
import { pairedSwitch, pairing } from '../plugins/registry';
import { extensionErrorText } from '../plugins/labels';
import {
  phaseAfterExtensionSave,
  reconcileExtensionAction,
} from './extension-actions';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  ArrowUpRight,
  Check,
  FileText,
  Terminal,
  Globe,
  Blocks,
  Settings2,
  ShieldCheck,
  Trash2,
  GitBranch,
  Copy,
  Pin,
  RotateCcw,
  Eye,
  ChevronLeft,
  ChevronRight,
  Command,
  BookOpen,
  Folder,
  Monitor,
  Code,
  Plug,
  MessageSquare,
} from 'lucide-react';
import { BUILTIN_SLASH } from '../../../../src/tui/slash_commands';
import { slashText } from '../model/slash-text';
import { useRuntime } from '../app/context';
import {
  COMMAND_UI,
  currentSession,
  EFFORTS,
  MODES,
  sessionMode,
  sessionTitle,
} from '../model/state';
import { EFFORT_TEXT, MODE_TEXT } from './Composer';
import { settingsSectionOf } from '../model/settings-sections';
import { shownTime } from '../model/time';
import { armComposerFocus } from '../model/composer-focus';
import { runControlAction } from '../model/session-row';
import { workspaceLabel } from '../model/workspace-label';
import type {
  DialogId,
  PageId,
  PanelId,
  McpServer,
  Effort,
} from '../model/types';
import {
  Page,
  SearchInput,
  Button,
  Choice,
  IconButton,
  Modal,
  Badge,
  DataBlock,
  Status,
  Switch,
  Facts,
  PreviewNotice,
  EmptyState,
} from '../components/common';
import { Markdown } from '../components/Markdown';
import { SessionMenu } from '../components/SessionMenus';
import {
  canArchiveSession,
  sessionActivityAt,
  topLevelSessions,
  visibleSessions,
} from '../model/session-management';
import { openHome } from './home-selection';
import { BUILTIN_TOOL_INFO } from '../model/tool-info';
import { t, tn } from '../i18n';
interface Props {
  page: PageId;
  onSession: () => void;
  onDialog: (dialog: DialogId, selection?: string) => void;
  onPanel: (panel: PanelId, selection?: string) => void;
}
/** The pages of the main window. Every other page is a group of the settings dialog. */
export function ManagementPage(props: Props) {
  return <SessionsPage {...props} />;
}
function SessionsPage({ onSession, onDialog }: Props) {
  const { snapshot, runtime, perform } = useRuntime();
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState('');
  // A task with no project is a folder of its own, so showing only "this workspace" while
  // one is open would hide every other task: those pages start on all workspaces.
  const [all, setAll] = useState(() => {
    const here = currentSession(snapshot);
    return snapshot.workspaces.some(
      (workspace) => workspace.id === here.workspaceId && workspace.task,
    );
  });
  const [archived, setArchived] = useState(false);
  const current = currentSession(snapshot);
  const openedOnPress = useRef(false);
  // Task conversations are reached from the conversation that started them.
  const sessions = visibleSessions(
    topLevelSessions(snapshot.sessions, snapshot.agents),
  ).filter(
    (session) =>
      (all || session.workspaceId === current.workspaceId) &&
      Boolean(session.archivedAt) === archived &&
      (session.title + ' ' + session.id)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <Page
      title={t('sessions')}
      description={t(
        'Reopen a conversation or continue from an earlier point.',
      )}
      action={
        <Button
          onPointerDown={(event) => {
            if (
              !runControlAction({
                kind: 'press',
                button: event.button,
                actedOnPress: false,
              })
            )
              return;
            openedOnPress.current = true;
            armComposerFocus();
            openHome(navigate, `${location.pathname}${location.search}`);
          }}
          onClick={() => {
            const again = runControlAction({
              kind: 'click',
              button: 0,
              actedOnPress: openedOnPress.current,
            });
            openedOnPress.current = false;
            if (!again) return;
            armComposerFocus();
            openHome(navigate, `${location.pathname}${location.search}`);
          }}
        >
          <Plus size={14} />
          {t('new session')}
        </Button>
      }
    >
      <div className="list-toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          label={t('search sessions')}
        />
        <Switch label={t('all workspaces')} checked={all} onChange={setAll} />
        <Switch
          label={t('archived sessions')}
          checked={archived}
          onChange={setArchived}
        />
      </div>
      <div className="records">
        {sessions.map((session) => (
          <div className="record-row" key={session.id}>
            <button
              className="record-main"
              onClick={() =>
                perform(async () => {
                  await runtime.selectSession(session.id);
                  onSession();
                })
              }
            >
              <MessageSquare size={17} />
              <span>
                <strong>{sessionTitle(session.title)}</strong>
                <small>
                  {workspaceLabel(
                    snapshot.workspaces.find(
                      (workspace) => workspace.id === session.workspaceId,
                    ) ?? { name: '' },
                  )}{' '}
                  · {shownTime(sessionActivityAt(session))}
                </small>
              </span>
              {session.id === current.id && (
                <span className="viewing-tag">{t('viewing')}</span>
              )}
              {session.archivedAt && <Badge>{t('archived')}</Badge>}
            </button>
            <IconButton
              label={t('pin {title}', { title: session.title })}
              onClick={() =>
                perform(() =>
                  runtime.change((state) => {
                    const target = state.sessions.find(
                      (item) => item.id === session.id,
                    )!;
                    target.pinned = !target.pinned;
                  }),
                )
              }
            >
              <Pin size={14} fill={session.pinned ? 'currentColor' : 'none'} />
            </IconButton>
            <SessionMenu session={session} onDialog={onDialog} />
            <IconButton
              label={t('rename {title}', { title: session.title })}
              onClick={() => onDialog('rename', session.id)}
            >
              <FileText size={14} />
            </IconButton>
            <IconButton
              label={t('delete {title}', { title: session.title })}
              disabled={
                session.lifecycle === 'deleting' ||
                session.occupied ||
                (runtime.mode !== 'live' &&
                  (session.id === current.id ||
                    !canArchiveSession(snapshot, session)))
              }
              onClick={() => onDialog('delete-session', session.id)}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
      </div>
    </Page>
  );
}
export function ModelsPage({ onDialog }: { onDialog: Props['onDialog'] }) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(currentSession(snapshot).model);
  const [saveDefault, setSaveDefault] = useState(false);
  // Why refresh found no list: an endpoint that does not list its models (an Anthropic-style
  // path without GET /v1/models) still takes a model id typed here.
  const [unlisted, setUnlisted] = useState('');
  const session = currentSession(snapshot);
  // models.dev prices are in US dollars per million tokens
  const usageModel = snapshot.models.find((item) => item.id === session.model);
  const price = (value: number | null | undefined) =>
    value === null || value === undefined
      ? 'N/A'
      : t('{amount} per million tokens', { amount: '$' + value });
  const models = snapshot.models.filter((model) =>
    (model.id + ' ' + model.provider).includes(query),
  );
  const choose = (id: string) =>
    perform(async () => {
      if (session.state === 'waiting')
        throw Error(
          t('pause the current conversation before switching models'),
        );
      if (runtime.mode === 'live') {
        await runtime.request('set-model', { modelId: id, saveDefault });
        notify(t('model selected'));
        return;
      }
      runtime.change((state) => {
        currentSession(state).model = id;
        if (saveDefault) state.settings.defaultModel = id;
      });
      runtime.request('set-model', { modelId: id, saveDefault });
      notify('model choice saved locally');
    });
  return (
    <Page
      title={t('models')}
      description={t('Choose the model and thinking depth for this session.')}
      action={
        <div className="inline-actions">
          {runtime.mode === 'live' && (
            <Button
              onClick={() =>
                perform(async () => {
                  const found = (await runtime.request('discover-models')) as {
                    status?: string;
                    detail?: string;
                  };
                  if (found?.status === 'failed') {
                    setUnlisted(found.detail || t('model discovery failed'));
                    return;
                  }
                  setUnlisted('');
                  notify(t('models refreshed'));
                })
              }
            >
              {t('refresh models')}
            </Button>
          )}
          <Button onClick={() => onDialog('connect')}>
            <Plug size={14} />
            {t('connection')}
          </Button>
        </div>
      }
    >
      <div className="connection-banner">
        <span>
          <i />
          {runtime.mode === 'live' && snapshot.runtime?.configured
            ? t('configured')
            : t('not connected')}
        </span>
        <code>{snapshot.settings.endpoint || t('no endpoint configured')}</code>
      </div>
      {unlisted && (
        <p className="panel-note" role="status">
          {t(
            'The endpoint did not list its models ({detail}). Search for the model id below and use it.',
            { detail: unlisted },
          )}
        </p>
      )}
      <section className="settings-block first">
        <h2>{t('defaults for new sessions')}</h2>
        <div className="setting-row">
          <span>
            {t('model')}
            <small>{t('change it with “save as default” below')}</small>
          </span>
          <code>{snapshot.settings.defaultModel}</code>
        </div>
        <Choice
          label={t('thinking depth')}
          value={snapshot.settings.defaultEffort}
          options={(['default', ...EFFORTS] as Effort[]).map(
            (value) => [value, EFFORT_TEXT[value].label()] as const,
          )}
          onChange={(value) =>
            perform(() =>
              runtime.change((state) => {
                state.settings.defaultEffort = value;
              }),
            )
          }
        />
      </section>
      <section className="settings-block">
        <h2>{t('this session')}</h2>
        <div className="list-toolbar">
          <SearchInput
            value={query}
            onChange={setQuery}
            label={t('search models')}
          />
          <Switch
            label={t('save as default')}
            checked={saveDefault}
            onChange={setSaveDefault}
          />
        </div>
        <div className="model-list">
          {models.map((model) => (
            <div
              className={
                model.id === selected ? 'model-row selected' : 'model-row'
              }
              key={model.id}
            >
              <button onClick={() => setSelected(model.id)}>
                <span className="model-glyph">
                  <Blocks size={17} />
                </span>
                <span>
                  <strong>{model.id}</strong>
                  <small>{model.provider}</small>
                </span>
                <span>
                  {t('{size} context', {
                    size: model.contextWindow?.toLocaleString() ?? 'N/A',
                  })}
                </span>
                <span>{model.vision ? t('text + image') : t('text')}</span>
                {session.model === model.id && <Badge>{t('current')}</Badge>}
              </button>
              <label
                title={t('include in model cycling')}
                className="check-label"
              >
                <input
                  type="checkbox"
                  aria-label={t('cycle {model}', { model: model.id })}
                  checked={
                    !snapshot.settings.enabledModels.length ||
                    snapshot.settings.enabledModels.includes(model.id)
                  }
                  onChange={(event) =>
                    perform(() =>
                      runtime.change((state) => {
                        const enabled = state.settings.enabledModels.length
                          ? state.settings.enabledModels
                          : state.models.map((item) => item.id);
                        state.settings.enabledModels = event.target.checked
                          ? [...new Set([...enabled, model.id])]
                          : enabled.filter((id) => id !== model.id);
                      }),
                    )
                  }
                />
              </label>
              <Button
                disabled={session.state === 'waiting'}
                onClick={() => choose(model.id)}
              >
                {t('use model')}
              </Button>
            </div>
          ))}
          {!models.length && query.trim() && (
            <Button onClick={() => choose(query.trim())}>
              {t('use “{model}”', { model: query.trim() })}
            </Button>
          )}
        </div>
      </section>
      <section className="settings-block">
        <h2>{t('thinking depth')}</h2>
        <p>
          {t(
            'Applied to the current session. The connected runtime will report which levels the model accepts.',
          )}
        </p>
        <div className="effort-options">
          {EFFORTS.map((effort) => (
            <button
              key={effort}
              className={session.effort === effort ? 'active' : ''}
              disabled={session.state === 'waiting'}
              onClick={() =>
                perform(() =>
                  runtime.change((state) => {
                    currentSession(state).effort = effort;
                    if (saveDefault) state.settings.defaultEffort = effort;
                  }),
                )
              }
            >
              {EFFORT_TEXT[effort].label()}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-block">
        <h2>{t('usage')}</h2>
        <Facts
          values={{
            [t('input price')]: price(usageModel?.inputPrice),
            [t('output price')]: price(usageModel?.outputPrice),
            [t('cache usage')]: session.meters?.input
              ? `${((Math.min(session.meters.cacheRead, session.meters.input) / session.meters.input) * 100).toFixed(1)}%`
              : 'N/A',
            [t('source')]:
              runtime.mode === 'live'
                ? t('models.dev and your settings')
                : 'sample catalog; no endpoint queried',
          }}
        />
      </section>
    </Page>
  );
}
export function SkillsPage() {
  const { snapshot, runtime, act, perform, notify } = useRuntime();
  const [query, setQuery] = useState('');
  const [id, setId] = useState(snapshot.skills[0]?.id ?? '');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '', body: '' });
  const selected = snapshot.skills.find((skill) => skill.id === id);
  const addSkill = () =>
    perform(async () => {
      const name = draft.name.trim();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        notify(t('use a name like review-diff'));
        return;
      }
      if (runtime.mode === 'live')
        await runtime.request('create-skill', {
          name,
          description: draft.description.trim(),
          body: draft.body,
        });
      else
        runtime.change((state) => {
          state.skills.push({
            id: name,
            name,
            description: draft.description.trim(),
            path: `.circle/skills/${name}/SKILL.md`,
            scope: 'project',
            content: draft.body,
          });
        });
      setAdding(false);
      setDraft({ name: '', description: '', body: '' });
      notify(t('skill added'));
    });
  return (
    <Page
      title={t('skills')}
      description={t('Instructions loaded into a conversation when needed.')}
      action={
        <div className="inline-actions">
          <Button
            onClick={() => {
              runtime.request('reload');
              notify(
                runtime.mode === 'live'
                  ? t('reloading skills')
                  : 'reload requested; nothing was loaded',
              );
            }}
          >
            <RotateCcw size={13} />
            {t('reload')}
          </Button>
          <Button onClick={() => setAdding((value) => !value)}>
            <Plus size={14} />
            {t('add skill')}
          </Button>
        </div>
      }
    >
      {adding && (
        <form
          className="form-stack skill-draft"
          onSubmit={(event) => {
            event.preventDefault();
            addSkill();
          }}
        >
          <label className="field-label" htmlFor="skill-name">
            {t('skill name')}
          </label>
          <input
            id="skill-name"
            className="input"
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
          <label className="field-label" htmlFor="skill-description">
            {t('skill description')}
          </label>
          <input
            id="skill-description"
            className="input"
            value={draft.description}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value })
            }
          />
          <label className="field-label" htmlFor="skill-body">
            {t('skill instructions')}
          </label>
          <textarea
            id="skill-body"
            className="input short"
            value={draft.body}
            onChange={(event) =>
              setDraft({ ...draft, body: event.target.value })
            }
          />
          <Button type="submit" className="primary">
            {t('add skill')}
          </Button>
        </form>
      )}
      {snapshot.skills.length ? (
        <div className="catalog-layout">
          <div>
            <SearchInput
              value={query}
              onChange={setQuery}
              label={t('search skills')}
            />
            {snapshot.skills
              .filter((skill) =>
                (skill.name + ' ' + skill.description).includes(query),
              )
              .map((skill) => (
                <button
                  className={
                    skill.id === id ? 'catalog-row active' : 'catalog-row'
                  }
                  key={skill.id}
                  onClick={() => setId(skill.id)}
                >
                  <BookOpen size={16} />
                  <span>
                    <strong>{skill.name}</strong>
                    <small>{scopeLabel(skill.scope)}</small>
                  </span>
                </button>
              ))}
          </div>
          <div className="catalog-detail">
            {selected && (
              <>
                <div className="detail-title">
                  <div>
                    <h2>{selected.name}</h2>
                    <p>{selected.description}</p>
                  </div>
                  <Button
                    disabled={currentSession(snapshot).state === 'waiting'}
                    onClick={() =>
                      act(() => runtime.command('skill', selected.name))
                    }
                  >
                    <Plus size={14} />
                    {t('add to session')}
                  </Button>
                </div>
                <code className="file-path">{selected.path}</code>
                <Markdown text={selected.content} />
              </>
            )}
          </div>
        </div>
      ) : (
        <EmptyState title={t('no skills yet')} icon={<BookOpen size={25} />}>
          {t(
            'Add a folder with a SKILL.md file to .circle/skills in your project. Circle reads it when a session starts.',
          )}
        </EmptyState>
      )}
    </Page>
  );
}
export function CommandsPage() {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [id, setId] = useState(snapshot.commands[0]?.name ?? '');
  const [selectedTemplate, setTemplate] = useState('');
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const selected = snapshot.commands.find((command) => command.name === id);
  return (
    <Page
      title={t('commands')}
      description={t(
        'Reusable prompts from your project, user folders and extensions.',
      )}
      action={
        <Button
          onClick={() => {
            const name = 'new-command-' + (snapshot.commands.length + 1);
            runtime.change((state) =>
              state.commands.push({
                name,
                description:
                  runtime.mode === 'live'
                    ? 'a reusable prompt'
                    : 'a local preview command',
                arguments: '[args]',
                scope: 'project',
                template: '$ARGUMENTS',
              }),
            );
            setId(name);
          }}
        >
          <Plus size={14} />
          {t('new command')}
        </Button>
      }
    >
      {snapshot.commands.length ? (
        <div className="catalog-layout">
          <div>
            <SearchInput
              value={query}
              onChange={setQuery}
              label={t('search commands')}
            />
            {snapshot.commands
              .filter((command) =>
                (command.name + ' ' + command.description).includes(query),
              )
              .map((command) => (
                <button
                  key={command.name}
                  className={
                    command.name === id ? 'catalog-row active' : 'catalog-row'
                  }
                  onClick={() => {
                    setId(command.name);
                    setEditing(false);
                  }}
                >
                  <Command size={15} />
                  <span>
                    <strong>/{command.name}</strong>
                    <small>{command.scope}</small>
                  </span>
                </button>
              ))}
          </div>
          <div className="catalog-detail">
            {selected && (
              <>
                <div className="detail-title">
                  <div>
                    <h2>
                      /{selected.name} {selected.arguments}
                    </h2>
                    <p>{selected.description}</p>
                  </div>
                  <Button
                    onClick={() => {
                      setTemplate(selected.template);
                      setEditing(true);
                    }}
                  >
                    {t('edit template')}
                  </Button>
                </div>
                {editing ? (
                  <>
                    <textarea
                      aria-label={t('command template')}
                      className="code-editor short"
                      value={selectedTemplate}
                      onChange={(event) => setTemplate(event.target.value)}
                    />
                    <Button
                      onClick={() =>
                        perform(() => {
                          runtime.change((state) => {
                            state.commands.find(
                              (command) => command.name === id,
                            )!.template = selectedTemplate;
                          });
                          setEditing(false);
                          notify(
                            runtime.mode === 'live'
                              ? t('saving command template')
                              : 'template saved to local preview',
                          );
                        })
                      }
                    >
                      {t('save template')}
                    </Button>
                  </>
                ) : (
                  <pre className="source-preview">{selected.template}</pre>
                )}
                <p className="panel-note">
                  {t(
                    'Shell snippets remain plain text in this frontend. A connected runtime must expand and execute a custom command.',
                  )}
                </p>
                <Button
                  onClick={() => {
                    runtime.change((state) => {
                      currentSession(state).draft = '/' + selected.name + ' ';
                    });
                    notify(t('command added to the message draft'));
                  }}
                >
                  {t('insert into draft')}
                  <ArrowUpRight size={12} />
                </Button>
              </>
            )}
          </div>
        </div>
      ) : (
        <EmptyState title={t('no commands yet')} icon={<Command size={25} />}>
          {t(
            'Save a prompt as a Markdown file in .circle/commands in your project, or use new command.',
          )}
        </EmptyState>
      )}
    </Page>
  );
}
export function McpPage() {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const server = snapshot.mcp.find((item) => item.id === selected);
  return (
    <Page
      title={t('mcp servers')}
      description={t(
        'Separate programs Circle connects to over MCP, and the tools they offer.',
      )}
      action={
        <div className="inline-actions">
          <Button
            onClick={() => {
              runtime.request('mcp.reload');
              notify(
                runtime.mode === 'live'
                  ? t('reloading MCP servers')
                  : 'reload requested; no server was started',
              );
            }}
          >
            <RotateCcw size={13} />
            {t('reload')}
          </Button>
          <Button
            onClick={() =>
              setEditing({
                id: crypto.randomUUID(),
                name: '',
                transport: 'stdio',
                command: '',
                args: '',
                url: '',
                enabled: true,
                status: 'not connected',
                tools: [],
              })
            }
          >
            <Plus size={14} />
            {t('add server')}
          </Button>
        </div>
      }
    >
      {!snapshot.mcp.length && (
        <EmptyState title={t('no MCP servers yet')} icon={<Plug size={25} />}>
          {t('Add a server to give Circle tools from another program.')}
        </EmptyState>
      )}
      {snapshot.mcp.length > 0 && (
        <div className="records">
          {snapshot.mcp.map((item) => (
            <div key={item.id} className="record-row">
              <button
                className="record-main"
                onClick={() => setSelected(item.id)}
              >
                <Plug size={18} />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.transport} ·{' '}
                    {tn(item.tools.length, '{n} tool', '{n} tools')}
                    {item.error ? ' · ' + item.error : ''}
                  </small>
                </span>
                <Status value={item.status} />
              </button>
              <Button onClick={() => setEditing(structuredClone(item))}>
                {t('configure')}
              </Button>
              <Switch
                label={t('enable {name}', { name: item.name })}
                checked={item.enabled}
                onChange={(enabled) =>
                  perform(() =>
                    runtime.change((state) => {
                      state.mcp.find(
                        (server) => server.id === item.id,
                      )!.enabled = enabled;
                    }),
                  )
                }
              />
            </div>
          ))}
        </div>
      )}
      <Modal
        open={!!server}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={server?.name ?? t('server')}
        wide
      >
        {server && (
          <>
            <Facts
              values={{
                [t('transport')]: server.transport,
                [t('command')]: server.command || '—',
                [t('arguments')]: server.args || '—',
                [t('url')]: server.url || '—',
                [t('status')]: server.status,
              }}
            />
            {server.tools.map((tool) => (
              <details key={tool.name} className="tool-definition">
                <summary>
                  {tool.name}
                  <span>{tool.description}</span>
                </summary>
                <DataBlock title={t('input schema')} value={tool.schema} />
              </details>
            ))}
            {!server.tools.length && (
              <p className="muted">{t('no tools discovered')}</p>
            )}
          </>
        )}
      </Modal>
      <Modal
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={t('server configuration')}
        description={
          runtime.mode === 'live'
            ? t('Save in Circle settings. Reload to connect the server.')
            : 'Saved only in this browser. No process or connection is started.'
        }
      >
        {editing && (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !editing.name.trim() ||
                !(editing.transport === 'stdio' ? editing.command : editing.url)
              ) {
                notify(t('enter a name and a command or URL'));
                return;
              }
              perform(() => {
                runtime.change((state) => {
                  const index = state.mcp.findIndex(
                    (item) => item.id === editing.id,
                  );
                  if (index >= 0) state.mcp[index] = editing;
                  else state.mcp.push(editing);
                });
                setEditing(null);
                notify(t('server configuration saved locally'));
              });
            }}
          >
            <label>
              {t('name')}
              <input
                required
                value={editing.name}
                onChange={(event) =>
                  setEditing({ ...editing, name: event.target.value })
                }
              />
            </label>
            <label>
              {t('transport')}
              <select
                value={editing.transport}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    transport: event.target.value as McpServer['transport'],
                  })
                }
              >
                {['stdio', 'sse', 'streamable_http', 'websocket'].map(
                  (value) => (
                    <option key={value}>{value}</option>
                  ),
                )}
              </select>
            </label>
            {editing.transport === 'stdio' ? (
              <>
                <label>
                  {t('command')}
                  <input
                    required
                    value={editing.command}
                    onChange={(event) =>
                      setEditing({ ...editing, command: event.target.value })
                    }
                  />
                </label>
                <label>
                  {t('arguments')}
                  <input
                    value={editing.args}
                    onChange={(event) =>
                      setEditing({ ...editing, args: event.target.value })
                    }
                  />
                </label>
              </>
            ) : (
              <label>
                {t('url')}
                <input
                  required
                  type="url"
                  value={editing.url}
                  onChange={(event) =>
                    setEditing({ ...editing, url: event.target.value })
                  }
                />
              </label>
            )}
            {runtime.mode !== 'live' && (
              <p className="panel-note">
                Environment secrets will be supplied by the runtime. This
                preview does not collect them.
              </p>
            )}
            <Button type="submit" className="primary">
              {t('save configuration')}
            </Button>
          </form>
        )}
      </Modal>
    </Page>
  );
}
function scopeLabel(scope: string): string {
  switch (scope) {
    case 'bundled':
      return t('bundled');
    case 'project':
      return t('project');
    case 'user':
      return t('user');
    default:
      return scope;
  }
}
export function ExtensionsPage() {
  const { snapshot, runtime, notify } = useRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'runtime' | 'interface'>('runtime');
  const { registry, enabled, toggle } = usePlugins();
  type ExtensionAction = {
    target: boolean;
    revision: number;
    phase:
      | 'saving'
      | 'waiting'
      | 'reload'
      | 'complete'
      | 'preview'
      | 'save-error'
      | 'load-error';
    error?: string;
    reloaded?: boolean;
  };
  const [actions, setActions] = useState<Record<string, ExtensionAction>>({});
  const revisions = useRef(new Map<string, number>());
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState('');
  useEffect(() => {
    let changed = false;
    const next = { ...actions };
    for (const [name, action] of Object.entries(actions)) {
      const extension = snapshot.extensions.find((item) => item.name === name);
      const resolved = reconcileExtensionAction(name, action, extension);
      if (resolved === 'keep' || resolved === action) continue;
      next[name] = resolved;
      changed = true;
    }
    if (changed)
      setActions((current) => {
        const merged = { ...current };
        let applied = false;
        for (const [name, previous] of Object.entries(actions)) {
          if (
            current[name]?.revision !== previous.revision ||
            current[name]?.phase !== previous.phase ||
            next[name] === previous
          )
            continue;
          if (next[name]) merged[name] = next[name];
          else delete merged[name];
          applied = true;
        }
        return applied ? merged : current;
      });
  }, [snapshot.extensions, actions]);
  async function setExtension(name: string, target: boolean) {
    const revision = (revisions.current.get(name) ?? 0) + 1;
    revisions.current.set(name, revision);
    setActions((current) => ({
      ...current,
      [name]: { target, revision, phase: 'saving' },
    }));
    try {
      await runtime.request('extension.enabled', { name, enabled: target });
      if (revisions.current.get(name) !== revision) return;
      setActions((current) => ({
        ...current,
        [name]: {
          target,
          revision,
          phase: phaseAfterExtensionSave(runtime.mode, name, target),
        },
      }));
    } catch (error) {
      if (revisions.current.get(name) !== revision) return;
      setActions((current) => ({
        ...current,
        [name]: { target, revision, phase: 'save-error', error: String(error) },
      }));
    }
  }
  const checkedExtension = (name: string, fallback: boolean) => {
    const action = actions[name];
    return action && ['saving', 'waiting', 'reload'].includes(action.phase)
      ? action.target
      : fallback;
  };
  const feedback = (name: string) => {
    const action = actions[name];
    if (!action) return null;
    const failed =
      action.phase === 'save-error' || action.phase === 'load-error';
    return (
      <div role={failed ? 'alert' : 'status'}>
        <p className="panel-note">
          {action.phase === 'saving'
            ? action.target
              ? t('saving extension enable request')
              : t('saving extension disable request')
            : action.phase === 'waiting'
              ? action.target
                ? t('enabling extension')
                : t('disabling extension')
              : action.phase === 'reload'
                ? t('extension setting saved; reload required')
                : action.phase === 'preview'
                  ? t('preview setting updated; no extension code was loaded')
                  : action.phase === 'save-error'
                    ? t('extension setting could not be saved')
                    : action.phase === 'load-error'
                      ? t('extension could not be loaded')
                      : action.target
                        ? t('extension enabled')
                        : t('extension disabled')}
        </p>
        {failed && action.error && (
          <details className="context-source">
            <summary>{t('technical details')}</summary>
            <pre>{action.error}</pre>
          </details>
        )}
      </div>
    );
  };
  async function reloadExtensions() {
    setReloading(true);
    setReloadError('');
    try {
      await runtime.request('extensions.reload');
      if (runtime.mode === 'preview')
        notify(t('extension reload recorded; no code was loaded'));
      else
        setActions((current) =>
          Object.fromEntries(
            Object.entries(current).map(([name, action]) => [
              name,
              action.phase === 'reload'
                ? { ...action, phase: 'waiting' as const, reloaded: true }
                : action,
            ]),
          ),
        );
    } catch (error) {
      setReloadError(String(error));
    } finally {
      setReloading(false);
    }
  }

  const detailId = new URLSearchParams(location.search).get('plugin');
  const detailPlugin = registry.plugins.find(
    (plugin) => plugin.id === detailId && plugin.detail,
  );
  if (detailPlugin?.detail) {
    const Detail = detailPlugin.detail;
    const name = detailPlugin.runtimeExtension;
    return (
      <Page
        title={detailPlugin.title}
        description={detailPlugin.description}
        className="plugin-detail-page"
        action={
          <Button onClick={() => navigate('/page/extensions')}>
            <ChevronLeft size={14} />
            {t('back to plugins')}
          </Button>
        }
      >
        <Detail
          enabled={
            name
              ? checkedExtension(
                  name,
                  snapshot.extensions.find(
                    (item) => item.name === name && item.scope === 'bundled',
                  )?.enabled ?? false,
                )
              : enabled.includes(detailPlugin.id)
          }
          onToggle={(value) =>
            name
              ? void setExtension(name, value)
              : toggle(detailPlugin.id, value)
          }
          // Once the switch has settled, the page's own state says the rest.
          feedback={
            name && actions[name]?.phase !== 'complete'
              ? feedback(name)
              : undefined
          }
        />
      </Page>
    );
  }
  return (
    <Page
      title={t('extensions')}
      description={t(
        'Extensions add tools, commands and checks written in JavaScript or TypeScript.',
      )}
      action={
        <Button disabled={reloading} onClick={() => void reloadExtensions()}>
          <RotateCcw size={14} />
          {t('reload')}
        </Button>
      }
    >
      {reloadError && (
        <div role="alert">
          <p>{t('extension could not be loaded')}</p>
          <details className="context-source">
            <summary>{t('technical details')}</summary>
            <pre>{reloadError}</pre>
          </details>
        </div>
      )}
      <div className="segmented page-tabs">
        <button
          className={tab === 'runtime' ? 'active' : ''}
          onClick={() => setTab('runtime')}
        >
          {t('runtime extensions')}
        </button>
        <button
          className={tab === 'interface' ? 'active' : ''}
          onClick={() => setTab('interface')}
        >
          {t('interface components')}
        </button>
      </div>
      {tab === 'runtime' ? (
        <div className="extension-list">
          {!snapshot.extensions.length && (
            <EmptyState
              title={t('no extensions yet')}
              icon={<Blocks size={25} />}
            >
              {t(
                'Put an extension in .circle/extensions/<name>/ in your project, then reload.',
              )}
            </EmptyState>
          )}
          {snapshot.extensions.map((extension) => (
            <article className="extension-card" key={extension.id}>
              <div className="detail-title">
                <span className="extension-icon">
                  <Blocks size={21} />
                </span>
                <div>
                  <h2>{extension.name}</h2>
                  <p>
                    {scopeLabel(extension.scope)} · {extension.version}
                  </p>
                </div>
                <Switch
                  label={t('enable {name}', {
                    name: extension.name,
                  })}
                  checked={checkedExtension(extension.name, extension.enabled)}
                  onChange={(value) => void setExtension(extension.name, value)}
                />
              </div>
              {registry.plugins.find(
                (plugin) =>
                  plugin.runtimeExtension === extension.name && plugin.detail,
              ) && (
                <NavLink
                  to={
                    '/page/extensions?plugin=' +
                    registry.plugins.find(
                      (plugin) =>
                        plugin.runtimeExtension === extension.name &&
                        plugin.detail,
                    )!.id
                  }
                >
                  {t('plugin details')}
                </NavLink>
              )}
              {feedback(extension.name)}
              {extension.error && !actions[extension.name] && (
                <div role="alert">
                  <p>{extensionErrorText(extension.error)}</p>
                  <details className="context-source">
                    <summary>{t('technical details')}</summary>
                    <pre>{extension.error}</pre>
                  </details>
                </div>
              )}
              <div className="extension-contributions">
                <span>
                  {tn(extension.tools.length, '{n} tool', '{n} tools')}
                </span>
                <span>
                  {tn(extension.commands.length, '{n} command', '{n} commands')}
                </span>
                <span>
                  {tn(
                    extension.events.length,
                    '{n} event handler',
                    '{n} event handlers',
                  )}
                </span>
              </div>
              <details>
                <summary>{t('contributions')}</summary>
                <DataBlock
                  title={t('registered items')}
                  value={{
                    tools: extension.tools,
                    commands: extension.commands,
                    events: extension.events,
                  }}
                />
              </details>
            </article>
          ))}
        </div>
      ) : (
        <div className="extension-list">
          {registry.plugins.map((plugin) => (
            <article className="extension-card" key={plugin.id}>
              <div className="detail-title">
                <Blocks size={20} />
                <div>
                  <h2>{plugin.title}</h2>
                  <p>{plugin.description}</p>
                </div>
                <Switch
                  label={t('enable {name} interface', {
                    name: plugin.title,
                  })}
                  checked={
                    plugin.runtimeExtension
                      ? checkedExtension(
                          plugin.runtimeExtension,
                          enabled.includes(plugin.id),
                        )
                      : enabled.includes(plugin.id)
                  }
                  onChange={(value) => {
                    if (!plugin.runtimeExtension)
                      return toggle(plugin.id, value);
                    // The interface's own page comes and goes with this switch; the
                    // runtime extension follows through its usual save and reload, and
                    // stays on while another of its pages is still on.
                    let extension = value;
                    runtime.change((state) => {
                      const after = pairedSwitch(
                        registry,
                        state.uiPlugins,
                        plugin.id,
                        value,
                      );
                      state.uiPlugins = after.chosen;
                      extension = after.extension;
                    });
                    if (value || !extension)
                      void setExtension(plugin.runtimeExtension, value);
                  }}
                />
              </div>
              {plugin.detail && (
                <NavLink to={'/page/extensions?plugin=' + plugin.id}>
                  {t('plugin details')}
                </NavLink>
              )}
              {plugin.runtimeExtension && feedback(plugin.runtimeExtension)}
              <p className="panel-note">
                {plugin.runtimeExtension
                  ? t('paired with runtime extension {name} · {version}', {
                      name: plugin.runtimeExtension,
                      version: plugin.version,
                    }) +
                    (pairing(plugin, snapshot.extensions).reason
                      ? ' · ' + pairing(plugin, snapshot.extensions).reason
                      : '')
                  : t('bundled first-party component · {version}', {
                      version: plugin.version,
                    })}
              </p>
            </article>
          ))}
        </div>
      )}
    </Page>
  );
}
// What a tool does to the machine, as the core sorts tools.
const TOOL_KIND: Record<string, () => string> = {
  read: () => t('reads only'),
  write: () => t('changes files'),
  execute: () => t('runs commands'),
  unknown: () => t('may change things'),
  terminal: () => t('device terminal'),
};
export function ToolsPage() {
  const [query, setQuery] = useState('');
  const { runtime, snapshot } = useRuntime();
  return (
    <Page
      title={t('tools')}
      description={t(
        "Circle's built-in tools, with inputs and results shown in the conversation.",
      )}
    >
      <SearchInput
        value={query}
        onChange={setQuery}
        label={t('search tools')}
      />
      <div className="tool-catalog">
        {(runtime.mode === 'live' ? (snapshot.tools ?? []) : BUILTIN_TOOL_INFO)
          .filter((tool) =>
            (tool.name + ' ' + tool.description).includes(query),
          )
          .map((tool) => {
            // One line for each tool: Circle's own words for a built-in one, else the
            // first sentence of what the model is told; the full text folds open.
            const known = BUILTIN_TOOL_INFO.find(
              (item) => item.name === tool.name,
            );
            // The descriptions come from Markdown tables; their bold marks are not text.
            const line = (
              known?.description ??
              tool.description.split(/(?<=\.)\s|\n/)[0]!.slice(0, 160)
            ).replaceAll('**', '');
            return (
              <details className="tool-definition" key={tool.name}>
                <summary>
                  <Code size={15} />
                  <code>{tool.name}</code>
                  <span>{line}</span>
                  <Badge>{TOOL_KIND[tool.kind]?.() ?? tool.kind}</Badge>
                </summary>
                <p>{(known?.detail ?? tool.detail).replaceAll('**', '')}</p>
                {runtime.mode === 'live' && (
                  <pre className="tool-prompt">{tool.description}</pre>
                )}
              </details>
            );
          })}
      </div>
    </Page>
  );
}
export function ApprovalsPage() {
  const { snapshot, runtime, perform } = useRuntime();
  const session = currentSession(snapshot);
  const rules = snapshot.approvalRules.filter(
    (rule) => rule.sessionId === session.id,
  );
  return (
    <Page
      title={t('approvals')}
      description={t('Allow rules belong to the current session.')}
    >
      <div className="segmented" role="group" aria-label={t('approval mode')}>
        {MODES.map((mode) => (
          <button
            key={mode}
            aria-pressed={sessionMode(session) === mode}
            className={sessionMode(session) === mode ? 'active' : ''}
            onClick={() =>
              perform(() =>
                runtime.change((state) => {
                  currentSession(state).mode = mode;
                }),
              )
            }
          >
            {MODE_TEXT[mode].label()}
          </button>
        ))}
      </div>
      <p className="panel-note">{MODE_TEXT[sessionMode(session)].detail()}</p>
      {rules.length ? (
        <div className="records">
          {rules.map((rule) => (
            <div className="record-row" key={rule.id}>
              <div className="record-main">
                <ShieldCheck size={16} />
                <span>
                  <strong>{rule.description}</strong>
                  <small>
                    {rule.kind} · {t('this session')}
                  </small>
                </span>
              </div>
              <Button
                onClick={() =>
                  perform(() => {
                    runtime.change((state) => {
                      state.approvalRules = state.approvalRules.filter(
                        (item) => item.id !== rule.id,
                      );
                    });
                    runtime.request('revoke-approval', { ruleId: rule.id });
                  })
                }
              >
                {t('revoke')}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title={t('no session rules')}
          icon={<ShieldCheck size={25} />}
        />
      )}
      <section
        className={rules.length ? 'settings-block' : 'settings-block first'}
      >
        <h2>{t('recent decisions')}</h2>
        {!snapshot.interactions.some(
          (item) => item.sessionId === session.id && item.status === 'recorded',
        ) && <p className="muted">{t('no decisions in this session yet')}</p>}
        {snapshot.interactions
          .filter(
            (item) =>
              item.sessionId === session.id && item.status === 'recorded',
          )
          .map((item) => (
            <div className="decision-row" key={item.id}>
              <span>{recordedTitle(item)}</span>
              <strong>{recordedDecision(item.decision, item.kind)}</strong>
            </div>
          ))}
        {runtime.mode !== 'live' && (
          <p className="panel-note">
            Preview decisions do not grant permissions to a running agent.
          </p>
        )}
      </section>
    </Page>
  );
}
export function HelpPage({
  onDialog,
  onClose,
}: {
  onDialog: Props['onDialog'];
  /** Closes the settings dialog this page is shown in. */
  onClose: () => void;
}) {
  const { runtime, act } = useRuntime();
  const [query, setQuery] = useState('');
  return (
    <Page
      title={t('commands & help')}
      description={t('Type a command in the message box, starting with /.')}
      action={
        <Button onClick={() => onDialog('hotkeys')}>
          {t('keyboard shortcuts')}
        </Button>
      }
    >
      <SearchInput
        value={query}
        onChange={setQuery}
        label={t('search built-in commands')}
      />
      <div className="command-table">
        {BUILTIN_SLASH.filter((command) =>
          (
            command.name +
            ' ' +
            command.description +
            ' ' +
            command.aliases?.join(' ')
          )
            .toLowerCase()
            .includes(query.toLowerCase()),
        ).map((command) => (
          <button
            key={command.name}
            onClick={() => {
              // A command that opens another group of settings stays here; any other
              // runs in view of the conversation it acts on, not behind this dialog.
              const opens = COMMAND_UI[command.name];
              if (!opens || !settingsSectionOf('/page/' + opens)) onClose();
              act(() => runtime.command(command.name));
            }}
          >
            <code>/{command.name}</code>
            <span>{slashText(command.name, command.description)}</span>
            <small>
              {command.aliases?.map((alias) => '/' + alias).join(' ')}
            </small>
            <ChevronRight size={13} />
          </button>
        ))}
      </div>
      <div className="help-links">
        <a
          href="https://github.com/circle-platforms/circle/tree/main/docs"
          target="_blank"
          rel="noreferrer"
        >
          {t('Circle documentation')}
          <ArrowUpRight size={12} />
        </a>
        {runtime.mode !== 'live' && (
          <span>UI controls are local; no runtime effects are implied.</span>
        )}
      </div>
    </Page>
  );
}
