import type { DesktopBridge } from '../../../desktop/src/contracts';
import type {
  RuntimeCommandName,
  RuntimeUpdate,
  RuntimeTokenDelta,
  RuntimeReply,
} from '../../../desktop/src/runtime-protocol';
import { RuntimeTokenBuffer } from '../../../desktop/src/runtime-token-stream';
import type {
  Attachment,
  BeginResult,
  CommandResult,
  Effort,
  RuntimePort,
  SessionMode,
  WorkbenchSnapshot,
  Session,
  SessionViewPatch,
} from './types';
import {
  currentSession,
  visibleMessages,
  EFFORTS,
  parseMode,
  promptAttachments,
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
import { SessionActionError } from './action-error';
import { runtimeStoppedNotice } from './runtime-notice';
import { armComposerFocus, cancelComposerFocus } from './composer-focus';
import { sessionHasContent } from './session-management';

const LOCAL_SESSION = [
  'draft',
  'attachments',
  'hiddenIds',
  'undoStack',
  'showThinking',
  'expandTools',
  'pinned',
  'shared',
  'presentation',
] as const;
const LOCAL_SETTINGS = ['textSize', 'keybindings'] as const;
// Each session's view but its attachments, and the window's own settings
const VIEWS_KEY = 'circle.workbench.live.views.v1';
// Each session's draft attachments, apart from the rest of its view
const ATTACHMENTS_KEY = 'circle.workbench.live.attachments.v1';
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type View = Partial<Pick<Session, (typeof LOCAL_SESSION)[number]>>;
/** The settings this window keeps itself, from what it stored. */
const localSettings = (value: {
  settings?: Record<string, unknown>;
}): Partial<WorkbenchSnapshot['settings']> =>
  Object.fromEntries(
    LOCAL_SETTINGS.filter((key) => value.settings && key in value.settings).map(
      (key) => [key, value.settings![key]],
    ),
  );

/** Local drafts/view preferences are separate from core-owned history and execution state. */
export class LiveRuntime implements RuntimePort {
  readonly mode = 'live' as const;
  private snapshot: WorkbenchSnapshot;
  private seq = -1;
  private receivedFullEpoch?: string;
  private listeners = new Set<() => void>();
  private views = new Map<string, View>();
  // The attachments in storage: what persist() wrote, or read at start
  private storedAttachments = new Map<
    string,
    NonNullable<View['attachments']>
  >();
  private sessionErrors = new Map<string, string>();
  private files: WorkbenchSnapshot['files'] = [];
  // The workspace whose files were last listed, and a listing in flight.
  private listed?: string;
  private listingEpoch = 0;
  private listingSession?: string;
  private fileListings: NonNullable<WorkbenchSnapshot['fileListings']> = {};
  private listing?: Promise<void>;
  private settings: Partial<WorkbenchSnapshot['settings']> = {};
  private plugins?: string[];
  private changes = Promise.resolve();
  private unsubscribe: () => void;
  private unsubscribeDelta: () => void = () => {};
  private tokenBuffer = new RuntimeTokenBuffer();
  private tokenTimer?: ReturnType<typeof setTimeout>;
  private tokenResync?: Promise<void>;
  private tokenPending: RuntimeTokenDelta[] = [];
  private disposed = false;
  constructor(
    private host: DesktopBridge,
    initial: RuntimeUpdate,
    private storage?: Pick<Storage, 'getItem' | 'setItem'>,
  ) {
    this.snapshot = initial.snapshot;
    try {
      const value = JSON.parse(storage?.getItem(VIEWS_KEY) ?? '{}');
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
      this.settings = localSettings(value);
      this.plugins =
        Array.isArray(value.plugins) &&
        value.plugins.every((id: unknown) => typeof id === 'string')
          ? value.plugins
          : undefined;
      // Earlier versions kept the attachments with the rest of the view, read above
      const stored = JSON.parse(
        storage?.getItem(ATTACHMENTS_KEY) ?? 'null',
      ) as unknown;
      if (Array.isArray(stored))
        for (const entry of stored) {
          if (
            !Array.isArray(entry) ||
            typeof entry[0] !== 'string' ||
            !Array.isArray(entry[1])
          )
            continue;
          const view = this.views.get(entry[0]) ?? {};
          view.attachments = entry[1];
          this.views.set(entry[0], view);
          this.storedAttachments.set(entry[0], entry[1]);
        }
    } catch {
      /* Invalid UI preferences do not replace runtime history. */
    }
    this.receive(initial);
    this.unsubscribe = host.onRuntime(this.receive);
    this.unsubscribeDelta =
      host.onRuntimeDelta?.(this.receiveDelta) ?? (() => {});
  }
  private persist(): boolean {
    if (this.disposed) return false;
    try {
      this.storage?.setItem(
        VIEWS_KEY,
        JSON.stringify({
          views: [...this.views].map(([id, view]) => {
            const { attachments: _, ...rest } = view;
            return [id, rest];
          }),
          settings: this.settings,
          plugins: this.plugins,
        }),
      );
      // A pasted picture is megabytes of base64. Kept with the draft, it was written
      // again with every keystroke; it is written when the attachments change.
      const current = new Map(
        [...this.views]
          .filter(([, view]) => view.attachments?.length)
          .map(([id, view]) => [id, view.attachments!]),
      );
      if (
        current.size !== this.storedAttachments.size ||
        [...current].some(
          ([id, attachments]) => this.storedAttachments.get(id) !== attachments,
        )
      ) {
        this.storage?.setItem(ATTACHMENTS_KEY, JSON.stringify([...current]));
        this.storedAttachments = current;
      }
      return true;
    } catch {
      this.report(Error(t('UI preferences could not be saved')));
      return false;
    }
  }
  private receive = (update: RuntimeUpdate) => {
    if (this.disposed) return;
    if (!this.tokenBuffer.acceptFull(update)) return;
    this.seq = update.seq;
    this.snapshot = structuredClone(update.snapshot);
    this.receivedFullEpoch = update.tokenStream?.epoch;
    this.snapshot.files = this.files;
    this.snapshot.fileListings = this.fileListings;
    this.snapshot.settings = { ...this.snapshot.settings, ...this.settings };
    if (this.plugins) this.snapshot.uiPlugins = this.plugins;
    const existing = new Set(
      this.snapshot.sessions.map((session) => session.id),
    );
    let removedView = false;
    for (const id of this.views.keys()) {
      if (!existing.has(id)) {
        this.views.delete(id);
        removedView = true;
      }
    }
    if (removedView) this.persist();
    for (const id of this.sessionErrors.keys())
      if (!existing.has(id)) this.sessionErrors.delete(id);
    for (const session of this.snapshot.sessions) {
      Object.assign(session, this.views.get(session.id) ?? {});
      session.actionError = this.sessionErrors.get(session.id);
    }
    for (const listener of this.listeners) listener();
    // A file tool or a finished turn may have added files: list the folder again.
    const kind = update.event?.kind;
    const workspace = currentSession(this.snapshot).workspaceId;
    if (
      workspace !== this.listed ||
      this.snapshot.activeSessionId !== this.listingSession ||
      kind === 'run_end' ||
      (kind === 'tool_result' &&
        ['write_file', 'edit_file', 'apply_patch', 'delete'].includes(
          String(update.event?.payload.name),
        ))
    )
      void this.listWorkspace(workspace);
  };
  private receiveDelta = (delta: RuntimeTokenDelta) => {
    if (this.disposed) return;
    if (this.tokenResync) {
      this.bufferToken(delta);
      return;
    }
    const result = this.tokenBuffer.apply(delta);
    if (result === 'applied') this.scheduleTokens();
    else if (result !== 'duplicate') {
      this.bufferToken(delta);
      this.resyncTokens();
    }
  };
  private bufferToken(delta: RuntimeTokenDelta) {
    if (this.tokenPending.length >= 4096) this.tokenPending = [];
    this.tokenPending.push(delta);
  }
  private resyncTokens(attempt = 0) {
    if (this.tokenResync || this.disposed) return;
    this.tokenResync = this.host
      .runtimeState()
      .then((update) => {
        if (this.disposed) return;
        this.receive(update);
        const pending = this.tokenPending.sort((a, b) => a.seq - b.seq);
        this.tokenPending = [];
        for (const delta of pending) {
          const result = this.tokenBuffer.apply(delta);
          if (result === 'applied') this.scheduleTokens();
          else if (result !== 'duplicate') this.bufferToken(delta);
        }
      })
      .catch((error) => {
        if (!this.disposed) this.report(error);
      })
      .finally(() => {
        this.tokenResync = undefined;
        if (this.tokenPending.length && !this.disposed) {
          if (attempt < 1) this.resyncTokens(attempt + 1);
          else {
            this.tokenPending = [];
            this.report(Error(t('Circle runtime disconnected')));
          }
        }
      });
  }
  private scheduleTokens() {
    if (this.tokenTimer) return;
    this.tokenTimer = setTimeout(() => {
      this.tokenTimer = undefined;
      if (this.disposed) return;
      const update = this.tokenBuffer.materialize();
      this.snapshot = {
        ...this.snapshot,
        sessions: update.snapshot.sessions.map((session) => ({
          ...session,
          ...(this.views.get(session.id) ?? {}),
          actionError: this.sessionErrors.get(session.id),
        })),
      };
      for (const listener of this.listeners) listener();
    }, 16);
  }
  // The active workspace's files when the desktop may list it (trusted), so the files
  // panel and @ completion work without opening the folder again.
  private listWorkspace(workspaceId: string): Promise<void> {
    if (!this.host.listWorkspace) return Promise.resolve();
    this.listed = workspaceId;
    this.listingSession = this.snapshot.activeSessionId;
    const epoch = ++this.listingEpoch;
    const sourceSession = this.snapshot.activeSessionId;
    const active = () =>
      !this.disposed &&
      epoch === this.listingEpoch &&
      this.snapshot.activeSessionId === sourceSession &&
      currentSession(this.snapshot).workspaceId === workspaceId;
    const publish = () => {
      this.snapshot = {
        ...this.snapshot,
        files: this.files,
        fileListings: { ...this.fileListings },
      };
      for (const listener of this.listeners) listener();
    };
    const run = async () => {
      if (!active()) return;
      this.fileListings[workspaceId] = {
        loaded: this.files.filter((file) => file.workspaceId === workspaceId)
          .length,
        complete: false,
        truncated: false,
      };
      publish();
      let cursor: string | undefined;
      let accumulated: WorkbenchSnapshot['files'] = [];
      do {
        const listed = await this.host.listWorkspace(workspaceId, cursor);
        if (!active()) return;
        if (!listed) {
          this.files = this.files.filter(
            (file) => file.workspaceId !== workspaceId,
          );
          this.fileListings[workspaceId] = {
            loaded: 0,
            complete: true,
            truncated: false,
          };
          publish();
          return;
        }
        accumulated.push(
          ...listed.files.map((file) => ({
            id: file.id,
            workspaceId,
            path: file.path,
            content: '',
            language: file.language,
            nativeGrant: { workspaceId: listed.id, fileId: file.id },
          })),
        );
        // Keep already loaded document identities while a refresh is paged.
        // Otherwise a file near the end would disappear and remount its editor
        // after each earlier page. On completion, remove genuinely absent files.
        const visible = listed.nextCursor
          ? [
              ...new Map(
                [
                  ...this.files.filter(
                    (file) => file.workspaceId === workspaceId,
                  ),
                  ...accumulated,
                ].map((file) => [file.path, file]),
              ).values(),
            ]
          : accumulated;
        this.files = [
          ...this.files.filter((file) => file.workspaceId !== workspaceId),
          ...visible,
        ];
        this.fileListings[workspaceId] = {
          loaded: visible.length,
          complete: !listed.nextCursor,
          truncated: listed.truncated,
        };
        publish();
        cursor = listed.nextCursor;
      } while (cursor && active());
    };
    this.listing = run().catch((error) => {
      if (!active()) return;
      this.fileListings[workspaceId] = {
        loaded: this.files.filter((file) => file.workspaceId === workspaceId)
          .length,
        complete: false,
        truncated: true,
        error: error instanceof Error ? error.message : 'file listing failed',
      };
      publish();
    });
    return this.listing;
  }
  private report(error: unknown, sessionId = this.snapshot.activeSessionId) {
    if (this.disposed) return;
    if (error instanceof SessionActionError) sessionId = error.sessionId;
    const message =
      error instanceof Error ? error.message : t('runtime action failed');
    if (!this.snapshot.sessions.some((session) => session.id === sessionId))
      return;
    this.sessionErrors.set(sessionId, message);
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, actionError: message }
          : session,
      ),
    };
    for (const listener of this.listeners) listener();
  }
  dismissActionError = (sessionId = this.snapshot.activeSessionId) => {
    if (!this.sessionErrors.delete(sessionId)) return;
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, actionError: undefined }
          : session,
      ),
    };
    for (const listener of this.listeners) listener();
  };
  restartRuntime = async () => {
    if (!this.host.restartRuntime)
      throw Error(t('Circle runtime disconnected'));
    await this.host.restartRuntime();
  };
  // The main window wrote its settings (the text size): a window that only reads them
  // follows.
  storageChanged = (key: string | null) => {
    if (this.disposed || (key !== null && key !== VIEWS_KEY)) return;
    let settings: Partial<WorkbenchSnapshot['settings']>;
    try {
      settings = localSettings(
        JSON.parse(this.storage?.getItem(VIEWS_KEY) ?? '{}'),
      );
    } catch {
      return;
    }
    if (equal(settings, this.settings)) return;
    this.settings = settings;
    this.snapshot = {
      ...this.snapshot,
      settings: { ...this.snapshot.settings, ...settings },
    };
    for (const listener of this.listeners) listener();
  };
  dispose() {
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeDelta();
    if (this.tokenTimer) clearTimeout(this.tokenTimer);
    this.tokenPending = [];
    this.listeners.clear();
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
    reportFailure = true,
  ): Promise<unknown> {
    if (reportFailure && this.sessionErrors.delete(sessionId)) {
      this.snapshot = {
        ...this.snapshot,
        sessions: this.snapshot.sessions.map((session) =>
          session.id === sessionId
            ? { ...session, actionError: undefined }
            : session,
        ),
      };
      for (const listener of this.listeners) listener();
    }
    const promise = (async () => {
      if (this.disposed) throw Error(t('Circle runtime disconnected'));
      if (!this.snapshot.runtime?.connected)
        throw Error(t('Circle runtime disconnected'));
      const reply = await this.host
        .runtimeCommand({
          id: crypto.randomUUID(),
          name,
          sessionId,
          payload,
        })
        .catch(async (error: unknown) => {
          throw await this.stoppedRuntimeError(error);
        });
      // Token sequence numbers and an unrelated intervening update cannot
      // acknowledge this command. Only its full publication (or a newer one
      // from that same runtime epoch) proves the effect reached this renderer.
      if (!this.disposed && !this.coversAppliedState(reply))
        this.receive(await this.host.runtimeState());
      if (!reply.ok) throw Error(reply.error ?? t('runtime action failed'));
      return reply.data;
    })().catch((error) => {
      throw new SessionActionError(
        error instanceof Error ? error.message : t('runtime action failed'),
        sessionId,
        error,
      );
    });
    if (reportFailure)
      void promise.catch((error) => this.report(error, sessionId));
    return promise;
  }
  /**
   * A command the runtime's stop cut off fails with the main process's English
   * sentence: `Circle runtime exited (1)` for one under way, `runtime disconnected`
   * for one sent after. That is the stop the window already announces, so it is said
   * the same way, in the interface language with the exit code. Any other failure
   * stays as it was.
   */
  private async stoppedRuntimeError(error: unknown): Promise<unknown> {
    const message = error instanceof Error ? error.message : String(error);
    // Electron's wrapping of a rejected invoke: `Error invoking remote method
    // '<channel>': Error: <message>`.
    const said =
      /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s.exec(
        message,
      )?.[1] ?? message;
    // The reply can come before the update that says the runtime stopped.
    if (!this.disposed && this.snapshot.runtime?.connected !== false)
      try {
        this.receive(await this.host.runtimeState());
      } catch {
        /* The stop then reaches the window with its own update. */
      }
    const runtime = this.snapshot.runtime;
    const notice = runtimeStoppedNotice(runtime);
    return notice &&
      (said === runtime?.error || said === 'runtime disconnected')
      ? Error(notice)
      : error;
  }
  private coversAppliedState(reply: RuntimeReply): boolean {
    const marker = reply.ok ? reply.appliedState : undefined;
    return Boolean(
      marker &&
      typeof marker.epoch === 'string' &&
      marker.epoch.length > 0 &&
      marker.epoch === this.receivedFullEpoch &&
      Number.isSafeInteger(marker.seq) &&
      marker.seq >= 1 &&
      this.seq >= marker.seq,
    );
  }
  updateSessionView = (sessionId: string, patch: SessionViewPatch): boolean => {
    if (this.disposed) return false;
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.keys(patch).some(
        (key) => !(LOCAL_SESSION as readonly string[]).includes(key),
      )
    )
      throw Error(t('use a native session operation'));
    const index = this.snapshot.sessions.findIndex(
      (session) => session.id === sessionId,
    );
    if (index < 0) return false;
    const previous = this.snapshot.sessions[index];
    const changed = Object.entries(patch).some(
      ([key, value]) =>
        !Object.is(previous[key as keyof Session], value) &&
        !equal(previous[key as keyof Session], value),
    );
    if (!changed) return this.persist();
    const copy = structuredClone(patch);
    const sessions = this.snapshot.sessions.slice();
    sessions[index] = { ...previous, ...copy };
    this.views.set(sessionId, {
      ...(this.views.get(sessionId) ?? {}),
      ...copy,
    });
    this.snapshot = { ...this.snapshot, sessions };
    const persisted = this.persist();
    for (const listener of this.listeners) listener();
    return persisted;
  };
  change = (update: (draft: WorkbenchSnapshot) => void) => {
    if (this.disposed) return;
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
      const previousMessages = new Map<string, Session['messages'][number]>();
      for (const message of previous.messages)
        if (!previousMessages.has(message.id))
          previousMessages.set(message.id, message);
      for (const message of item.messages) {
        const old = previousMessages.get(message.id);
        if (old && message.label !== old.label)
          add(
            'label-branch',
            { messageId: message.id, label: message.label ?? '' },
            item.id,
          );
      }
      if (item.messages.some((message) => !previousMessages.has(message.id)))
        throw Error(
          t('history can only be imported through the native runtime'),
        );
    }
    for (const workspace of requested.workspaces) {
      const old = before.workspaces.find((row) => row.id === workspace.id);
      if (!old)
        throw Error(t('choose a workspace through the native folder dialog'));
      if (workspace.trusted !== old.trusted)
        add('trust', { enabled: workspace.trusted, workspaceId: workspace.id });
    }
    const settings: Record<string, unknown> = {};
    for (const key of Object.keys(
      requested.settings,
    ) as (keyof WorkbenchSnapshot['settings'])[])
      if (!equal(requested.settings[key], before.settings[key])) {
        if ((LOCAL_SETTINGS as readonly string[]).includes(key)) {
          Object.assign(this.settings, { [key]: requested.settings[key] });
          Object.assign(next.settings, { [key]: requested.settings[key] });
        } else if (
          // The connection has its own command; the default workspace only
          // changes through the native folder dialog's grant.
          ![
            'endpoint',
            'protocol',
            'workspaceFolder',
            'oldWorkspaceFolder',
          ].includes(key)
        )
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
          this.report(error, operation.sessionId);
        });
  };
  newSession = async (workspaceId?: string) => {
    workspaceId ??= currentSession(this.snapshot).workspaceId;
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
    const id = result.sessionId;
    const row = this.snapshot.sessions.find((item) => item.id === id);
    // Reused empty session: drop a leftover draft. A new id has none.
    if (
      row &&
      row.draft &&
      !row.messages.some((message) => message.role === 'user')
    ) {
      this.change((state) => {
        const target = state.sessions.find((item) => item.id === id);
        if (
          target &&
          target.draft &&
          !target.messages.some((message) => message.role === 'user')
        )
          target.draft = '';
      });
    }
    return id;
  };
  beginConversation = async (input: {
    workspaceId?: string | null;
    text: string;
    model?: string;
    effort?: Effort;
    mode?: SessionMode;
    attachments?: Attachment[];
  }): Promise<BeginResult> => {
    const text = input.text.trim();
    if (!text) throw Error(t('prompt is empty'));
    if (
      input.attachments !== undefined &&
      (!Array.isArray(input.attachments) || input.attachments.length > 16)
    )
      throw Error('invalid attachments');
    await this.changes;
    const workspaceId = input.workspaceId || undefined;
    if (workspaceId) {
      const workspace = this.snapshot.workspaces.find(
        (item) => item.id === workspaceId,
      );
      if (!workspace)
        throw Error(t('open the workspace through the native folder dialog'));
      if (!workspace.trusted) return { dialog: 'trust' };
    }
    // First commands use exactly the session composer dispatch path. Prepare
    // the owner first, without ever forwarding command text to the model.
    const commandInput = text.startsWith('/') || text.startsWith('!');
    const folded = promptAttachments(text, input.attachments ?? []);
    const result = (await this.native('begin-session', {
      ...(workspaceId ? { workspaceId } : {}),
      text: commandInput ? text : folded.text,
      display: commandInput ? text : folded.display,
      ...(commandInput ? { prepareOnly: true } : {}),
      ...(folded.attachments.length ? { attachments: folded.attachments } : {}),
      ...(input.model ? { modelId: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    })) as { sessionId: string };
    if (commandInput) {
      this.updateSessionView(result.sessionId, {
        draft: text,
        attachments: input.attachments ?? [],
      });
      const commandResult = await this.send('steering', result.sessionId);
      return { sessionId: result.sessionId, commandResult };
    }
    return { sessionId: result.sessionId };
  };
  selectSession = async (id: string) => {
    await this.changes;
    await this.native('select-session', { id });
  };
  deleteSession = async (id: string, confirmed = false) => {
    await this.changes;
    await this.native('delete-session', { id, confirmed });
  };
  branch = async (messageId: string, kind: 'tree' | 'fork') => {
    const sessionId = this.snapshot.activeSessionId;
    await this.changes;
    await this.native(
      kind === 'tree' ? 'select-branch' : 'fork',
      {
        messageId,
      },
      sessionId,
    );
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
    sourceSessionId?: string,
  ): Promise<unknown> => {
    const owner =
      kind === 'stop-job'
        ? this.snapshot.jobs.find((item) => item.id === payload.id)?.sessionId
        : kind === 'cancel-interaction'
          ? this.snapshot.interactions.find((item) => item.id === payload.id)
              ?.sessionId
          : undefined;
    const sessionId = owner ?? sourceSessionId ?? this.snapshot.activeSessionId;
    const operation = async () => {
      await this.changes;
      if (
        kind === 'list-external-file-grants' ||
        kind === 'revoke-external-file-grant'
      )
        return this.native(kind, payload, sessionId, false);
      if (kind === 'extension.enabled') {
        if (
          typeof payload.name !== 'string' ||
          typeof payload.enabled !== 'boolean'
        )
          throw Error(t('invalid extension setting'));
        return this.native(
          'save-settings',
          {
            settings: {},
            extensions: [{ name: payload.name, enabled: payload.enabled }],
          },
          sessionId,
          false,
        );
      }
      const names: Record<string, RuntimeCommandName> = {
        'list-external-file-grants': 'list-external-file-grants',
        'revoke-external-file-grant': 'revoke-external-file-grant',
        'configure-connection': 'configure',
        'probe-connection': 'probe-connection',
        'cancel-interaction': 'answer',
        'import-native-session': 'import',
        'export-session': 'export',
        'mcp.reload': 'reload',
        'extensions.reload': 'reload',
        'extension-command': 'custom-command',
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
        'archive-session': 'archive-session',
        'archive-workspace': 'archive-workspace',
        'set-default-workspace': 'set-default-workspace',
        reload: 'reload',
        'clear-queue': 'clear-queue',
        'preview-file-undo': 'preview-file-undo',
        'restore-turn-files': 'restore-turn-files',
        'write-file': 'write-file',
        'check-update': 'check-update',
        'dismiss-whats-new': 'dismiss-whats-new',
        'discover-models': 'discover-models',
        'launch-options': 'launch-options',
        'trust-workspace': 'trust',
        'save-secret': 'save-secret',
        'remove-secret': 'remove-secret',
        'create-skill': 'create-skill',
      };
      if (kind === 'export-session') {
        const data = (await this.native(
          'export',
          {
            format:
              payload.format === 'json' ? 'jsonl' : (payload.format ?? 'jsonl'),
          },
          sessionId,
        )) as { content: string; name: string };
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
      return this.native(name, payload, sessionId);
    };
    const result = operation();
    // This settings action reports its Promise result in its original row,
    // including superseded intents; it must not become a conversation failure.
    if (
      ![
        'extension.enabled',
        'list-external-file-grants',
        'revoke-external-file-grant',
      ].includes(kind)
    )
      void result.catch((error) => this.report(error, sessionId));
    return result;
  };
  send = async (
    kind: 'steering' | 'follow-up' = 'steering',
    sessionId = this.snapshot.activeSessionId,
  ): Promise<CommandResult> => {
    await this.changes;
    const session = this.snapshot.sessions.find(
      (item) => item.id === sessionId,
    );
    if (!session) throw Error(t('session not found'));
    const raw = session.draft.trim();
    if (raw === '/') {
      this.updateSessionView(session.id, { draft: '' });
      return { page: 'help' };
    }
    if (raw.startsWith('!')) {
      await this.native(
        'shell',
        {
          command: raw.replace(/^!!?/, ''),
          quiet: raw.startsWith('!!'),
        },
        session.id,
      );
      this.change((state) => {
        const target = state.sessions.find((item) => item.id === session.id);
        if (target?.draft === session.draft) target.draft = '';
      });
      return {};
    }
    const slash = parseSlash(
      raw,
      new Set(this.snapshot.commands.map((item) => item.name)),
    );
    if (slash) {
      this.change((state) => {
        const target = state.sessions.find((item) => item.id === session.id);
        if (target?.draft === session.draft) target.draft = '';
      });
      return this.command(slash.name, slash.args, session.id);
    }
    if (commandWord(raw)) {
      const word = commandWord(raw);
      const off = this.turnedOffExtension(word);
      if (off) {
        this.change((state) => {
          const target = state.sessions.find((item) => item.id === session.id);
          if (target?.draft === session.draft) target.draft = '';
        });
        return {
          notice: t(
            'unknown command /{name} · turn it on with /extensions enable {extension}',
            { name: word, extension: off },
          ),
        };
      }
      return {
        notice: t('unknown command /{name}', { name: word }),
      };
    }
    if (!raw && !session.attachments.length) return {};
    const folded = promptAttachments(raw, session.attachments);
    const payload = {
      text: folded.text,
      display: folded.display,
      kind,
      attachments: folded.attachments,
    };
    // Said here, with the message left in the box, rather than as a refused command
    if (JSON.stringify(payload).length > MAX_PROMPT_PAYLOAD)
      return {
        notice: t(
          'the message and its files are over 64 MB; remove some pictures or PDFs',
        ),
      };
    await this.native('prompt', payload, session.id);
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
  runSkill = async (
    input: { name: string; text: string; display: string },
    sessionId = this.snapshot.activeSessionId,
  ): Promise<void> => {
    await this.changes;
    const session = this.snapshot.sessions.find(
      (item) => item.id === sessionId,
    );
    if (!session) throw Error(t('session not found'));
    const loaded = (await this.native(
      'load-skill',
      { name: input.name },
      session.id,
    )) as { name: string; content: string };
    const folded = promptAttachments(input.text, [
      {
        id: crypto.randomUUID(),
        name: loaded.name,
        kind: 'skill',
        content: loaded.content,
      },
    ]);
    await this.native(
      'prompt',
      {
        text: folded.text,
        display: input.display,
        kind: 'steering',
        attachments: folded.attachments,
      },
      session.id,
    );
  };
  command = async (
    name: string,
    args = '',
    sessionId = this.snapshot.activeSessionId,
  ): Promise<CommandResult> => {
    const opening = (parseSlash('/' + name)?.name ?? name) === 'new';
    // Before the awaits, so keys during the native round-trip are kept.
    if (opening) armComposerFocus();
    try {
      return await this.dispatchCommand(name, args, sessionId);
    } catch (error) {
      if (opening) cancelComposerFocus();
      throw error;
    }
  };
  private dispatchCommand = async (
    name: string,
    args = '',
    sessionId = this.snapshot.activeSessionId,
  ): Promise<CommandResult> => {
    await this.changes;
    name = parseSlash('/' + name)?.name ?? name;
    const session = this.snapshot.sessions.find(
      (item) => item.id === sessionId,
    );
    if (!session) throw Error(t('session not found'));
    const native = (
      name: RuntimeCommandName,
      payload: Record<string, unknown> = {},
    ) => this.native(name, payload, session.id);
    if (name === 'new') {
      await this.newSession(session.workspaceId);
      return { openSession: true, focusComposer: true };
    }
    if (name === 'resume' && args) {
      const visible = this.snapshot.sessions.filter(sessionHasContent);
      const target =
        visible.find((s) => s.id === args || s.id.endsWith(args)) ??
        visible[Number(args) - 1];
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
      await native('rename-session', { title: args });
      return {};
    }
    if (name === 'clone') {
      await native('clone');
      return { openSession: true };
    }
    if (name === 'plan') {
      await native('set-plan-mode', {
        enabled:
          args === 'on' ? true : args === 'off' ? false : !session.readOnly,
      });
      return {};
    }
    if (name === 'yolo') {
      await native('set-auto', {
        enabled: args === 'off' ? false : args === 'on' ? true : !session.auto,
      });
      return {};
    }
    if (name === 'mode') {
      const mode = parseMode(args, sessionMode(session));
      if (!mode)
        return { notice: t('choose manual, accept-edits, plan or auto') };
      await native('set-mode', { mode });
      return {};
    }
    if (['thinking', 'details'].includes(name) && !args) {
      this.change((s) => {
        const target = s.sessions.find((item) => item.id === session.id);
        if (!target) return;
        if (name === 'thinking') target.showThinking = !target.showThinking;
        else target.expandTools = !target.expandTools;
      });
      return {};
    }
    if (['effort', 'thinking'].includes(name) && args) {
      if (args !== 'default' && !(EFFORTS as string[]).includes(args))
        throw Error(t('unknown thinking depth'));
      await native('set-effort', { effort: args });
      return {};
    }
    if (name === 'models' && args) {
      await native('set-model', { modelId: args });
      return {};
    }
    if (name === 'themes' && args) {
      this.change((s) => {
        s.settings.theme = args as WorkbenchSnapshot['settings']['theme'];
      });
      return {};
    }
    if (name === 'skill' && args) {
      const result = (await native('load-skill', {
        name: args.split(/\s/)[0],
      })) as { name: string; content: string };
      this.change((s) => {
        const target = s.sessions.find((item) => item.id === session.id);
        if (!target || target.lifecycle === 'deleting') return;
        target.attachments.push({
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
        const item = s.sessions.find((row) => row.id === session.id);
        if (!item) return;
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
      await native('revoke-approval', { ruleId: rule.id });
      return { page: 'approvals' };
    }
    if (name === 'logout') {
      await native('logout');
      return { dialog: 'connect' };
    }
    if (
      name === 'reload' ||
      (['mcp', 'extensions'].includes(name) && args === 'reload')
    ) {
      await native('reload');
      return { notice: t('Circle integrations reloaded') };
    }
    // Background commands are tabs of the terminal, beside its shells and device consoles.
    if (name === 'jobs' || name === 'terminals')
      return { panel: 'terminal', selection: args };
    if (name === 'copy') return { effect: 'copy' };
    if (name === 'import') return { effect: 'import' };
    if (name === 'init') {
      await native('init');
      return {};
    }
    if (name === 'share' || name === 'unshare') {
      const data = (await native(name)) as { path: string };
      return {
        notice:
          name === 'share'
            ? t('local share saved · {path}', { path: data.path })
            : t('local share removed'),
      };
    }
    if (this.snapshot.commands.some((command) => command.name === name)) {
      const data = (await native('custom-command', { name, args })) as
        { notice?: string } | undefined;
      // What an extension says in passing, such as the hub's sign-in, is a notice.
      return data?.notice ? { notice: data.notice } : {};
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
      // Settings lists each hook and the files that wait for approval.
      hooks: 'settings',
      mcp: 'mcp',
      extensions: 'extensions',
      approvals: 'approvals',
      models: 'models',
      effort: 'models',
      skill: 'skills',
    };
    if (pages[name]) return { page: pages[name] };
    if (!BUILTIN_SLASH.some((item) => item.name === name)) {
      const off = this.turnedOffExtension(name);
      return {
        notice: off
          ? t(
              'unknown command /{name} · turn it on with /extensions enable {extension}',
              { name, extension: off },
            )
          : t('unknown command /{name}', { name }),
      };
    }
    throw Error(t('/{name} is not connected yet', { name }));
  };
  reset = () => {
    throw Error(t('live sessions are managed through the sessions page'));
  };
  private turnedOffExtension(name: string): string | undefined {
    return this.snapshot.extensions.find(
      (item) => !item.enabled && item.declaredCommands?.includes(name),
    )?.name;
  }
}
