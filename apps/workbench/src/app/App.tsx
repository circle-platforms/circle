import {
  desktopHost,
  copyText,
  nativeAttachment,
  openNativeWorkspace,
  readNativeFile,
} from '../host';
import { parsePreviewBundle } from '../model/transfer';
import { usePlugins } from '../plugins/context';
import { PluginBoundary } from '../plugins/Boundary';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { DropdownMenu, Tooltip } from 'radix-ui';
import {
  Folder,
  GitBranch,
  PanelLeft,
  PanelRight,
  Terminal,
  Search,
  ChevronRight,
  ArrowUpRight,
  Sun,
  Moon,
  X,
  ChevronLeft,
  Users,
  FileText,
  Command,
  ChevronDown,
  MoreHorizontal,
} from 'lucide-react';
import { useRuntime } from './context';
import { currentSession, sessionText, sessionTitle } from '../model/state';
import type {
  Attachment,
  DialogId,
  Interaction,
  PageId,
  PanelId,
} from '../model/types';
import { Sidebar, NAVIGATION } from '../components/Sidebar';
import {
  Button,
  IconButton,
  Modal,
  SearchInput,
  Status,
  Facts,
  DataBlock,
} from '../components/common';
import { Markdown } from '../components/Markdown';
import { ToolMessage } from '../components/ToolMessage';
import { Conversation } from '../features/Conversation';
import { Inspector, PanelButtons } from '../features/Panels';
import { FileViewer } from '../features/FileViewer';
import { ManagementPage } from '../features/Pages';
import { DialogHost, InteractionDialog } from '../features/Dialogs';
import { applyTheme } from '../theme';
import { t } from '../i18n';
import { isSessionBrowser } from '../model/browser';
// The names of the pages in the top bar; any other page shows its id.
const PAGE_NAMES: Partial<Record<string, () => string>> = {
  sessions: () => t('sessions'),
  models: () => t('models'),
  skills: () => t('skills'),
  commands: () => t('commands'),
  mcp: () => t('mcp servers'),
  extensions: () => t('extensions'),
  tools: () => t('tools'),
  approvals: () => t('approvals'),
  settings: () => t('settings'),
  help: () => t('help'),
};
function useNarrow() {
  return useSyncExternalStore(
    (listener) => {
      const media = matchMedia('(max-width: 1050px)');
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    },
    () => matchMedia('(max-width: 1050px)').matches,
  );
}
export function App() {
  const { snapshot, runtime, perform, notify, notice, setRouter, act } =
    useRuntime();
  const navigate = useNavigate();
  const { registry, enabled } = usePlugins();
  const pluginPages = registry.pages(enabled);
  const location = useLocation();
  const session = currentSession(snapshot);
  const workspace = snapshot.workspaces.find(
    (item) => item.id === session.workspaceId,
  )!;
  const narrow = useNarrow();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Closed at first, as Claude's side panel; the top bar's icons open it.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => {
    if (narrow) setInspectorOpen(false);
  }, [narrow]);
  const [panel, setPanel] = useState<PanelId>('files');
  // A panel the person wants to see whole, for as long as they want it there.
  const [fullView, setFullView] = useState(false);
  const [selection, setSelection] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogId | null>(null);
  const [dialogSelection, setDialogSelection] = useState('');
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const [search, setSearch] = useState('');
  const page = location.pathname.startsWith('/page/')
    ? (location.pathname.slice(6) as PageId)
    : null;
  const inspectorVisible = inspectorOpen && !page;
  // Only a panel worth the whole workspace offers it: the browser's page and the shell,
  // plus any component that says so on its own panel.
  const canBeWhole =
    !narrow &&
    (panel === 'terminal' ||
      registry
        .active(enabled)
        .flatMap((plugin) => plugin.panels ?? [])
        .some((item) => item.id === panel && item.fullView));
  const whole = inspectorVisible && canBeWhole && fullView;
  // A panel that cannot fill the workspace, or a panel that is gone, ends the view.
  useEffect(() => {
    if (!canBeWhole || !inspectorVisible) setFullView(false);
  }, [canBeWhole, inspectorVisible]);
  // The view takes the focus when it opens, so Escape is one keystroke away, and the way
  // out is always in its own header as well.
  const wholeBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (whole) wholeBox.current?.focus();
  }, [whole]);
  const onSession = () => {
    setFile(null);
    setAgent(null);
    navigate(`/session/${runtime.getSnapshot().activeSessionId}`);
  };
  // The first time, before anything is set up, the connection form opens by itself.
  useEffect(() => {
    if (runtime.mode === 'live' && snapshot.runtime?.configured === false)
      onDialog('connect');
  }, []);
  const onDialog = (kind: DialogId, choice = '') => {
    setDialogSelection(choice);
    setDialog(kind);
  };
  const onPanel = (kind: PanelId, choice = '') => {
    setPanel(kind);
    setSelection(choice);
    setInspectorOpen(true);
  };
  // When Circle starts using this conversation's browser, its panel opens so the person
  // sees it work: once per start, and never by taking the person away from another page.
  // A narrow window lays the panel over the conversation, where Circle's cards and the
  // input box are: there it stays closed until the person opens it.
  const browserOperating = useRef(false);
  const onPage = location.pathname.startsWith('/page/');
  useEffect(() => {
    const host = desktopHost();
    if (!host) return;
    browserOperating.current = false;
    const show = (state: Awaited<ReturnType<typeof host.browserState>>) => {
      if (!isSessionBrowser(state, session.id)) return;
      const started = !!state.operating && !browserOperating.current;
      browserOperating.current = !!state.operating;
      if (started && !onPage && !narrow) {
        setPanel('browser');
        setInspectorOpen(true);
      }
    };
    return host.onBrowserEvent(show);
  }, [session.id, onPage, narrow]);
  const onFile = async (path: string) => {
    try {
      await readNativeFile(runtime, path);
      setFile(path);
      setAgent(null);
      if (narrow) setInspectorOpen(false);
      onSessionRoute();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : t('file could not be opened'),
      );
    }
  };
  const onSessionRoute = () =>
    navigate(`/session/${runtime.getSnapshot().activeSessionId}`);
  // A link an extension asked to open (api.openUrl): the browser panel opens it, once.
  const openedLink = useRef(snapshot.openUrl?.id);
  useEffect(() => {
    const request = snapshot.openUrl;
    if (!request || request.id === openedLink.current) return;
    openedLink.current = request.id;
    if (desktopHost() && enabled.includes('browser')) {
      // The browser panel sits beside the session: show the session, then the panel.
      onSessionRoute();
      onPanel('browser', request.url);
    }
    // Without the panel, the window's own handler hands it to the system browser.
    else window.open(request.url, '_blank', 'noopener');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.openUrl?.id]);
  useEffect(() => {
    if (location.pathname === '/')
      navigate(`/session/${session.id}`, { replace: true });
    const id = location.pathname.startsWith('/session/')
      ? location.pathname.slice(9)
      : undefined;
    if (id && id !== session.id) {
      if (snapshot.sessions.some((item) => item.id === id))
        perform(() => runtime.selectSession(id));
      else navigate(`/session/${session.id}`, { replace: true });
    }
  }, [location.pathname]);
  useEffect(() => {
    setFile(null);
    setAgent(null);
  }, [session.id]);
  useEffect(() => {
    const apply = () => {
      applyTheme(snapshot.settings.theme, snapshot.settings.textSize);
      // The browser's own pages (a certificate warning) and its pointer use these colours
      void desktopHost()
        ?.setTheme(document.documentElement.dataset.theme === 'dark')
        .catch(() => {});
    };
    apply();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [snapshot.settings.theme, snapshot.settings.textSize]);
  const pickFiles = async (importing = false) => {
    if (desktopHost()) {
      try {
        const files = await desktopHost()!.chooseFiles(
          importing ? 'import' : 'attach',
        );
        for (const item of files) {
          if (importing) {
            if (runtime.mode === 'live') {
              await runtime.request('import-native-session', {
                content: item.content,
              });
              onSession();
              continue;
            }
            if (item.name.endsWith('.json')) {
              const value = JSON.parse(item.content);
              if (value.schema === 'circle-workbench-preview/v1') {
                const imported = parsePreviewBundle(
                  item.content,
                  currentSession(runtime.getSnapshot()),
                );
                const id = await runtime.newSession();
                runtime.change((state) => {
                  const index = state.sessions.findIndex(
                    (session) => session.id === id,
                  );
                  state.sessions[index] = { ...imported, id };
                });
                onSession();
                continue;
              }
            }
            const id = await runtime.newSession();
            runtime.change((state) => {
              const target = currentSession(state);
              target.title = item.name;
              const messageId = crypto.randomUUID();
              target.messages = [
                {
                  id: messageId,
                  parentId: null,
                  role: 'user',
                  text: item.content,
                  at: 'imported',
                },
              ];
              target.leafId = messageId;
            });
            onSession();
          } else
            runtime.change((state) =>
              currentSession(state).attachments.push(nativeAttachment(item)),
            );
        }
      } catch (error) {
        notify(
          error instanceof Error
            ? error.message
            : t('native file selection failed'),
        );
      }
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !importing;
    input.accept = importing
      ? '.json,.jsonl,.md,.txt'
      : '.txt,.md,.ts,.tsx,.js,.json,.jsonl,.py,.log,.csv,.yaml,.yml,.png,.jpg,.jpeg,.gif,.webp,.pdf';
    input.onchange = async () => {
      try {
        for (const item of Array.from(input.files ?? [])) {
          if (item.size > 4_000_000) {
            notify('file exceeds the 4 MB preview limit');
            continue;
          }
          if (importing) {
            const text = await item.text();
            if (runtime.mode === 'live') {
              await runtime.request('import-native-session', { content: text });
              onSession();
              continue;
            }
            if (item.name.endsWith('.json')) {
              const value = JSON.parse(text);
              if (
                value.schema === 'circle-workbench-preview/v1' &&
                value.session?.messages?.length < 10000 &&
                Array.isArray(value.session.messages) &&
                Array.isArray(value.session.attachments)
              ) {
                const imported = parsePreviewBundle(
                  text,
                  currentSession(runtime.getSnapshot()),
                );
                const id = await runtime.newSession();
                runtime.change((state) => {
                  const index = state.sessions.findIndex(
                    (value) => value.id === id,
                  );
                  state.sessions[index] = { ...imported, id };
                });
                onSession();
                continue;
              }
            }
            const id = await runtime.newSession();
            runtime.change((state) => {
              const target = currentSession(state);
              target.title = item.name;
              const messageId = crypto.randomUUID();
              target.messages = [
                {
                  id: messageId,
                  parentId: null,
                  role: 'user',
                  text,
                  at: 'imported',
                },
              ];
              target.leafId = messageId;
            });
            if (item.name.endsWith('.jsonl'))
              runtime.request('import-native-session', { name: item.name });
            onSession();
            notify('file imported into local preview; no runtime was started');
            continue;
          }
          let kind: Attachment['kind'] = 'file';
          let content = '';
          if (/^image\/(png|jpeg|gif|webp)$/.test(item.type)) {
            kind = 'image';
            content = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(Error(t('file could not be read')));
              reader.readAsDataURL(item);
            });
          } else if (item.type === 'application/pdf') {
            kind = 'document';
            content =
              'PDF attachment metadata saved; binary delivery needs a runtime.';
          } else content = await item.slice(0, 256000).text();
          const attachment: Attachment = {
            id: crypto.randomUUID(),
            name: item.name,
            kind,
            content,
            mime: item.type,
            size: item.size,
            truncated: kind === 'file' && item.size > 256000,
          };
          runtime.change((state) =>
            currentSession(state).attachments.push(attachment),
          );
        }
      } catch (error) {
        notify(
          error instanceof Error
            ? error.message
            : t('file could not be imported'),
        );
      }
    };
    input.click();
  };
  setRouter((result) => {
    if (result.openSession) onSession();
    if (result.page) navigate('/page/' + result.page);
    if (result.dialog) onDialog(result.dialog, result.selection);
    if (result.panel) onPanel(result.panel, result.selection);
    if (result.effect === 'copy') {
      const answer = [...currentSession(runtime.getSnapshot()).messages]
        .reverse()
        .find((message) => message.role === 'assistant');
      copyText(answer?.text ?? '').then(
        () => notify(t('copied')),
        () => notify(t('clipboard unavailable')),
      );
    }
    if (result.effect === 'import') pickFiles(true);
  });
  useEffect(() => {
    const host = desktopHost();
    return host?.onAction((action) => {
      if (action === 'open-folder') {
        void openNativeWorkspace(runtime)
          .then((selected) => {
            if (selected) onSession();
          })
          .catch((error) => notify(String(error)));
      } else if (action === 'settings') navigate('/page/settings');
      else if (action === 'help') navigate('/page/help');
      else act(() => runtime.command(action));
    });
  }, [runtime]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        ((event.metaKey && event.key === 'k') ||
          ((event.ctrlKey || event.metaKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === 'p')) &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    addEventListener('keydown', handle);
    return () => removeEventListener('keydown', handle);
  }, []);
  const activeAgent = snapshot.agents.find((item) => item.id === agent);
  const pluginPage = pluginPages.find((item) => item.page.id === page);
  const installedPage = registry.plugins.find((plugin) =>
    plugin.pages?.some((item) => item.id === page),
  );
  const content = pluginPage ? (
    <PluginBoundary key={pluginPage.page.id} name={pluginPage.plugin.title}>
      <pluginPage.page.component sessionId={session.id} />
    </PluginBoundary>
  ) : page && installedPage ? (
    <div className="empty-state">
      <h3>{t('plugin disabled')}</h3>
      <p>{t('Records and execution state have been preserved.')}</p>
      <Button onClick={() => navigate('/page/extensions')}>
        {t('manage interface components')}
      </Button>
    </div>
  ) : page ? (
    <ManagementPage
      page={page}
      onSession={onSession}
      onDialog={onDialog}
      onPanel={onPanel}
    />
  ) : file ? (
    <FileViewer path={file} onClose={() => setFile(null)} />
  ) : activeAgent ? (
    <section className="agent-record">
      <header>
        <Button onClick={() => setAgent(null)}>
          <ChevronLeft size={13} />
          {t('main')}
        </Button>
        <strong>{activeAgent.name}</strong>
        <Status value={activeAgent.status} />
      </header>
      <div className="agent-record-body">
        <h2>{activeAgent.description}</h2>
        <Facts
          values={{
            [t('model')]: activeAgent.model,
            [t('tokens')]: activeAgent.tokens,
            [t('record')]: activeAgent.id,
          }}
        />
        {activeAgent.messages.map((message) =>
          message.tool ? (
            <ToolMessage
              key={message.id}
              tool={message.tool}
              expanded
              onAgent={setAgent}
              onFile={onFile}
            />
          ) : (
            <div className="message" key={message.id}>
              <Markdown text={message.text} />
            </div>
          ),
        )}
      </div>
    </section>
  ) : (
    <Conversation
      onDialog={onDialog}
      onPanel={onPanel}
      onAgent={setAgent}
      onFile={onFile}
      onAttach={() => pickFiles()}
      onCommand={() => {
        setSearch('');
        setSearchOpen(true);
      }}
      finding={finding}
      setFinding={setFinding}
    />
  );
  // The session's own actions, under its title as Claude has them.
  const SESSION_ACTIONS = [
    [() => t('rename'), () => act(() => runtime.command('name'))],
    [() => t('session details'), () => onDialog('session')],
    [() => t('find in conversation'), () => setFinding(true)],
    [() => t('session tree'), () => onDialog('tree')],
    [() => t('fork'), () => act(() => runtime.command('fork'))],
    [() => t('clone'), () => act(() => runtime.command('clone'))],
    [() => t('compact context'), () => act(() => runtime.command('compact'))],
    [() => t('export'), () => act(() => runtime.command('export'))],
    [() => t('share locally'), () => act(() => runtime.command('share'))],
    [() => t('undo on screen'), () => act(() => runtime.command('undo'))],
    [() => t('redo on screen'), () => act(() => runtime.command('redo'))],
  ] as const;
  const inspector = (
    <Inspector
      panel={panel}
      selection={selection}
      onPanel={onPanel}
      onClose={() => setInspectorOpen(false)}
      whole={whole}
      canBeWhole={canBeWhole}
      onWhole={() => setFullView((on) => !on)}
      onFile={onFile}
      onAgent={setAgent}
      onDialog={onDialog}
      onInteraction={(item) => {
        if (item.kind === 'secret') {
          onDialog('secret');
        } else setInteraction(item);
      }}
    />
  );
  const searchItems = [
    ...pluginPages.map(({ page }) => ({
      id: 'plugin-' + page.id,
      label: page.title,
      detail: t('platform plugin'),
      run: () => navigate('/page/' + page.id),
    })),
    ...snapshot.sessions.map((item) => ({
      id: item.id,
      label: sessionTitle(item.title),
      detail: t('session · {workspace}', {
        workspace: String(
          snapshot.workspaces.find(
            (workspace) => workspace.id === item.workspaceId,
          )?.name,
        ),
      }),
      run: () => {
        runtime.selectSession(item.id);
        onSession();
      },
    })),
    ...NAVIGATION.map((item) => ({
      id: item.id,
      label: item.label(),
      detail: t('page'),
      run: () => navigate('/page/' + item.id),
    })),
    ...snapshot.files
      .filter((item) => item.workspaceId === session.workspaceId)
      .map((item) => ({
        id: item.id,
        label: item.path,
        detail: t('file'),
        run: () => onFile(item.path),
      })),
    ...snapshot.sessions.flatMap((item) =>
      item.messages
        .filter((message) => message.role === 'user')
        .map((message) => ({
          id: message.id,
          label: message.text,
          detail: t('message history'),
          run: () => {
            runtime.change((state) => {
              currentSession(state).draft = message.text;
            });
            onSession();
          },
        })),
    ),
  ].filter((item) =>
    (item.label + ' ' + item.detail)
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="workbench">
        {desktopHost() && <div className="desktop-drag-region" />}
        <div className="desktop-sidebar">
          <Sidebar onSearch={() => setSearchOpen(true)} onDialog={onDialog} />
        </div>
        <main className="workspace">
          <header className="topbar">
            <div className="topbar-title">
              <span className="mobile-only">
                <IconButton
                  label={t('open navigation')}
                  onClick={() => setSidebarOpen(true)}
                >
                  <PanelLeft size={16} />
                </IconButton>
              </span>
              {page || file || agent ? (
                <span className="page-title">
                  {page
                    ? (PAGE_NAMES[page]?.() ?? page)
                    : file
                      ? file
                      : t('agent record')}
                </span>
              ) : (
                <DropdownMenu.Root>
                  <h1 className="session-title">
                    <DropdownMenu.Trigger asChild>
                      <button>
                        <span>{sessionTitle(session.title)}</span>
                        <ChevronDown size={14} />
                      </button>
                    </DropdownMenu.Trigger>
                  </h1>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="dropdown"
                      align="start"
                      sideOffset={6}
                    >
                      {SESSION_ACTIONS.map(([label, run]) => (
                        <DropdownMenu.Item key={label()} onSelect={run}>
                          {label()}
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}
              <span className="project-chip" title={workspace.path}>
                <Folder size={12} />
                {workspace.name}
                {workspace.branch && (
                  <>
                    <GitBranch size={11} />
                    {workspace.branch}
                  </>
                )}
              </span>
            </div>
            <div className="topbar-actions">
              {!page && (
                <PanelButtons
                  panel={panel}
                  open={inspectorOpen}
                  onPanel={(id) => onPanel(id)}
                  onClose={() => setInspectorOpen(false)}
                />
              )}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="icon-button" aria-label={t('more')}>
                    <MoreHorizontal size={16} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="dropdown"
                    align="end"
                    sideOffset={6}
                  >
                    <DropdownMenu.Item onSelect={() => setSearchOpen(true)}>
                      {t('search')}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() =>
                        perform(() =>
                          runtime.change((state) => {
                            state.settings.theme =
                              document.documentElement.dataset.theme === 'dark'
                                ? 'light'
                                : 'dark';
                          }),
                        )
                      }
                    >
                      {document.documentElement.dataset.theme === 'dark'
                        ? t('light theme')
                        : t('dark theme')}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() =>
                        onDialog(
                          runtime.mode === 'live' ? 'connect' : 'preview',
                        )
                      }
                    >
                      {t('connection')}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={() => navigate('/page/help')}>
                      {t('help')}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </header>
          <div
            className={whole ? 'workspace-content whole' : 'workspace-content'}
          >
            {/* Seen whole, the panel takes the workspace above the conversation's own
                input, which stays where the person left it. The columns are only put
                aside, never unmounted: what was typed, and where the transcript had been
                scrolled, are kept for the way back. */}
            {whole && (
              <div
                className="inspector-full"
                ref={wholeBox}
                tabIndex={-1}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setFullView(false);
                }}
              >
                {inspector}
              </div>
            )}
            <div className={whole ? 'columns whole-under' : 'columns'}>
              <Group orientation="horizontal" id="workbench-columns">
                <Panel
                  id="main"
                  defaultSize={inspectorVisible && !narrow ? '68%' : '100%'}
                  minSize="38%"
                >
                  <div className="main-stack">{content}</div>
                </Panel>
                {inspectorVisible && !narrow && !whole && (
                  <>
                    <Separator
                      className="resize-handle"
                      aria-label={t('resize inspector')}
                    />
                    <Panel
                      id="inspector"
                      minSize={290}
                      maxSize="50%"
                      defaultSize="32%"
                    >
                      {inspector}
                    </Panel>
                  </>
                )}
              </Group>
            </div>
            {/* A narrow window lays the panel over the conversation, on the right,
                and keeps the top bar's icons usable. */}
            {inspectorVisible && narrow && (
              <div
                className="inspector-overlay"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setInspectorOpen(false);
                }}
              >
                {inspector}
              </div>
            )}
          </div>
        </main>
        <Modal
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          title={t('navigation')}
        >
          <Sidebar
            onSearch={() => {
              setSidebarOpen(false);
              setSearchOpen(true);
            }}
            onNavigate={() => setSidebarOpen(false)}
            onDialog={onDialog}
          />
        </Modal>
        <Modal
          open={searchOpen}
          onOpenChange={setSearchOpen}
          title={t('search')}
        >
          <SearchInput
            value={search}
            onChange={setSearch}
            label={t('global search')}
            placeholder={t('sessions, files, pages or past messages')}
          />
          <div className="search-results">
            {searchItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  item.run();
                  setSearchOpen(false);
                  setSearch('');
                }}
              >
                <Search size={14} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <ArrowUpRight size={12} />
              </button>
            ))}
          </div>
        </Modal>
        <DialogHost
          dialog={dialog}
          selection={dialogSelection}
          onClose={() => setDialog(null)}
          onSession={onSession}
        />
        <InteractionDialog
          item={
            interaction
              ? (snapshot.interactions.find(
                  (item) => item.id === interaction.id,
                ) ?? null)
              : null
          }
          onClose={() => {
            setInteraction(null);
            if (narrow) setInspectorOpen(false);
          }}
        />
        {notice && (
          <div className="toast" role="status">
            {notice}
          </div>
        )}
      </div>
    </Tooltip.Provider>
  );
}
