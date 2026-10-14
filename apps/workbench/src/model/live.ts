import type { DesktopBridge } from '../../../desktop/src/contracts';
import type {
  RuntimeCommandName,
  RuntimeUpdate,
} from '../../../desktop/src/runtime-protocol';
import type {
  CommandResult,
  RuntimePort,
  WorkbenchSnapshot,
  Session,
} from './types';
import {
  currentSession,
  visibleMessages,
  EFFORTS,
  parseMode,
  sessionMode,
} from './state';
import {
  BUILTIN_SLASH,
  parseSlash,
  commandWord,
} from '../../../../src/tui/slash_commands';
import { saveExport } from '../host';
import { MAX_PROMPT_PAYLOAD } from '../../../desktop/src/runtime-protocol';
import { t } from '../i18n/index.ts';

const LOCAL_SESSION = [
  'draft',
  'attachments',
  'hiddenIds',
  'undoStack',
  'showThinking',
  'expandTools',
  'pinned',
  'shared',
] as const;
const LOCAL_SETTINGS = ['textSize', 'keybindings'] as const;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type View = Partial<Pick<Session, (typeof LOCAL_SESSION)[number]>>;

/** Local drafts/view preferences are separate from core-owned history and execution state. */
export class LiveRuntime implements RuntimePort {
  readonly mode = 'live' as const;
  private snapshot: WorkbenchSnapshot;
  private seq = -1;
  private listeners = new Set<() => void>();
  private views = new Map<string, View>();
  private files: WorkbenchSnapshot['files'] = [];
  // The workspace whose files were last listed, and a listing in flight.
  private listed?: string;
  private listing?: Promise<void>;
  private settings: Partial<WorkbenchSnapshot['settings']> = {};
  private plugins?: string[];
  private changes = Promise.resolve();
  private unsubscribe: () => void;
  constructor(
    private host: DesktopBridge,
    initial: RuntimeUpdate,
    private storage?: Pick<Storage, 'getItem' | 'setItem'>,
  ) {
    this.snapshot = initial.snapshot;
    try {
      const value = JSON.parse(
        storage?.getItem('circle.workbench.live.views.v1') ?? '{}',
      );
      this.views = new Map(
        (value.views ?? [])
          .filter(
            (entry: unknown) =>
              Array.isArray(entry) && typeof entry[0] === 'string',
          )
          .map(([id, record]: [string, View]) => [
            id,
            Object.fromEntries(
              LOCAL_SESSION.filter((key) => record && key in record).map(
                (key) => [key, record[key]],
              ),
            ),
          ]),
      );
      this.settings = Object.fromEntries(
        LOCAL_SETTINGS.filter(
          (key) => value.settings && key in value.settings,
        ).map((key) => [key, value.settings[key]]),
      );
      this.plugins =
        Array.isArray(value.plugins) &&
        value.plugins.every((id: unknown) => typeof id === 'string')
          ? value.plugins
          : undefined;
    } catch {
      /* Invalid UI preferences do not replace runtime history. */
    }
    this.receive(initial);
    this.unsubscribe = host.onRuntime(this.receive);
  }
  private persist() {
    try {
      this.storage?.setItem(
        'circle.workbench.live.views.v1',
        JSON.stringify({
          views: [...this.views],
          settings: this.settings,
          plugins: this.plugins,
        }),
      );
    } catch {
      this.report(Error(t('UI preferences could not be saved')));
    }
  }
  private receive = (update: RuntimeUpdate) => {
    if (update.seq <= this.seq) return;
    this.seq = update.seq;
    this.snapshot = structuredClone(update.snapshot);
    this.snapshot.files = this.files;
    this.snapshot.settings = { ...this.snapshot.settings, ...this.settings };
    if (this.plugins) this.snapshot.uiPlugins = this.plugins;
    for (const session of this.snapshot.sessions)
      Object.assign(session, this.views.get(session.id) ?? {});
    for (const listener of this.listeners) listener();
    // A file tool or a finished turn may have added files: list the folder again.
    const kind = update.event?.kind;
    const workspace = currentSession(this.snapshot).workspaceId;
    if (
      workspace !== this.listed ||
      kind === 'run_end' ||
      (kind === 'tool_result' &&
        ['write_file', 'edit_file', 'apply_patch', 'delete'].includes(
          String(update.event?.payload.name),
        ))
    )
      void this.listWorkspace(workspace);
  };
  // The active workspace's files when the desktop may list it (trusted), so the files
  // panel and @ completion work without opening the folder again.
  private listWorkspace(workspaceId: string): Promise<void> {
    if (!this.host.listWorkspace) return Promise.resolve();
    this.listed = workspaceId;
    const run = async () => {
      await this.listing;
      const listed = await this.host.listWorkspace(workspaceId);
      if (!listed) return;
      this.files = [
        ...this.files.filter((file) => file.workspaceId !== workspaceId),
        ...listed.files.map((file) => ({
          id: file.id,
          workspaceId,
          path: file.path,
          content: '',
          language: file.language,
          nativeGrant: { workspaceId: listed.id, fileId: file.id },
        })),
      ];
      this.snapshot = { ...this.snapshot, files: this.files };
      for (const listener of this.listeners) listener();
    };
    this.listing = run().catch(() => undefined);
    return this.listing;
  }
  private report(error: unknown) {
    this.snapshot = {
      ...this.snapshot,
      runtime: {
        ...this.snapshot.runtime!,
        error:
          error instanceof Error ? error.message : t('runtime action failed'),
      },
    };
    for (const listener of this.listeners) listener();
  }
  dispose() {
    this.unsubscribe();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private native(
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
    sessionId = this.snapshot.activeSessionId,
  ): Promise<unknown> {
    const promise = (async () => {
      if (!this.snapshot.runtime?.connected)
        throw Error(t('Circle runtime disconnected'));
      const reply = await this.host.runtimeCommand({
        id: crypto.randomUUID(),
        name,
        sessionId,
        payload,
      });
      this.receive(await this.host.runtimeState());
      if (!reply.ok) throw Error(reply.error ?? t('runtime action failed'));
      return reply.data;
    })();
    void promise.catch((error) => this.report(error));
    return promise;
  }
  change = (update: (draft: WorkbenchSnapshot) => void) => {
    const before = this.snapshot;
    const requested = structuredClone(before);
    update(requested);
    if (
      !equal(
        before.sessions.map((s) => s.id),
        requested.sessions.map((s) => s.id),
      )
    )
      throw Error(t('use a native session operation'));
    const operations: {
      name: RuntimeCommandName;
      payload: Record<string, unknown>;
      sessionId: string;
    }[] = [];
    const add = (
      name: RuntimeCommandName,
      payload: Record<string, unknown>,
      sessionId = before.activeSessionId,
    ) => operations.push({ name, payload, sessionId });
    // Copy only explicit presentation fields; authoritative data remains unchanged until the worker acknowledges it.
    const next = structuredClone(before);
    for (const item of requested.sessions) {
      const previous = before.sessions.find((s) => s.id === item.id)!;
      const target = next.sessions.find((s) => s.id === item.id)!;
      const view = this.views.get(item.id) ?? {};
      for (const key of LOCAL_SESSION)
        if (!equal(item[key], previous[key])) {
          Object.assign(view, { [key]: item[key] });
          Object.assign(target, { [key]: item[key] });
        }
      this.views.set(item.id, view);
      if (item.title !== previous.title)
        add('rename-session', { id: item.id, title: item.title }, item.id);
      if (item.model !== previous.model)
        add('set-model', { modelId: item.model }, item.id);
      if (item.effort !== previous.effort)
        add('set-effort', { effort: item.effort }, item.id);
      if (item.readOnly !== previous.readOnly)
        add('set-plan-mode', { enabled: item.readOnly }, item.id);
      if (item.auto !== previous.auto)
        add('set-auto', { enabled: item.auto }, item.id);
      if (item.mode !== previous.mode && item.mode)
        add('set-mode', { mode: item.mode }, item.id);
      if (!equal(item.queue, previous.queue)) {
        if (
          item.queue.some(
            (entry) => !previous.queue.some((old) => equal(old, entry)),
          )
        )
          throw Error(t('queue messages through the composer'));
        for (const entry of previous.queue
          .filter((old) => !item.queue.some((row) => row.id === old.id))
          .reverse())
          add(
            'remove-queued',
            {
              kind: entry.kind,
              index: Number(entry.id.split('-').at(-1)),
              text: entry.text,
            },
            item.id,
          );
      }
      for (const message of item.messages) {
        const old = previous.messages.find((m) => m.id === message.id);
        if (old && message.label !== old.label)
          add(
            'label-branch',
            { messageId: message.id, label: message.label ?? '' },
            item.id,
          );
      }
      if (
        item.messages.some(
          (m) => !previous.messages.some((old) => old.id === m.id),
        )
      )
        throw Error(
          t('history can only be imported through the native runtime'),
        );
    }
    for (const workspace of requested.workspaces) {
      const old = before.workspaces.find((row) => row.id === workspace.id);
      if (!old)
        throw Error(t('choose a workspace through the native folder dialog'));
      if (workspace.trusted !== old.trusted)
        add('trust', { enabled: workspace.trusted });
    }
    const settings: Record<string, unknown> = {};
    for (const key of Object.keys(
      requested.settings,
    ) as (keyof WorkbenchSnapshot['settings'])[])
      if (!equal(requested.settings[key], before.settings[key])) {
        if ((LOCAL_SETTINGS as readonly string[]).includes(key)) {
          Object.assign(this.settings, { [key]: requested.settings[key] });
          Object.assign(next.settings, { [key]: requested.settings[key] });
        } else if (!['endpoint', 'protocol'].includes(key))
          settings[key] = requested.settings[key];
      }
    if (
      Object.keys(settings).length ||
      !equal(requested.mcp, before.mcp) ||
      !equal(requested.extensions, before.extensions)
    )
      add('save-settings', {
        settings,
        ...(!equal(requested.mcp, before.mcp) ? { mcp: requested.mcp } : {}),
        ...(!equal(requested.extensions, before.extensions)
          ? { extensions: requested.extensions }
          : {}),
      });
    for (const command of requested.commands)
      if (
        !equal(
          command,
          before.commands.find((old) => old.name === command.name),
        )
      )
        add('save-command', {
          name: command.name,
          template: command.template,
          scope: command.scope,
          description: command.description,
          arguments: command.arguments,
        });
    this.files = requested.files;
    next.files = this.files;
    this.plugins = requested.uiPlugins;
    next.uiPlugins = this.plugins;
    this.snapshot = next;
    this.persist();
    for (const listener of this.listeners) listener();
    for (const operation of operations)
      this.changes = this.changes
        .then(async () => {
          await this.native(
            operation.name,
            operation.payload,
            operation.sessionId,
          );
        })
        .catch((error) => {
          this.report(error);
        });
  };
  newSession = async (workspaceId?: string) => {
    await this.changes;
    if (
      workspaceId &&
      workspaceId !== currentSession(this.snapshot).workspaceId
    ) {
      const session = this.snapshot.sessions.find(
        (row) => row.workspaceId === workspaceId,
      );
      if (!session)
        throw Error(t('open the workspace through the native folder dialog'));
      await this.selectSession(session.id);
    }
    const result = (await this.native('new-session')) as { sessionId: string };
    return result.sessionId;
  };
  selectSession = async (id: string) => {
    await this.changes;
    await this.native('select-session', { id });
  };
  deleteSession = async (id: string) => {
    await this.changes;
    await this.native('delete-session', { id });
  };
  branch = async (messageId: string, kind: 'tree' | 'fork') => {
    await this.changes;
    await this.native(kind === 'tree' ? 'select-branch' : 'fork', {
      messageId,
    });
  };
  answer = async (id: string, revision: number, answer: string) => {
    const item = this.snapshot.interactions.find((row) => row.id === id);
    if (!item) throw Error(t('interaction is no longer available'));
    if (item.kind === 'approval')
      answer =
        answer === 'allow once'
          ? 'approve'
          : answer === 'allow for this session'
            ? 'always'
            : answer;
    await this.native('answer', { id, revision, answer }, item.sessionId);
  };
  request = (
    kind: string,
    payload: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const operation = async () => {
      await this.changes;
      const names: Record<string, RuntimeCommandName> = {
        'configure-connection': 'configure',
        'probe-connection': 'probe-connection',
        'cancel-interaction': 'answer',
        'import-native-session': 'import',
        'export-session': 'export',
        'mcp.reload': 'reload',
        'extensions.reload': 'reload',
        'set-model': 'set-model',
        'set-plan-mode': 'set-plan-mode',
        'set-mode': 'set-mode',
        'revoke-approval': 'revoke-approval',
        'stop-job': 'stop-job',
        abort: 'abort',
        compact: 'compact',
        background: 'background',
        logout: 'logout',
        'open-workspace': 'open-workspace',
        'delete-workspace': 'delete-workspace',
        reload: 'reload',
        'clear-queue': 'clear-queue',
        'write-file': 'write-file',
        'check-update': 'check-update',
        'discover-models': 'discover-models',
        'launch-options': 'launch-options',
        'trust-workspace': 'trust',
        'save-secret': 'save-secret',
        'remove-secret': 'remove-secret',
        execute: 'shell',
      };
      if (kind === 'export-session') {
        const data = (await this.native('export', {
          format:
            payload.format === 'json' ? 'jsonl' : (payload.format ?? 'jsonl'),
        })) as { content: string; name: string };
        return saveExport(data.name, data.content, 'application/x-ndjson');
      }
      if (kind === 'exit') return this.host.windowControl('quit');
      if (kind === 'cancel-interaction') {
        const row = this.snapshot.interactions.find(
          (row) => row.id === payload.id,
        );
        if (!row) throw Error(t('interaction is no longer available'));
        return this.native(
          'answer',
          { ...payload, cancel: true },
          row.sessionId,
        );
      }
      const name = names[kind];
      if (!name) throw Error(t('{kind} is not connected yet', { kind }));
      return this.native(name, payload);
    };
    const result = operation();
    void result.catch((error) => this.report(error));
    return result;
  };
  send = async (
    kind: 'steering' | 'follow-up' = 'steering',
  ): Promise<CommandResult> => {
    await this.changes;
    const session = currentSession(this.snapshot);
    const raw = session.draft.trim();
    if (raw.startsWith('!')) {
      await this.native('shell', {
        command: raw.replace(/^!!?/, ''),
        quiet: raw.startsWith('!!'),
      });
      this.change((state) => {
        currentSession(state).draft = '';
      });
      return {};
    }
    const slash = parseSlash(
      raw,
      new Set(this.snapshot.commands.map((item) => item.name)),
    );
    if (slash) {
      this.change((state) => {
        currentSession(state).draft = '';
      });
      return this.command(slash.name, slash.args);
    }
    if (commandWord(raw))
      return {
        notice: t('unknown command /{name}', { name: commandWord(raw) }),
      };
    if (!raw && !session.attachments.length) return {};
    const textAttachments = session.attachments.filter(
      (a) => !['image', 'document'].includes(a.kind),
    );
    const prompt =
      raw +
      textAttachments
        .map(
          (a) =>
            `\n\n<attachment name=${JSON.stringify(a.name)}>\n${a.content}\n</attachment>`,
        )
        .join('');
    const media = session.attachments.filter((a) =>
      ['image', 'document'].includes(a.kind),
    );
    const payload = {
      text: prompt || 'See the attached files.',
      display: raw,
      kind,
      attachments: media,
    };
    // Said here, with the message left in the box, rather than as a refused command
    if (JSON.stringify(payload).length > MAX_PROMPT_PAYLOAD)
      return {
        notice: t(
          'the message and its files are over 64 MB; remove some pictures or PDFs',
        ),
      };
    await this.native('prompt', payload);
    this.change((state) => {
      const item = state.sessions.find((item) => item.id === session.id);
      if (!item) return;
      if (item.draft === session.draft) item.draft = '';
      const sent = new Set(
        session.attachments.map((attachment) => attachment.id),
      );
      item.attachments = item.attachments.filter(
        (attachment) => !sent.has(attachment.id),
      );
    });
    return {};
  };
  command = async (name: string, args = ''): Promise<CommandResult> => {
    await this.changes;
    name = parseSlash('/' + name)?.name ?? name;
    const session = currentSession(this.snapshot);
    if (name === 'new') {
      await this.newSession();
      return { openSession: true };
    }
    if (name === 'resume' && args) {
      const target =
        this.snapshot.sessions.find(
          (s) => s.id === args || s.id.endsWith(args),
        ) ?? this.snapshot.sessions[Number(args) - 1];
      if (!target) throw Error(t('session not found'));
      await this.selectSession(target.id);
      return { openSession: true };
    }
    if (name === 'resume') return { page: 'sessions' };
    if (name === 'continue') {
      if (!this.snapshot.previousSessionId)
        return { notice: t('no previous session') };
      await this.selectSession(this.snapshot.previousSessionId);
      return { openSession: true };
    }
    if (name === 'name' && args) {
      await this.native('rename-session', { title: args });
      return {};
    }
    if (name === 'clone') {
      await this.native('clone');
      return { openSession: true };
    }
    if (name === 'plan') {
      await this.native('set-plan-mode', {
        enabled:
          args === 'on' ? true : args === 'off' ? false : !session.readOnly,
      });
      return {};
    }
    if (name === 'yolo') {
      await this.native('set-auto', {
        enabled: args === 'off' ? false : args === 'on' ? true : !session.auto,
      });
      return {};
    }
    if (name === 'mode') {
      const mode = parseMode(args, sessionMode(session));
      if (!mode)
        return { notice: t('choose manual, accept-edits, plan or auto') };
      await this.native('set-mode', { mode });
      return {};
    }
    if (['thinking', 'details'].includes(name) && !args) {
      this.change((s) => {
        const target = currentSession(s);
        if (name === 'thinking') target.showThinking = !target.showThinking;
        else target.expandTools = !target.expandTools;
      });
      return {};
    }
    if (['effort', 'thinking'].includes(name) && args) {
      if (!(EFFORTS as string[]).includes(args))
        throw Error(t('unknown thinking depth'));
      await this.native('set-effort', { effort: args });
      return {};
    }
    if (name === 'models' && args) {
      await this.native('set-model', { modelId: args });
      return {};
    }
    if (name === 'themes' && args) {
      this.change((s) => {
        s.settings.theme = args as WorkbenchSnapshot['settings']['theme'];
      });
      return {};
    }
    if (name === 'skill' && args) {
      const result = (await this.native('load-skill', {
        name: args.split(/\s/)[0],
      })) as { name: string; content: string };
      this.change((s) => {
        currentSession(s).attachments.push({
          id: crypto.randomUUID(),
          name: result.name,
          kind: 'skill',
          content: result.content,
        });
      });
      return { notice: t('skill added to the next message') };
    }
    if (name === 'undo' || name === 'redo') {
      this.change((s) => {
        const item = currentSession(s);
        if (name === 'redo') {
          const previous = item.undoStack.pop();
          if (previous) item.hiddenIds = previous;
        } else {
          const visible = visibleMessages(item);
          const index = visible.findLastIndex((m) => m.role === 'user');
          if (index >= 0) {
            item.undoStack.push([...item.hiddenIds]);
            item.hiddenIds.push(...visible.slice(index).map((m) => m.id));
          }
        }
      });
      return {
        notice:
          name === 'undo'
            ? t('last turn hidden; saved history and files remain')
            : t('transcript restored'),
      };
    }
    if (name === 'approvals' && args.startsWith('revoke ')) {
      const rule = this.snapshot.approvalRules.filter(
        (r) => r.sessionId === session.id,
      )[Number(args.slice(7)) - 1];
      if (!rule) throw Error(t('rule not found'));
      await this.native('revoke-approval', { ruleId: rule.id });
      return { page: 'approvals' };
    }
    if (name === 'logout') {
      await this.native('logout');
      return { dialog: 'connect' };
    }
    if (
      name === 'reload' ||
      (['mcp', 'extensions'].includes(name) && args === 'reload')
    ) {
      await this.native('reload');
      return { notice: t('Circle integrations reloaded') };
    }
    if (name === 'jobs') return { panel: 'activity', selection: args };
    if (name === 'copy') return { effect: 'copy' };
    if (name === 'import') return { effect: 'import' };
    if (name === 'init') {
      await this.native('init');
      return {};
    }
    if (name === 'share' || name === 'unshare') {
      const data = (await this.native(name)) as { path: string };
      return {
        notice:
          name === 'share'
            ? t('local share saved · {path}', { path: data.path })
            : t('local share removed'),
      };
    }
    if (this.snapshot.commands.some((command) => command.name === name)) {
      await this.native('custom-command', { name, args });
      return {};
    }
    const dialogs: Record<string, CommandResult['dialog']> = {
      login: 'connect',
      trust: 'trust',
      name: 'rename',
      session: 'session',
      tree: 'tree',
      fork: 'fork',
      compact: 'compact',
      export: 'export',
      share: 'export',
      unshare: 'export',
      editor: 'editor',
      exit: 'exit',
      hotkeys: 'hotkeys',
    };
    if (dialogs[name]) return { dialog: dialogs[name], selection: args };
    const pages: Record<string, CommandResult['page']> = {
      help: 'help',
      settings: 'settings',
      themes: 'settings',
      variables: 'settings',
      secrets: 'settings',
      mcp: 'mcp',
      extensions: 'extensions',
      approvals: 'approvals',
      models: 'models',
      effort: 'models',
      skill: 'skills',
    };
    if (pages[name]) return { page: pages[name] };
    if (!BUILTIN_SLASH.some((item) => item.name === name))
      return { notice: t('unknown command /{name}', { name }) };
    throw Error(t('/{name} is not connected yet', { name }));
  };
  reset = () => {
    throw Error(t('live sessions are managed through the sessions page'));
  };
}
