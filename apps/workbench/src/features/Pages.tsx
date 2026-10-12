import { desktopHost } from '../host';
import { validateKeybindings } from '../model/shortcuts';
import { usePlugins } from '../plugins/context';
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { CUSTOMIZE, NAVIGATION } from '../components/Sidebar';
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
import { VERSION } from '../../../../src/version';
import { useRuntime } from '../app/context';
import {
  currentSession,
  EFFORTS,
  sessionMode,
  sessionTitle,
} from '../model/state';
import { EFFORT_TEXT, MODE_TEXT } from './Composer';
import { shownTime } from '../model/time';
import type {
  DialogId,
  PageId,
  PanelId,
  McpServer,
  TextSize,
  Effort,
} from '../model/types';
import {
  Page,
  SearchInput,
  Button,
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
import { BUILTIN_TOOL_INFO } from '../model/tool-info';
import { TEXT_SIZES, textSizes } from '../theme';
import { LANGUAGES, languageChoice, setLanguage, t, tn } from '../i18n';
interface Props {
  page: PageId;
  onSession: () => void;
  onDialog: (dialog: DialogId, selection?: string) => void;
  onPanel: (panel: PanelId, selection?: string) => void;
}
// Skills, commands, MCP servers, extensions, tools and approvals share one place,
// as Claude's customize does: a row of tabs over the page.
function CustomizeTabs({ page }: { page: string }) {
  return (
    <nav className="customize-tabs" aria-label={t('customize')}>
      {CUSTOMIZE.map((id) => (
        <NavLink
          key={id}
          to={'/page/' + id}
          className={page === id ? 'active' : ''}
        >
          {NAVIGATION.find((item) => item.id === id)!.label()}
        </NavLink>
      ))}
    </nav>
  );
}
export function ManagementPage(props: Props) {
  if ((CUSTOMIZE as readonly string[]).includes(props.page))
    return (
      <div className="customize">
        <CustomizeTabs page={props.page} />
        <PageContent {...props} />
      </div>
    );
  return <PageContent {...props} />;
}
function PageContent(props: Props) {
  switch (props.page) {
    case 'sessions':
      return <SessionsPage {...props} />;
    case 'models':
      return <ModelsPage onDialog={props.onDialog} />;
    case 'skills':
      return <SkillsPage />;
    case 'commands':
      return <CommandsPage />;
    case 'mcp':
      return <McpPage />;
    case 'extensions':
      return <ExtensionsPage />;
    case 'tools':
      return <ToolsPage />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'settings':
      return <SettingsPage onDialog={props.onDialog} />;
    default:
      return <HelpPage onDialog={props.onDialog} />;
  }
}
function SessionsPage({ onSession, onDialog }: Props) {
  const { snapshot, runtime, perform } = useRuntime();
  const [search, setSearch] = useState('');
  const [all, setAll] = useState(false);
  const current = currentSession(snapshot);
  const sessions = snapshot.sessions.filter(
    (session) =>
      (all || session.workspaceId === current.workspaceId) &&
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
          onClick={() =>
            perform(async () => {
              await runtime.newSession();
              onSession();
            })
          }
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
                  {
                    snapshot.workspaces.find(
                      (workspace) => workspace.id === session.workspaceId,
                    )?.name
                  }{' '}
                  · {shownTime(session.updatedAt)}
                </small>
              </span>
              {session.id === current.id && <Badge>{t('open')}</Badge>}
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
            <IconButton
              label={t('rename {title}', { title: session.title })}
              onClick={() => onDialog('rename', session.id)}
            >
              <FileText size={14} />
            </IconButton>
            <IconButton
              label={t('delete {title}', { title: session.title })}
              disabled={session.id === current.id}
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
function ModelsPage({ onDialog }: { onDialog: Props['onDialog'] }) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(currentSession(snapshot).model);
  const [saveDefault, setSaveDefault] = useState(false);
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
                  await runtime.request('discover-models');
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
              {EFFORT_TEXT[effort]()}
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
function SkillsPage() {
  const { snapshot, runtime, act } = useRuntime();
  const [query, setQuery] = useState('');
  const [id, setId] = useState(snapshot.skills[0]?.id ?? '');
  const selected = snapshot.skills.find((skill) => skill.id === id);
  return (
    <Page
      title={t('skills')}
      description={t('Instructions loaded into a conversation when needed.')}
    >
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
                    <small>{skill.scope}</small>
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
        <EmptyState title={t('no skills yet')}>
          {t(
            'Add a folder with a SKILL.md file to .circle/skills in your project. Circle reads it when a session starts.',
          )}
        </EmptyState>
      )}
    </Page>
  );
}
function CommandsPage() {
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
        <EmptyState title={t('no commands yet')}>
          {t(
            'Save a prompt as a Markdown file in .circle/commands in your project, or use new command.',
          )}
        </EmptyState>
      )}
    </Page>
  );
}
function McpPage() {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const server = snapshot.mcp.find((item) => item.id === selected);
  return (
    <Page
      title={t('mcp servers')}
      description={t('Inspect server configuration and the tools it exposes.')}
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
        <EmptyState title={t('no MCP servers yet')}>
          {t('Add a server to give Circle tools from another program.')}
        </EmptyState>
      )}
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
                    state.mcp.find((server) => server.id === item.id)!.enabled =
                      enabled;
                  }),
                )
              }
            />
          </div>
        ))}
      </div>
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
function ExtensionsPage() {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [tab, setTab] = useState<'runtime' | 'interface'>('runtime');
  const { registry, enabled, toggle } = usePlugins();
  return (
    <Page
      title={t('extensions')}
      description={t(
        'Extensions add tools, commands and checks written in JavaScript or TypeScript.',
      )}
      action={
        <Button
          onClick={() => {
            runtime.request('extensions.reload');
            notify(t('extension reload recorded; no code was loaded'));
          }}
        >
          <RotateCcw size={14} />
          {t('reload')}
        </Button>
      }
    >
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
            <EmptyState title={t('no extensions yet')}>
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
                    {extension.scope} · {extension.version}
                  </p>
                </div>
                <Switch
                  label={t('enable {name}', { name: extension.name })}
                  checked={extension.enabled}
                  onChange={(enabled) =>
                    perform(() =>
                      runtime.change((state) => {
                        state.extensions.find(
                          (item) => item.id === extension.id,
                        )!.enabled = enabled;
                      }),
                    )
                  }
                />
              </div>
              {extension.error && (
                <div className="inline-error">{extension.error}</div>
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
                  label={t('enable {name} interface', { name: plugin.id })}
                  checked={enabled.includes(plugin.id)}
                  onChange={(value) => toggle(plugin.id, value)}
                />
              </div>
              <p className="panel-note">
                {t('bundled first-party component · {version}', {
                  version: '0.1.0',
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
};
function ToolsPage() {
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
function ApprovalsPage() {
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
      <div className="connection-banner">
        <ShieldCheck size={18} />
        <span>{MODE_TEXT[sessionMode(session)].label()}</span>
        <small>
          {runtime.mode === 'live'
            ? MODE_TEXT[sessionMode(session)].detail()
            : 'preview policy'}
        </small>
      </div>
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
        {!rules.length && (
          <div className="empty-state">
            <h3>{t('no session rules')}</h3>
          </div>
        )}
      </div>
      <section className="settings-block">
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
              <span>{item.title}</span>
              <strong>{item.decision}</strong>
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
const TEXT_SIZE_LABELS: Record<TextSize, () => string> = {
  small: () => t('small'),
  default: () => t('default'),
  large: () => t('large'),
  larger: () => t('larger'),
};
const THEME_LABELS: Record<'auto' | 'light' | 'dark', () => string> = {
  auto: () => t('auto'),
  light: () => t('light'),
  dark: () => t('dark'),
};
function SettingsPage({ onDialog }: { onDialog: Props['onDialog'] }) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const settings = snapshot.settings;
  const [bindings, setBindings] = useState(
    JSON.stringify(settings.keybindings, null, 2),
  );
  const [launch, setLaunch] = useState('--mode rpc --no-tools');
  const save = (update: (draft: WorkbenchSnapshotSettings) => void) =>
    perform(() => runtime.change((state) => update(state.settings)));
  return (
    <Page
      title={t('settings')}
      description={
        runtime.mode === 'live'
          ? t('Circle preferences and display settings.')
          : 'Preferences here apply to this frontend preview.'
      }
    >
      <section className="settings-block first">
        <h2>{t('appearance')}</h2>
        <div className="setting-row">
          <span>{t('theme')}</span>
          <div className="segmented">
            {(['auto', 'light', 'dark'] as const).map((theme) => (
              <button
                key={theme}
                className={settings.theme === theme ? 'active' : ''}
                onClick={() =>
                  save((value) => {
                    value.theme = theme;
                  })
                }
              >
                {THEME_LABELS[theme]()}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span>{t('text size')}</span>
          <div className="segmented" role="group" aria-label={t('text size')}>
            {textSizes.map((size) => (
              <button
                key={size}
                aria-pressed={settings.textSize === size}
                className={settings.textSize === size ? 'active' : ''}
                style={{ fontSize: TEXT_SIZES[size][0] + 'px' }}
                onClick={() =>
                  save((value) => {
                    value.textSize = size;
                  })
                }
              >
                {TEXT_SIZE_LABELS[size]()}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span>{t('language')}</span>
          <div className="segmented" role="group" aria-label={t('language')}>
            {LANGUAGES.map((language) => (
              <button
                key={language}
                aria-pressed={languageChoice() === language}
                className={languageChoice() === language ? 'active' : ''}
                onClick={() => setLanguage(language, localStorage)}
              >
                {language === 'system'
                  ? t('follow system')
                  : language === 'zh-CN'
                    ? '简体中文'
                    : 'English'}
              </button>
            ))}
          </div>
        </div>
        <Switch
          label={t('hide thinking in new sessions')}
          checked={settings.hideThinking}
          onChange={(checked) =>
            save((value) => {
              value.hideThinking = checked;
            })
          }
        />
      </section>
      <section className="settings-block">
        <h2>{t('session defaults')}</h2>
        <div className="setting-row">
          <span>{t('model')}</span>
          <code>{settings.defaultModel}</code>
          <Button onClick={() => onDialog('connect')}>{t('connection')}</Button>
        </div>
        <div className="setting-row">
          <label htmlFor="double-escape">{t('double escape')}</label>
          <select
            id="double-escape"
            value={settings.doubleEscape}
            onChange={(event) =>
              save((value) => {
                value.doubleEscape = event.target
                  .value as typeof settings.doubleEscape;
              })
            }
          >
            {(
              [
                ['tree', () => t('open the session tree')],
                ['fork', () => t('fork the session')],
                ['none', () => t('nothing')],
              ] as const
            ).map(([value, label]) => (
              <option key={value} value={value}>
                {label()}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <label htmlFor="default-effort">{t('thinking depth')}</label>
          <select
            id="default-effort"
            value={settings.defaultEffort}
            onChange={(event) =>
              save((value) => {
                value.defaultEffort = event.target
                  .value as typeof settings.defaultEffort;
              })
            }
          >
            {(['default', ...EFFORTS] as Effort[]).map((value) => (
              <option key={value} value={value}>
                {EFFORT_TEXT[value]()}
              </option>
            ))}
          </select>
        </div>
      </section>
      <section className="settings-block">
        <h2>{t('workspace trust')}</h2>
        {snapshot.workspaces.map((workspace) => (
          <div className="setting-row" key={workspace.id}>
            <span>
              {workspace.name}
              <small>{workspace.path}</small>
            </span>
            <Status value={workspace.trusted ? 'trusted' : 'not trusted'} />
            <Button onClick={() => onDialog('trust', workspace.id)}>
              {t('review')}
            </Button>
          </div>
        ))}
      </section>
      <section className="settings-block">
        <h2>{t('protected files')}</h2>
        <label className="field-label" htmlFor="credential-patterns">
          {t('additional file patterns')}
        </label>
        <textarea
          id="credential-patterns"
          className="input short"
          value={settings.credentialFiles.join('\n')}
          onChange={(event) =>
            save((value) => {
              value.credentialFiles = event.target.value
                .split('\n')
                .filter(Boolean);
            })
          }
        />
        <p className="panel-note">
          {t(
            "Circle's built-in protections remain in force when a runtime is connected.",
          )}
        </p>
      </section>
      <section className="settings-block">
        <h2>{t('keyboard')}</h2>
        <Button onClick={() => onDialog('hotkeys')}>
          {t('view shortcuts')}
        </Button>
        <textarea
          aria-label={t('keybindings json')}
          className="code-editor short"
          value={bindings}
          onChange={(event) => setBindings(event.target.value)}
        />
        <Button
          onClick={() =>
            perform(() => {
              const parsed = validateKeybindings(JSON.parse(bindings));
              save((value) => {
                value.keybindings = parsed;
              });
              notify(
                runtime.mode === 'live'
                  ? t('key preferences saved')
                  : 'preview key preferences saved',
              );
            })
          }
        >
          {t('save key preferences')}
        </Button>
      </section>
      {runtime.mode === 'preview' && (
        <section className="settings-block">
          <h2>launch options</h2>
          <textarea
            aria-label="launch arguments"
            className="input short"
            value={launch}
            onChange={(event) => setLaunch(event.target.value)}
          />
          <Button
            onClick={() => {
              runtime.request('launch-options', { arguments: launch });
              notify('launch draft saved; no process started');
            }}
          >
            save launch draft
          </Button>
        </section>
      )}
      <section className="settings-block">
        <h2>{t('about')}</h2>
        <Facts
          values={{
            [t('version')]: VERSION,
            [t('runtime')]: snapshot.runtime?.connected
              ? t('connected')
              : t('not connected'),
            [t('host')]: desktopHost()
              ? t('desktop application')
              : 'browser layout preview',
            [t('data')]:
              runtime.mode === 'live'
                ? t('Circle desktop data folder')
                : 'this browser only',
          }}
        />
        <Switch
          label={t('check for updates')}
          checked={settings.updateCheck}
          onChange={(checked) =>
            save((value) => {
              value.updateCheck = checked;
            })
          }
        />
        <Button
          onClick={() =>
            perform(async () => {
              if (runtime.mode !== 'live') {
                runtime.request('check-update');
                notify('update check requires a connected host');
                return;
              }
              const result = (await runtime.request('check-update')) as {
                available?: string;
              };
              notify(
                result?.available
                  ? t('Circle {version} is available', {
                      version: result.available,
                    })
                  : t('Circle is up to date'),
              );
            })
          }
        >
          {t('check now')}
        </Button>
      </section>
    </Page>
  );
}
type WorkbenchSnapshotSettings = ReturnType<
  typeof useRuntime
>['snapshot']['settings'];
function HelpPage({ onDialog }: { onDialog: Props['onDialog'] }) {
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
            onClick={() => act(() => runtime.command(command.name))}
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
          href="https://github.com/qingshanfeihu/circle/tree/main/docs"
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
