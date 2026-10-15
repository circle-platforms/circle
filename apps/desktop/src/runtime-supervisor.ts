import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  RuntimeCommand,
  RuntimeReply,
  RuntimeUpdate,
} from './runtime-protocol';
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
  private latest?: RuntimeUpdate;
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  private listeners = new Set<(update: RuntimeUpdate) => void>();
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
        }) => {
          if (message.type === 'open-url' && typeof message.url === 'string')
            this.openUrl(message.url);
          if (message.type === 'browser') this.browser(message.request);
          if (message.type === 'browser-release')
            this.releaseSession(message.id, message.sessionId);
          if (message.type === 'browser-cancel')
            this.browserRequests.get(String(message.id))?.abort();
          if (message.type === 'update' && message.update) {
            if (this.latest && message.update.seq <= this.latest.seq) return;
            this.latest = message.update;
            clearTimeout(timer);
            resolve();
            for (const listener of this.listeners) listener(message.update);
          }
          if (message.type === 'reply' && message.reply) {
            const pending = this.pending.get(message.reply.id);
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
          for (const request of this.browserRequests.values()) request.abort();
          this.browserRequests.clear();
          const error = Error(`Circle runtime exited (${code})`);
          for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
          }
          this.pending.clear();
          if (this.latest) {
            this.latest = {
              ...this.latest,
              seq: this.latest.seq + 1,
              connected: false,
              snapshot: {
                ...this.latest.snapshot,
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
    return this.latest;
  }
  subscribe(listener: (update: RuntimeUpdate) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
      this.child!.postMessage(command);
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
