import { utilityProcess, type UtilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { WorkspaceServiceEvent } from './workspace-protocol';
import {
  executeCredentialRequest,
  type RuntimeCredentialStore,
} from './runtime-private-channel';
import type {
  RuntimeCommand,
  RuntimeReply,
  RuntimeUpdate,
  RuntimeTokenDelta,
} from './runtime-protocol';
import { RuntimeTokenBuffer } from './runtime-token-stream';
import type { PrivateExternalFileRequest } from './runtime-external-file-channel';
import type { LocalTerminalRow, RuntimeCommandWait } from './contracts';
import {
  describeRuntimeExit,
  redactRuntimeOutput,
  RUNTIME_RESTART_DELAY_MS,
  RUNTIME_RESTART_WINDOW_MS,
} from './runtime-exit';
import {
  validateBrowserRequest,
  type BrowserReply,
  type BrowserRequest,
  type BrowserResult,
} from '../../../src/browser/protocol.js';
import {
  validateTerminalRequest,
  type TerminalReply,
  type TerminalRequest,
  type TerminalResult,
} from '../../../src/terminal/protocol.js';
export type BrowserHandler = (
  request: BrowserRequest,
  signal: AbortSignal,
) => Promise<BrowserResult>;
export type TerminalHandler = (
  request: TerminalRequest,
  signal: AbortSignal,
) => Promise<TerminalResult>;
/** A conversation's terminal tabs as the runtime tells them, or `gone` when it stops. */
export type TerminalTabsHandler = (
  update: { conversation: string; rows: LocalTerminalRow[] } | 'gone',
) => void;
const TERMINAL_TAB_ACTIONS = new Set(['take', 'return', 'stop']);
const TAB_STATES = new Set(['idle', 'waiting', 'operating', 'held']);
/** A tab row from the runtime, checked before the window is given it. */
function tabRows(value: unknown): LocalTerminalRow[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const rows: LocalTerminalRow[] = [];
  for (const row of value as Record<string, unknown>[]) {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.id !== 'string' ||
      !/^local:[A-Za-z0-9-]{1,100}$/.test(row.id) ||
      typeof row.terminal !== 'string' ||
      row.id !== `local:${row.terminal}` ||
      !Number.isSafeInteger(row.ordinal) ||
      !TAB_STATES.has(String(row.state)) ||
      typeof row.allowed !== 'boolean' ||
      (row.held !== undefined &&
        row.held !== 'attach' &&
        row.held !== 'handoff') ||
      (row.reason !== undefined &&
        (typeof row.reason !== 'string' || row.reason.length > 4000))
    )
      return undefined;
    rows.push({
      id: row.id,
      terminal: row.terminal,
      ordinal: row.ordinal as number,
      state: row.state as LocalTerminalRow['state'],
      allowed: row.allowed,
      ...(row.held ? { held: row.held as 'attach' | 'handoff' } : {}),
      ...(row.reason ? { reason: row.reason as string } : {}),
    });
  }
  return rows;
}

/** The failure of a command the runtime kept: its name says what must be checked. */
function commandTimeout(name: string, waitedMs: number): Error {
  const error = Error(
    `runtime command timed out; execution state must be checked · ${name} (${Math.round(
      waitedMs / 1000,
    )}s)`,
  );
  error.name = 'RuntimeCommandTimeoutError';
  return error;
}

const STDERR_TAIL = 16 * 1024;
// What the runtime wrote on stdout, kept for the one diagnosis stderr cannot give:
// what a command that never answered was waiting on. It never reaches the window.
const STDOUT_TAIL = 64 * 1024;
const LOG_LIMIT = 1024 * 1024;
/** A command this far from an answer is said to the windows: the runtime is busy. */
export const RUNTIME_COMMAND_WAIT_MS = 4_000;
/** How often that wait is restated, so a window can count the seconds. */
const RUNTIME_COMMAND_WAIT_TICK_MS = 1_000;
/** How long the runtime may keep a command before it is said to have failed. */
export const RUNTIME_COMMAND_TIMEOUT_MS = 120_000;
export interface RuntimeSupervisorOptions {
  /** Where unexpected exits, with the end of the runtime's stderr, are recorded. */
  logFile?: string;
  restartDelayMs?: number;
  version?: string;
  /** How long a command may go unanswered; a test shortens what a person waits for. */
  commandTimeoutMs?: number;
  /** How long a command may be held before the windows are told the runtime is busy. */
  commandWaitMs?: number;
}

/** One app-owned core process survives renderer reloads and closes actual jobs on quit. */
export class RuntimeSupervisor {
  private child?: UtilityProcess;
  private stoppedAt = 0;
  private startedAt = 0;
  private automaticRestartAt?: number;
  private restarting?: Promise<void>;
  private cancelRestartWait?: () => void;
  private pending = new Map<
    string,
    {
      resolve: (reply: RuntimeReply) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      /** What the runtime was asked, and when it stopped answering it. */
      name: string;
      sentAt: number;
    }
  >();
  // The command the runtime is holding longest, said to the windows while it waits
  private waitListeners = new Set<(wait: RuntimeCommandWait | null) => void>();
  private waitTimer?: ReturnType<typeof setInterval>;
  private waiting?: RuntimeCommandWait;
  private stdoutTail = '';
  private stderrTail = '';
  private externalGrantRequests = new Map<string, string>();
  private latest?: RuntimeUpdate;
  private tokenBuffer = new RuntimeTokenBuffer();
  private tokenListeners = new Set<(delta: RuntimeTokenDelta) => void>();
  private tokenResync?: Promise<void>;
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  private listeners = new Set<(update: RuntimeUpdate) => void>();
  private workspaceListeners = new Set<
    (event: WorkspaceServiceEvent) => void
  >();
  private credentialStore?: RuntimeCredentialStore;
  private credentialRequests = new Map<string, Promise<unknown>>();
  private completedCredentialRequests = new Set<string>();
  // The runtime's browser and terminal requests under way, to stop when it says so or exits
  private browserRequests = new Map<string, AbortController>();
  private browserHandler?: BrowserHandler;
  private terminalRequests = new Map<string, AbortController>();
  private terminalHandler?: TerminalHandler;
  private sessionCleanup?: (sessionId: string) => Promise<void>;
  private terminalCleanup?: (sessionId: string) => Promise<void>;
  // The person's own terminal tabs live in the runtime with their shells: what it says
  // of them goes to the window, and the person's take, return and stop come back
  private terminalTabsHandler?: TerminalTabsHandler;
  /** What Circle last said it does with each conversation's tabs, for a window opened later. */
  private readonly terminalTabRows = new Map<string, LocalTerminalRow[]>();
  private terminalTabRequests = new Map<
    string,
    {
      resolve: (rows: LocalTerminalRow[]) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    readonly home: string,
    readonly directory: string,
    // A link an extension asked to open; the caller checks it before opening anything.
    private readonly openUrl: (url: string) => void = () => {},
    private readonly options: RuntimeSupervisorOptions = {},
  ) {}
  get connected() {
    return !!this.child && !!this.latest?.connected;
  }
  async start() {
    await this.spawn();
  }
  private spawn() {
    let stderr = '';
    this.stdoutTail = '';
    this.stderrTail = '';
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('runtime did not start')),
        30_000,
      );
      const child = utilityProcess.fork(
        join(this.directory, 'runtime-worker.mjs'),
        [],
        {
          serviceName: 'Circle Runtime',
          stdio: 'pipe',
          env: { ...process.env, CIRCLE_DESKTOP_RUNTIME_HOME: this.home },
        },
      );
      this.child = child;
      this.startedAt = Date.now();
      // Avoid dumping model credentials or workspace contents into app stderr.
      // The end of stderr is kept to say why the runtime died (V8 writes
      // "JavaScript heap out of memory" there) and goes only to the log.
      child.stdout?.on('data', (chunk: Buffer | string) => {
        this.stdoutTail = (this.stdoutTail + String(chunk)).slice(-STDOUT_TAIL);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = (stderr + String(chunk)).slice(-STDERR_TAIL);
        this.stderrTail = stderr;
      });
      child.on(
        'message',
        (message: {
          type: string;
          update?: RuntimeUpdate;
          reply?: RuntimeReply;
          url?: unknown;
          request?: unknown;
          id?: unknown;
          sessionId?: unknown;
          event?: WorkspaceServiceEvent;
          delta?: RuntimeTokenDelta;
          conversation?: unknown;
          rows?: unknown;
          ok?: unknown;
          error?: unknown;
        }) => {
          if (message.type === 'token-delta' && message.delta) {
            const result = this.tokenBuffer.apply(message.delta);
            if (result === 'applied') {
              for (const listener of this.tokenListeners) {
                try {
                  listener(message.delta);
                } catch {
                  /* a consumer can pull state */
                }
              }
            } else if (result !== 'duplicate' && !this.tokenResync) {
              this.tokenResync = this.command({
                id: randomUUID(),
                name: 'state',
                payload: {},
              })
                .then(() => {})
                .catch(() => {})
                .finally(() => {
                  this.tokenResync = undefined;
                });
            }
            return;
          }
          if (message.type === 'workspace-event' && message.event) {
            for (const listener of this.workspaceListeners) {
              try {
                listener(message.event);
              } catch {
                /* subscriber reconnects via durable replay */
              }
            }
            return;
          }
          if (message.type === 'credential-request') {
            this.credentials(message, child);
            return;
          }
          if (message.type === 'open-url' && typeof message.url === 'string')
            this.openUrl(message.url);
          if (message.type === 'browser') this.browser(message.request);
          if (message.type === 'browser-release')
            this.releaseSession(message.id, message.sessionId);
          if (message.type === 'browser-cancel')
            this.browserRequests.get(String(message.id))?.abort();
          if (message.type === 'terminal') this.terminal(message.request);
          if (message.type === 'terminal-release')
            this.releaseTerminal(message.id, message.sessionId);
          if (message.type === 'terminal-cancel')
            this.terminalRequests.get(String(message.id))?.abort();
          if (message.type === 'terminal-tabs') this.terminalTabs(message);
          if (message.type === 'terminal-tab-reply')
            this.terminalTabReply(message);
          if (message.type === 'update' && message.update) {
            if (!this.tokenBuffer.acceptFull(message.update)) return;
            this.latest = message.update;
            clearTimeout(timer);
            resolve();
            for (const listener of this.listeners) listener(message.update);
          }
          if (message.type === 'reply' && message.reply) {
            const pending = this.pending.get(message.reply.id);
            const grantOwner = this.externalGrantRequests.get(message.reply.id);
            if (grantOwner) {
              this.externalGrantRequests.delete(message.reply.id);
              if (!pending && message.reply.ok) {
                const grant = message.reply.data as
                  { id?: unknown; sessionId?: unknown } | undefined;
                if (
                  typeof grant?.id === 'string' &&
                  grant.sessionId === grantOwner
                )
                  void this.revokeExternalFileGrant(grantOwner, grant.id).catch(
                    () => {},
                  );
              }
            }
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(message.reply.id);
              this.reportWait();
              pending.resolve(message.reply);
            }
          }
        },
      );
      this.exited = new Promise<void>((exit) =>
        child.once('exit', (code) => {
          clearTimeout(timer);
          const error = this.childExited(child, code, stderr);
          reject(error);
          exit();
        }),
      );
    });
  }
  private childExited(
    child: UtilityProcess,
    code: number | null | undefined,
    stderr: string,
  ): Error {
    if (this.child !== child) return Error('runtime replaced');
    const expected = !!this.closing;
    const exit = describeRuntimeExit(code, stderr);
    this.child = undefined;
    this.stoppedAt = Date.now();
    this.externalGrantRequests.clear();
    this.credentialRequests.clear();
    this.completedCredentialRequests.clear();
    for (const request of this.browserRequests.values()) request.abort();
    this.browserRequests.clear();
    for (const request of this.terminalRequests.values()) request.abort();
    this.terminalRequests.clear();
    for (const request of this.terminalTabRequests.values()) {
      clearTimeout(request.timer);
      request.reject(Error('the runtime stopped'));
    }
    this.terminalTabRequests.clear();
    this.terminalTabRows.clear();
    this.terminalTabsHandler?.('gone');
    const error = Error(exit.message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.reportWait();
    const restarting = !expected && !!this.latest && this.automaticRestart();
    if (!expected)
      this.log(
        [
          `runtime stopped: ${exit.message}${exit.detail ? ` · ${exit.detail}` : ''}`,
          `up ${Math.round((this.stoppedAt - this.startedAt) / 1000)}s · ${restarting ? `restarting in ${Math.round(this.restartDelay / 1000)}s` : this.restarting ? 'restart under way' : 'not restarted automatically'}`,
          stderr.trim()
            ? `last stderr:\n${redactRuntimeOutput(stderr.trimEnd())}`
            : 'no stderr',
        ].join('\n'),
      );
    if (this.latest) {
      const previous = this.latest.snapshot.runtime;
      this.latest = this.tokenBuffer.materialize();
      this.latest = {
        ...this.latest,
        seq: this.latest.seq + 1,
        connected: false,
        snapshot: {
          ...this.latest.snapshot,
          // A lost core cannot report further progress. Preserve output
          // and unsent queue entries, but retire all live claims. This
          // does not assert that detached child processes were killed.
          sessions: this.latest.snapshot.sessions.map((session) => ({
            ...session,
            state:
              session.turn || session.state === 'waiting'
                ? ('paused' as const)
                : session.state,
            turn: undefined,
            ...(session.turn || session.state === 'waiting'
              ? { actionError: error.message }
              : {}),
            messages: session.messages.map((message) => ({
              ...message,
              ...(message.at === 'streaming' ? { interrupted: true } : {}),
              ...(message.tool &&
              ['running', 'waiting'].includes(message.tool.status)
                ? {
                    tool: { ...message.tool, status: 'unknown' as const },
                  }
                : {}),
              ...(message.shell?.status === 'running' ||
              message.shell?.status === 'background'
                ? {
                    shell: { ...message.shell, status: 'error' as const },
                  }
                : {}),
            })),
          })),
          agents: (this.latest.snapshot.agents ?? []).map((agent) =>
            agent.status === 'running' ||
            agent.status === 'waiting' ||
            (agent.task &&
              [
                'queued',
                'preparing',
                'running',
                'waiting',
                'cancelling',
              ].includes(agent.task.runtimeState ?? agent.task.state))
              ? { ...agent, status: 'unknown' as const }
              : agent,
          ),
          jobs: (this.latest.snapshot.jobs ?? []).map((job) =>
            ['running', 'waiting', 'stopping'].includes(job.state)
              ? {
                  ...job,
                  state: 'interrupted' as const,
                  stopRequested: false,
                }
              : job,
          ),
          interactions: (this.latest.snapshot.interactions ?? []).filter(
            (interaction) => interaction.status !== 'pending',
          ),
          // The saved connection did not go away with the process: keep
          // saying whether one is configured, and say the runtime stopped.
          runtime: {
            configured: previous?.configured ?? false,
            ...(previous?.hasKey === undefined
              ? {}
              : { hasKey: previous.hasKey }),
            connected: false,
            error: error.message,
            stopped: {
              reason: exit.reason,
              code: exit.code,
              restarting: restarting || !!this.restarting,
              at: new Date(this.stoppedAt).toISOString(),
            },
          },
        },
      };
      this.publishLatest();
    }
    if (restarting) void this.restart().catch(() => {});
    return error;
  }
  private get restartDelay() {
    return this.options.restartDelayMs ?? RUNTIME_RESTART_DELAY_MS;
  }
  /** Restart by itself once; a runtime that dies again soon after stays stopped. */
  private automaticRestart() {
    if (this.closing || this.restarting) return false;
    const now = Date.now();
    if (
      this.automaticRestartAt !== undefined &&
      now - this.automaticRestartAt < RUNTIME_RESTART_WINDOW_MS
    )
      return false;
    this.automaticRestartAt = now;
    return true;
  }
  /** Start a new runtime after one stopped. The sessions it reopens are the
   * stored ones; the turn that was cut off is marked interrupted there. */
  restart(): Promise<void> {
    if (this.closing) return Promise.reject(Error('Circle is quitting'));
    if (this.child) return Promise.resolve();
    if (this.restarting) return this.restarting;
    const operation = (async () => {
      this.markStopped({ restarting: true });
      const wait = this.stoppedAt + this.restartDelay - Date.now();
      if (wait > 0)
        await new Promise<void>((done) => {
          const timer = setTimeout(done, wait);
          this.cancelRestartWait = () => {
            clearTimeout(timer);
            done();
          };
        });
      this.cancelRestartWait = undefined;
      if (this.closing) throw Error('Circle is quitting');
      await this.spawn();
      this.log(`runtime restarted`);
    })();
    this.restarting = operation;
    void operation.then(
      () => {
        if (this.restarting === operation) this.restarting = undefined;
      },
      (error) => {
        if (this.restarting === operation) this.restarting = undefined;
        if (this.closing) return;
        const message = `Circle runtime could not restart: ${error instanceof Error ? error.message : String(error)}`;
        this.log(message);
        this.markStopped({ restarting: false, error: message });
      },
    );
    return operation;
  }
  private markStopped(change: { restarting: boolean; error?: string }) {
    const runtime = this.latest?.snapshot.runtime;
    if (!this.latest || !runtime || this.latest.connected) return;
    this.latest = {
      ...this.latest,
      seq: this.latest.seq + 1,
      snapshot: {
        ...this.latest.snapshot,
        runtime: {
          ...runtime,
          ...(change.error ? { error: change.error } : {}),
          ...(runtime.stopped
            ? { stopped: { ...runtime.stopped, restarting: change.restarting } }
            : {}),
        },
      },
    };
    this.publishLatest();
  }
  private publishLatest() {
    const update = this.latest;
    if (!update) return;
    for (const listener of this.listeners) listener(update);
  }
  private log(text: string) {
    const file = this.options.logFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      try {
        if (statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`);
      } catch {
        /* no log yet */
      }
      const where = `circle ${this.options.version ?? '?'} · electron ${process.versions.electron ?? '?'} · ${process.platform} ${process.arch}`;
      appendFileSync(file, `${new Date().toISOString()} ${where}\n${text}\n\n`);
    } catch {
      /* the log is best effort */
    }
  }
  /** Who carries out the runtime's browser requests: the window's browser sessions. */
  onBrowser(handler: BrowserHandler) {
    this.browserHandler = handler;
  }
  /** Who carries out the runtime's device-terminal requests: the window's consoles. */
  onTerminal(handler: TerminalHandler) {
    this.terminalHandler = handler;
  }
  onSessionCleanup(handler: (sessionId: string) => Promise<void>) {
    this.sessionCleanup = handler;
  }
  onWorkspaceEvent(listener: (event: WorkspaceServiceEvent) => void) {
    this.workspaceListeners.add(listener);
    return () => {
      this.workspaceListeners.delete(listener);
    };
  }
  onTokenDelta(listener: (delta: RuntimeTokenDelta) => void) {
    this.tokenListeners.add(listener);
    return () => {
      this.tokenListeners.delete(listener);
    };
  }
  onCredentials(store: RuntimeCredentialStore) {
    this.credentialStore = store;
  }
  private credentials(message: unknown, child: UtilityProcess) {
    const id = (message as { id?: unknown })?.id;
    if (
      typeof id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(id) ||
      this.credentialRequests.has(id) ||
      this.completedCredentialRequests.has(id)
    )
      return;
    if (this.credentialRequests.size >= 64) {
      child.postMessage({
        type: 'credential-reply',
        id,
        ok: false,
        error: 'native credential operation failed',
      });
      return;
    }
    const operation = executeCredentialRequest(message, this.credentialStore)
      .then((reply) => {
        if (reply && this.child === child) child.postMessage(reply);
      })
      .finally(() => {
        // Keep a small request ledger so duplicate IDs cannot repeat a put/delete.
        this.credentialRequests.delete(id);
        this.completedCredentialRequests.add(id);
        if (this.completedCredentialRequests.size > 128)
          this.completedCredentialRequests.delete(
            this.completedCredentialRequests.values().next().value!,
          );
      });
    this.credentialRequests.set(id, operation);
  }
  /** The same cleanup for the device consoles of a deleted conversation. */
  onTerminalCleanup(handler: (sessionId: string) => Promise<void>) {
    this.terminalCleanup = handler;
  }
  /** Who shows what Circle does with the person's own terminal tabs: the window. */
  onTerminalTabs(handler: TerminalTabsHandler) {
    this.terminalTabsHandler = handler;
    // A window opened again (macOS keeps the application without one) learns at once
    // what Circle is doing with the tabs: rows that did not change are not sent again.
    for (const [conversation, rows] of this.terminalTabRows)
      handler({ conversation, rows });
  }
  /** The person takes a terminal tab, hands it back or stops Circle on it. */
  terminalTabControl(
    conversation: string,
    session: string,
    action: 'take' | 'return' | 'stop',
  ): Promise<LocalTerminalRow[]> {
    const child = this.child;
    if (!child) return Promise.reject(Error('runtime disconnected'));
    if (!TERMINAL_TAB_ACTIONS.has(action))
      return Promise.reject(Error('invalid terminal action'));
    const id = randomUUID();
    return new Promise<LocalTerminalRow[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.terminalTabRequests.delete(id);
        reject(Error('the runtime did not answer'));
      }, 15_000);
      this.terminalTabRequests.set(id, { resolve, reject, timer });
      try {
        child.postMessage({
          type: 'terminal-tab-control',
          id,
          conversation,
          session,
          action,
        });
      } catch (error) {
        clearTimeout(timer);
        this.terminalTabRequests.delete(id);
        reject(error instanceof Error ? error : Error(String(error)));
      }
    });
  }
  private terminalTabs(message: { conversation?: unknown; rows?: unknown }) {
    const rows = tabRows(message.rows);
    if (
      !rows ||
      typeof message.conversation !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(message.conversation)
    )
      return;
    if (rows.length) this.terminalTabRows.set(message.conversation, rows);
    else this.terminalTabRows.delete(message.conversation);
    this.terminalTabsHandler?.({ conversation: message.conversation, rows });
  }
  private terminalTabReply(message: {
    id?: unknown;
    ok?: unknown;
    rows?: unknown;
    error?: unknown;
  }) {
    const pending = this.terminalTabRequests.get(String(message.id));
    if (!pending) return;
    this.terminalTabRequests.delete(String(message.id));
    clearTimeout(pending.timer);
    const rows = tabRows(message.rows);
    if (message.ok === true && rows) pending.resolve(rows);
    else
      pending.reject(
        Error(
          typeof message.error === 'string'
            ? message.error
            : 'the terminal tab action failed',
        ),
      );
  }
  private releaseSession(id: unknown, sessionId: unknown) {
    if (
      typeof id !== 'string' ||
      id.length > 200 ||
      typeof sessionId !== 'string' ||
      sessionId.length > 200
    )
      return;
    if (!this.latest?.snapshot.sessions.some((row) => row.id === sessionId)) {
      this.reply({
        id,
        ok: false,
        error: 'session not found for browser cleanup',
      });
      return;
    }
    void Promise.resolve()
      .then(() => this.sessionCleanup?.(sessionId))
      .then(
        () =>
          this.reply({
            id,
            ok: true,
            data: { text: 'session browser closed' },
          }),
        (error) =>
          this.reply({
            id,
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'session browser cleanup failed',
          }),
      );
  }
  private releaseTerminal(id: unknown, sessionId: unknown) {
    if (
      typeof id !== 'string' ||
      id.length > 200 ||
      typeof sessionId !== 'string' ||
      sessionId.length > 200
    )
      return;
    if (!this.latest?.snapshot.sessions.some((row) => row.id === sessionId)) {
      this.terminalReply({
        id,
        ok: false,
        error: 'session not found for terminal cleanup',
      });
      return;
    }
    void Promise.resolve()
      .then(() => this.terminalCleanup?.(sessionId))
      .then(
        () =>
          this.terminalReply({
            id,
            ok: true,
            data: { text: 'session terminals closed' },
          }),
        (error) =>
          this.terminalReply({
            id,
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'session terminal cleanup failed',
          }),
      );
  }
  private browser(value: unknown) {
    let request: BrowserRequest;
    try {
      request = validateBrowserRequest(value);
    } catch (error) {
      const id = (value as { id?: unknown })?.id;
      if (typeof id === 'string')
        this.reply({ id, ok: false, error: String(error) });
      return;
    }
    const handler = this.browserHandler;
    if (!handler) {
      this.reply({ id: request.id, ok: false, error: 'the browser is closed' });
      return;
    }
    const controller = new AbortController();
    this.browserRequests.set(request.id, controller);
    void Promise.resolve()
      .then(() => handler(request, controller.signal))
      .then(
        (data) => this.reply({ id: request.id, ok: true, data }),
        (error) =>
          this.reply({
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
  }
  private reply(reply: BrowserReply) {
    this.browserRequests.delete(reply.id);
    this.child?.postMessage({ type: 'browser-reply', reply });
  }
  private terminal(value: unknown) {
    let request: TerminalRequest;
    try {
      request = validateTerminalRequest(value);
    } catch (error) {
      const id = (value as { id?: unknown })?.id;
      if (typeof id === 'string')
        this.terminalReply({ id, ok: false, error: String(error) });
      return;
    }
    const handler = this.terminalHandler;
    if (!handler) {
      this.terminalReply({
        id: request.id,
        ok: false,
        error: 'the terminal host is closed',
      });
      return;
    }
    const controller = new AbortController();
    this.terminalRequests.set(request.id, controller);
    void Promise.resolve()
      .then(() => handler(request, controller.signal))
      .then(
        (data) => this.terminalReply({ id: request.id, ok: true, data }),
        (error) =>
          this.terminalReply({
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
  }
  private terminalReply(reply: TerminalReply) {
    this.terminalRequests.delete(reply.id);
    this.child?.postMessage({ type: 'terminal-reply', reply });
  }
  state() {
    if (!this.latest) throw Error('runtime not ready');
    return this.latest.connected ? this.tokenBuffer.materialize() : this.latest;
  }
  subscribe(listener: (update: RuntimeUpdate) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** A command the runtime has kept for several seconds, or nothing once it answers. */
  onCommandWait(listener: (wait: RuntimeCommandWait | null) => void) {
    this.waitListeners.add(listener);
    return () => this.waitListeners.delete(listener);
  }
  /** Say what is still waiting, or that nothing is: a window opened late learns within a tick. */
  private reportWait() {
    const now = Date.now();
    let longest: RuntimeCommandWait | undefined;
    for (const [id, entry] of this.pending) {
      const waitedMs = now - entry.sentAt;
      if (waitedMs < (this.options.commandWaitMs ?? RUNTIME_COMMAND_WAIT_MS))
        continue;
      if (!longest || waitedMs > longest.waitedMs)
        longest = { id, name: entry.name, waitedMs };
    }
    if (!longest) {
      // A command still in the queue may cross the line later: go on watching
      // until nothing is pending, or its wait would never be said.
      if (!this.pending.size && this.waitTimer) {
        clearInterval(this.waitTimer);
        this.waitTimer = undefined;
      }
      if (!this.waiting) return;
      this.waiting = undefined;
      for (const listener of this.waitListeners) listener(null);
      return;
    }
    this.waiting = longest;
    for (const listener of this.waitListeners) listener(longest);
  }
  private watchWait() {
    this.reportWait();
    if (this.waitTimer || this.pending.size === 0) return;
    // A restated second at a time; a test that waits a moment is watched that often.
    this.waitTimer = setInterval(
      () => this.reportWait(),
      Math.min(
        RUNTIME_COMMAND_WAIT_TICK_MS,
        this.options.commandWaitMs ?? RUNTIME_COMMAND_WAIT_MS,
      ),
    );
  }
  /** Called only by the native picker after its active-session checks. */
  async grantExternalFile(
    sessionId: string,
    path: string,
    access: 'read' | 'readwrite',
  ) {
    const reply = await this.privateExternalFile({
      type: 'external-file-capability',
      id: randomUUID(),
      operation: 'grant',
      sessionId,
      path,
      access,
    });
    if (!reply.ok) throw Error(reply.error ?? 'external file grant failed');
    return reply.data as {
      id: string;
      sessionId: string;
      path: string;
      access: 'read' | 'readwrite';
    };
  }
  async revokeExternalFileGrant(sessionId: string, id: string) {
    const reply = await this.privateExternalFile({
      type: 'external-file-capability',
      id: randomUUID(),
      operation: 'revoke',
      sessionId,
      grantId: id,
    });
    if (!reply.ok)
      throw Error(reply.error ?? 'external file revocation failed');
    return reply.data as { revoked: boolean };
  }
  private privateExternalFile(
    request: PrivateExternalFileRequest,
  ): Promise<RuntimeReply> {
    if (!this.child) return Promise.reject(Error('runtime disconnected'));
    if (request.operation === 'grant') {
      if (this.externalGrantRequests.size >= 64)
        return Promise.reject(Error('too many native file selections'));
      this.externalGrantRequests.set(request.id, request.sessionId);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(Error('native external file capability request timed out'));
      }, 30_000);
      this.pending.set(request.id, {
        resolve,
        reject,
        timer,
        name: 'external-file-capability',
        sentAt: Date.now(),
      });
      this.child!.postMessage(request);
    });
  }
  async command(command: RuntimeCommand): Promise<RuntimeReply> {
    if (!this.child) throw Error('runtime disconnected');
    if (this.pending.has(command.id)) throw Error('duplicate runtime command');
    return new Promise((resolve, reject) => {
      const sentAt = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        this.reportWait();
        const waited = Date.now() - sentAt;
        // A command the runtime never answered is the failure the person cannot
        // see for themselves: the log says what it was and what it last wrote.
        this.log(
          [
            `runtime command timed out: ${command.name} after ` +
              `${Math.round(waited / 1000)}s`,
            this.stdoutTail.trim()
              ? `last stdout:\n${redactRuntimeOutput(this.stdoutTail.trimEnd())}`
              : 'no stdout',
            this.stderrTail.trim()
              ? `last stderr:\n${redactRuntimeOutput(this.stderrTail.trimEnd())}`
              : 'no stderr',
          ].join('\n'),
        );
        reject(commandTimeout(command.name, waited));
      }, this.options.commandTimeoutMs ?? RUNTIME_COMMAND_TIMEOUT_MS);
      this.pending.set(command.id, {
        resolve,
        reject,
        timer,
        name: command.name,
        sentAt,
      });
      this.watchWait();
      // Discard extra renderer properties: private message tags may never be
      // smuggled through the public command validator.
      this.child!.postMessage({
        id: command.id,
        name: command.name,
        payload: command.payload,
        ...(command.sessionId === undefined
          ? {}
          : { sessionId: command.sessionId }),
      });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.cancelRestartWait?.();
      const child = this.child;
      if (!child) return;
      let reply;
      try {
        reply = await this.command({
          id: randomUUID(),
          name: 'close',
          payload: {},
        });
      } catch (error) {
        // A runtime that stopped while it was asked to close has nothing left to stop. A
        // signal to every process of the application (pkill, the end of a Linux session)
        // stops it just as the main process asks, and quitting goes on.
        if (this.child !== child) return;
        throw error;
      }
      if (!reply.ok) throw Error(reply.error ?? 'runtime close failed');
      this.child?.kill();
      await this.exited;
    })();
    return this.closing;
  }
}
