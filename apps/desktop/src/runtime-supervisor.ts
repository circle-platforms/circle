import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
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
import {
  validateBrowserRequest,
  type BrowserReply,
  type BrowserRequest,
  type BrowserResult,
} from '../../../src/browser/protocol.js';
export type BrowserHandler = (
  request: BrowserRequest,
  signal: AbortSignal,
) => Promise<BrowserResult>;

/** One app-owned core process survives renderer reloads and closes actual jobs on quit. */
export class RuntimeSupervisor {
  private child?: UtilityProcess;
  private pending = new Map<
    string,
    {
      resolve: (reply: RuntimeReply) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
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
  // The runtime's browser requests under way, to stop when it says so or exits
  private browserRequests = new Map<string, AbortController>();
  private browserHandler?: BrowserHandler;
  private sessionCleanup?: (sessionId: string) => Promise<void>;
  constructor(
    readonly home: string,
    readonly directory: string,
    // A link an extension asked to open; the caller checks it before opening anything.
    private readonly openUrl: (url: string) => void = () => {},
  ) {}
  get connected() {
    return !!this.child && !!this.latest?.connected;
  }
  async start() {
    const ready = new Promise<void>((resolve, reject) => {
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
      // Avoid dumping model credentials or workspace contents into app stderr.
      child.stdout?.on('data', () => {});
      child.stderr?.on('data', () => {});
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
              pending.resolve(message.reply);
            }
          }
        },
      );
      this.exited = new Promise<void>((exit) =>
        child.once('exit', (code) => {
          clearTimeout(timer);
          this.child = undefined;
          this.externalGrantRequests.clear();
          this.credentialRequests.clear();
          this.completedCredentialRequests.clear();
          for (const request of this.browserRequests.values()) request.abort();
          this.browserRequests.clear();
          const error = Error(`Circle runtime exited (${code})`);
          for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
          }
          this.pending.clear();
          if (this.latest) {
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
                    ...(message.at === 'streaming'
                      ? { interrupted: true }
                      : {}),
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
                runtime: {
                  connected: false,
                  configured: false,
                  error: error.message,
                },
              },
            };
            for (const listener of this.listeners) listener(this.latest);
          }
          reject(error);
          exit();
        }),
      );
    });
    await ready;
  }
  /** Who carries out the runtime's browser requests: the window's browser sessions. */
  onBrowser(handler: BrowserHandler) {
    this.browserHandler = handler;
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
  state() {
    if (!this.latest) throw Error('runtime not ready');
    return this.latest.connected ? this.tokenBuffer.materialize() : this.latest;
  }
  subscribe(listener: (update: RuntimeUpdate) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
      this.pending.set(request.id, { resolve, reject, timer });
      this.child!.postMessage(request);
    });
  }
  async command(command: RuntimeCommand): Promise<RuntimeReply> {
    if (!this.child) throw Error('runtime disconnected');
    if (this.pending.has(command.id)) throw Error('duplicate runtime command');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(
          Error('runtime command timed out; execution state must be checked'),
        );
      }, 120_000);
      this.pending.set(command.id, { resolve, reject, timer });
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
      if (!this.child) return;
      const reply = await this.command({
        id: randomUUID(),
        name: 'close',
        payload: {},
      });
      if (!reply.ok) throw Error(reply.error ?? 'runtime close failed');
      this.child?.kill();
      await this.exited;
    })();
    return this.closing;
  }
}
