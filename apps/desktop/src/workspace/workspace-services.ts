import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { spawnPty } from './native-pty.ts';
import { WorkspaceDocuments, type WorkspaceDocumentEdit } from './documents.ts';
import { TerminalManager, type TerminalSignal } from './terminal.ts';
import { GitWorkspaceService } from './git.ts';
import { LanguageService } from './language.ts';
import { WorkspaceDebugService } from './debug.ts';
import { DeliveryService } from './delivery.ts';
import type { NativeGitHubConnection } from './github-connection.ts';
import {
  DeliveryCycleService,
  type CyclePorts,
  type CycleSpec,
} from './delivery-cycle.ts';
import type { CredentialStore } from './delivery-login.ts';
import {
  WorkspaceEventStream,
  type StreamCursor,
  type EventStreamOptions,
} from './event-stream.ts';
import type {
  WorkspaceService,
  WorkspaceServiceEvent,
} from '../workspace-protocol.ts';
const exec = promisify(execFile);
export interface WorkspaceServicesOptions {
  workspaceRoot: string;
  workspaceId?: string;
  dataDir: string;
  nodeExecutable: string;
  runtimeExecutable: string;
  adapterPath: string;
  ghPath: string;
  githubConnection?: NativeGitHubConnection;
  enforceGitHubConnection?: boolean;
  githubEnabled?: (sessionId: string) => boolean;
  githubInvocation?: (sessionId: string) => {
    signal: AbortSignal;
    assertActive: () => void;
  };
  credentialStore?: CredentialStore;
  credentialFiles?: string[];
  terminalEnv?: NodeJS.ProcessEnv;
  cyclePorts?: (sessionId: string) => CyclePorts | Promise<CyclePorts>;
  cycleIntervalMs?: number;
  emit: (event: WorkspaceServiceEvent) => void;
  onPersistenceError?: (error: Error) => void;
  maxPendingEventBytes?: number;
  eventStreamOptions?: EventStreamOptions;
}
/** One host-owned service container per granted workspace; renderer identities never select owners. */
export class WorkspaceServices {
  readonly documents: WorkspaceDocuments;
  readonly terminals: TerminalManager;
  private options: WorkspaceServicesOptions;
  private ready: Promise<WorkspaceEventStream>;
  private git: Promise<GitWorkspaceService>;
  private delivery: Promise<DeliveryService>;
  private languages = new Map<string, LanguageService>();
  private debuggers = new Map<string, WorkspaceDebugService>();
  private debugTerminals = new Map<string, Set<string>>();
  private sessions = new Set<string>();
  private epoch = randomUUID();
  private seq = 0;
  private workspaceId: string;
  private pending = Promise.resolve();
  private failure?: Error;
  private pendingEventBytes = 0;
  private failureCleanup?: Promise<void>;
  private closed = false;
  private disposed = false;
  private disposePromise?: Promise<void>;
  private ownerCycles = new Map<string, OwnedCycles>();
  private cycleDirectory: string;
  private releasing = new Set<string>();
  private loginOwners = new Map<string, string>();
  private activeDelivery?: DeliveryService;
  private watch: ReturnType<WorkspaceDocuments['watch']>;
  /** Subscription identity only. Session authorization is checked by the host. */
  get id(): string {
    return this.workspaceId;
  }
  constructor(options: WorkspaceServicesOptions) {
    this.options = options;
    const rootHash = createHash('sha256')
      .update(path.resolve(options.workspaceRoot))
      .digest('hex');
    this.workspaceId = options.workspaceId ?? rootHash.slice(0, 24);
    const directory = path.join(options.dataDir, 'workspaces', rootHash);
    this.cycleDirectory = path.join(directory, 'delivery');
    this.ready = WorkspaceEventStream.open(
      path.join(directory, 'events.jsonl'),
      options.eventStreamOptions,
    );
    this.ready.catch((e) => {
      this.failPersistence(e);
    });
    this.documents = new WorkspaceDocuments(options.workspaceRoot, {
      credentialFiles: options.credentialFiles,
    });
    this.watch = this.documents.watch(
      (snapshot) => {
        const paths = snapshot.changes.map((change) => change.file.path);
        for (const language of this.languages.values())
          language.invalidate(paths);
        for (const session of this.sessions)
          this.publish(session, 'documents', 'files', {
            kind: 'files',
            snapshot,
          });
      },
      {
        onError: (error) => {
          for (const session of this.sessions)
            this.publish(session, 'documents', 'files', {
              kind: 'error',
              error: error.message,
            });
        },
      },
    );
    this.watch.ready.catch((e) => {
      this.failPersistence(e);
    });
    this.terminals = new TerminalManager(
      {
        workspaceRoot: options.workspaceRoot,
        logRoot: path.join(directory, 'terminals'),
        env: {
          ...options.terminalEnv,
          PATH: [
            path.dirname(options.runtimeExecutable),
            options.terminalEnv?.PATH ?? process.env.PATH,
          ]
            .filter(Boolean)
            .join(path.delimiter),
        },
      },
      (event) => {
        return this.persist({
          workspaceId: this.workspaceId,
          sessionId: event.sessionId,
          service: 'terminal',
          resourceId: event.terminalId,
          epoch: event.epoch,
          seq: event.sequence,
          at: event.at,
          data: { ...event },
        });
      },
    );
    this.git = exec(
      'git',
      ['-C', options.workspaceRoot, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8' },
    ).then(async ({ stdout }) => {
      const root = await realpath(options.workspaceRoot);
      if ((await realpath(stdout.trim())) !== root)
        throw Error('open the repository root to grant Git workspace access');
      return new GitWorkspaceService(root);
    });
    this.git.catch(() => {});
    this.delivery = this.git.then(
      (g) =>
        (this.activeDelivery = new DeliveryService(g.root, options.ghPath, {
          spawn: (file, args, opts) => spawnPty(file, args, opts),
          credentialStore: options.credentialStore,
          connection: options.githubConnection,
        })),
    );
    this.delivery.catch(() => {});
  }
  /** Trusted extension adapter only; not exposed by the renderer method router. */
  deliveryAdapter() {
    return this.delivery;
  }
  private async cyclesFor(sessionId: string): Promise<DeliveryCycleService> {
    if (!this.options.cyclePorts)
      throw Error(
        'automated delivery is unavailable until trusted task and verification services are connected',
      );
    let entry = this.ownerCycles.get(sessionId);
    if (entry?.stopped) throw Error('session delivery cycles are closed');
    if (!entry) {
      const owned: OwnedCycles = {
        service: undefined as unknown as Promise<DeliveryCycleService>,
        stopped: false,
      };
      owned.service = Promise.resolve().then(async () => {
        const ports = await this.options.cyclePorts!(sessionId);
        if (owned.stopped || this.closed)
          throw Error('session delivery cycles are closed');
        const check = () => {
          if (owned.stopped || this.closed || this.failure)
            throw Error('session delivery cycle has stopped');
        };
        const guarded = <T extends object>(target: T): T =>
          new Proxy(target, {
            get(object, key) {
              const value = Reflect.get(object, key);
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => {
                check();
                return Reflect.apply(value, object, args);
              };
            },
          });
        const service = await DeliveryCycleService.open({
          dataDir: path.join(
            this.cycleDirectory,
            createHash('sha256').update(sessionId).digest('hex'),
          ),
          ports: {
            bind: (cycle, mode) => {
              check();
              ports.bind?.(cycle, mode);
            },
            tasks: guarded(ports.tasks),
            git: guarded(ports.git),
            delivery: guarded(ports.delivery),
            verify: (cycle) => {
              check();
              return ports.verify(cycle);
            },
          },
          onEvent: (cycle) => {
            void this.publish(sessionId, 'cycles', cycle.id, {
              kind: 'cycle',
              id: cycle.id,
              state: cycle.state,
              attempt: cycle.attempt,
            });
          },
        });
        if (owned.stopped || this.closed) {
          await service.close();
          return service;
        }
        owned.timer = setInterval(
          () => this.advanceCycles(sessionId, owned),
          this.options.cycleIntervalMs ?? 1000,
        );
        owned.timer.unref();
        return service;
      });
      this.ownerCycles.set(sessionId, owned);
      entry = owned;
      owned.service
        .then(() => this.advanceCycles(sessionId, owned))
        .catch(() => {
          if (!owned.stopped && this.ownerCycles.get(sessionId) === owned)
            this.ownerCycles.delete(sessionId);
        });
    }
    return entry.service;
  }
  private advanceCycles(sessionId: string, owned: OwnedCycles) {
    if (this.closed || this.failure || owned.stopped || owned.tick) return;
    owned.tick = (async () => {
      const service = await owned.service;
      for (const cycle of service.list()) {
        if (this.closed || this.failure || owned.stopped) break;
        if (['needs_review', 'pending_human_merge'].includes(cycle.state))
          continue;
        try {
          await service.advance(cycle.id);
        } catch (error) {
          await this.publish(sessionId, 'cycles', cycle.id, {
            kind: 'cycle-error',
            id: cycle.id,
            error:
              error instanceof Error
                ? error.message
                : 'cycle advancement failed',
          });
        }
      }
    })()
      .catch((error) => this.failPersistence(error))
      .finally(() => {
        owned.tick = undefined;
      });
  }
  private async closeCycles(sessionId: string) {
    const owned = this.ownerCycles.get(sessionId);
    if (!owned) return;
    owned.stopped = true;
    if (owned.timer) clearInterval(owned.timer);
    await owned.tick;
    await owned.service.then(
      (service) => service.close(),
      () => undefined,
    );
  }
  async hasActiveSession(sessionId: string): Promise<boolean> {
    const owned = this.ownerCycles.get(sessionId);
    if (owned && !owned.stopped) {
      const cycles = await owned.service.catch(() => undefined);
      if (
        cycles &&
        cycles
          .list()
          .some(
            (cycle) =>
              !['needs_review', 'pending_human_merge'].includes(cycle.state),
          )
      )
        return true;
    }
    if (
      (await this.terminals.list(sessionId)).some(
        (t) =>
          t.owner === sessionId && ['running', 'stopping'].includes(t.status),
      )
    )
      return true;
    const debug = this.debuggers.get(sessionId)?.snapshot();
    if (debug && ['starting', 'running', 'paused'].includes(debug.status))
      return true;
    for (const [id, owner] of this.loginOwners)
      if (owner === sessionId) {
        try {
          if (
            ['starting', 'waiting', 'saving'].includes(
              this.activeDelivery?.login?.poll(id).status ?? '',
            )
          )
            return true;
        } catch {}
      }
    return false;
  }
  hasActiveSessionResources(sessionId: string) {
    return this.hasActiveSession(sessionId);
  }
  async releaseSession(sessionId: string): Promise<void> {
    if (this.releasing.has(sessionId))
      throw Error('session resources are already closing');
    this.releasing.add(sessionId);
    try {
      let cycleCloseError: unknown;
      const closingCycles = this.closeCycles(sessionId).catch((error) => {
        cycleCloseError = error;
      });
      const terminals = await this.terminals.list(sessionId);
      await Promise.all(
        terminals
          .filter((t) => ['running', 'stopping'].includes(t.status))
          .map((t) => this.terminals.close(sessionId, t.id)),
      );
      const debug = this.debuggers.get(sessionId);
      if (debug) {
        await debug.dispose();
        this.debuggers.delete(sessionId);
      }
      await closingCycles;
      if (cycleCloseError) throw cycleCloseError;
      this.debugTerminals.delete(sessionId);
      this.languages.get(sessionId)?.dispose();
      this.languages.delete(sessionId);
      for (const [id, owner] of this.loginOwners)
        if (owner === sessionId) {
          await this.activeDelivery?.login?.cancel(id);
          this.loginOwners.delete(id);
        }
      this.sessions.delete(sessionId);
    } finally {
      this.releasing.delete(sessionId);
    }
  }
  setCredentialFiles(patterns: string[]) {
    this.documents.setCredentialFiles(patterns);
  }
  async publishSource(event: WorkspaceServiceEvent): Promise<void> {
    if (this.closed) throw new WorkspaceServicesClosedError();
    if (event.workspaceId !== this.workspaceId)
      throw Error('event does not belong to this workspace');
    return this.persist(event);
  }
  async replay(after?: StreamCursor, limit?: number) {
    await this.pending;
    if (this.failure) throw this.failure;
    return (await this.ready).replay(after, limit);
  }
  get eventHealth() {
    return {
      pendingBytes: this.pendingEventBytes,
      error: this.failure?.message,
    };
  }
  private failPersistence(error: unknown) {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : Error(String(error));
    this.watch?.close();
    try {
      this.options.onPersistenceError?.(this.failure);
    } catch {}
    this.failureCleanup = (async () => {
      await Promise.allSettled([
        this.terminals.dispose(),
        ...[...this.debuggers.values()].map((debug) => debug.dispose()),
        ...[...this.ownerCycles.keys()].map((session) =>
          this.closeCycles(session),
        ),
      ]);
    })();
  }
  private persist(event: WorkspaceServiceEvent): Promise<void> {
    if (this.disposed)
      return Promise.reject(new WorkspaceServicesClosedError());
    if (this.failure) return Promise.reject(this.failure);
    let json: string;
    try {
      json = JSON.stringify(event);
    } catch (error) {
      this.failPersistence(error);
      return Promise.reject(this.failure);
    }
    const bytes = Buffer.byteLength(json);
    if (
      this.pendingEventBytes + bytes >
      (this.options.maxPendingEventBytes ?? 8 * 1024 * 1024)
    ) {
      this.failPersistence(
        Error(
          'workspace event queue exceeded its byte limit; owned processes are stopping',
        ),
      );
      return Promise.reject(this.failure);
    }
    this.pendingEventBytes += bytes;
    const snapshot = JSON.parse(json) as WorkspaceServiceEvent;
    const operation = this.pending.then(async () => {
      if (this.disposed) throw new WorkspaceServicesClosedError();
      if (this.failure) throw this.failure;
      const persisted = await (await this.ready).appendSource(snapshot);
      this.options.emit(persisted);
    });
    this.pending = operation
      .catch((error) => {
        if (!(error instanceof WorkspaceServicesClosedError))
          this.failPersistence(error);
      })
      .finally(() => {
        this.pendingEventBytes -= bytes;
      });
    return operation;
  }
  private publish(
    sessionId: string,
    service: WorkspaceService,
    resourceId: string,
    data: Record<string, unknown>,
  ) {
    const result = this.persist({
      workspaceId: this.workspaceId,
      sessionId,
      service,
      resourceId,
      data,
      epoch: this.epoch,
      seq: ++this.seq,
      at: new Date().toISOString(),
    });
    result.catch(() => {});
    return result;
  }
  async call(
    sessionId: string,
    service: WorkspaceService,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.closed) throw Error('workspace services are closed');
    if (!params || typeof params !== 'object' || Array.isArray(params))
      throw Error('workspace parameters must be an object');
    if (typeof sessionId !== 'string' || !sessionId || sessionId.includes('\0'))
      throw Error('session identity is required');
    if (this.releasing.has(sessionId))
      throw Error('session resources are closing');
    const githubInvocation =
      service === 'delivery'
        ? this.options.githubInvocation?.(sessionId)
        : undefined;
    await this.ready;
    const emergency =
      (service === 'terminal' && ['signal', 'close'].includes(method)) ||
      (service === 'debug' && method === 'stop') ||
      (service === 'delivery' &&
        method === 'login' &&
        params.action === 'cancel');
    if (this.failure && !emergency) throw this.failure;
    this.sessions.add(sessionId);
    if (service === 'cycles') {
      const cycles = await this.cyclesFor(sessionId);
      if (this.ownerCycles.get(sessionId)?.stopped)
        throw Error('session delivery cycles are closed');
      if (method === 'list') return cycles.list();
      const id = requiredString(params, 'id');
      if (method === 'snapshot') return cycles.snapshot(id);
      if (method === 'create') {
        if (params.workspace !== undefined)
          throw Error('cycle workspace is assigned by the trusted host');
        const title = requiredString(params, 'title');
        const body = requiredString(params, 'body', true);
        if (
          !Array.isArray(params.acceptanceCriteria) ||
          !params.acceptanceCriteria.length ||
          params.acceptanceCriteria.some(
            (item) => typeof item !== 'string' || !item.trim(),
          )
        )
          throw Error('acceptance criteria must be nonempty strings');
        const spec: CycleSpec = {
          id,
          title,
          body,
          workspace: this.options.workspaceRoot,
          acceptanceCriteria: params.acceptanceCriteria,
        };
        const result = await cycles.create(spec, {
          operationId: requiredString(params, 'operationId'),
        });
        this.advanceCycles(sessionId, this.ownerCycles.get(sessionId)!);
        return result;
      }
      if (method === 'advance') {
        const result = await cycles.advance(id);
        this.advanceCycles(sessionId, this.ownerCycles.get(sessionId)!);
        return result;
      }
      if (method === 'retryCI')
        return cycles.retryCI(
          id,
          requiredInteger(params, 'runId', 1, Number.MAX_SAFE_INTEGER),
          { operationId: requiredString(params, 'operationId') },
        );
      throw Error('unknown delivery cycle method');
    }
    if (service === 'documents') {
      if (method === 'resolveSource') {
        const input = requiredString(params, 'path');
        const root = await realpath(this.options.workspaceRoot);
        const target = await realpath(path.resolve(root, input));
        const relative = path.relative(root, target);
        if (
          !relative ||
          relative === '..' ||
          relative.startsWith('..' + path.sep) ||
          path.isAbsolute(relative)
        )
          throw Error('source is outside the granted workspace');
        const portable = relative.split(path.sep).join('/');
        await this.documents.read(portable);
        return { path: portable };
      }
      let result: unknown;
      const file =
        method === 'read' || method === 'save'
          ? requiredString(params, 'path')
          : '';
      if (method === 'read') return this.documents.read(file);
      if (method === 'refresh') return this.documents.refresh();
      if (method === 'save') {
        if (
          typeof params.content !== 'string' ||
          !(
            params.expectedRevision === null ||
            typeof params.expectedRevision === 'string'
          )
        )
          throw Error('content and expected document revision are required');
        result = await this.documents.save(
          file,
          params.content,
          params.expectedRevision,
        );
      } else if (method === 'applyEdits') {
        if (
          !Array.isArray(params.edits) ||
          params.edits.some(
            (edit) =>
              !edit ||
              typeof edit !== 'object' ||
              typeof edit.path !== 'string' ||
              typeof edit.content !== 'string' ||
              !(
                edit.expectedRevision === null ||
                typeof edit.expectedRevision === 'string'
              ),
          )
        )
          throw Error(
            'document edits require path, content and expectedRevision',
          );
        result = await this.documents.applyEdits(
          params.edits as WorkspaceDocumentEdit[],
        );
      } else throw Error('unknown document method');
      const changedPaths =
        method === 'save'
          ? [file]
          : (params.edits as WorkspaceDocumentEdit[]).map((edit) => edit.path);
      for (const language of this.languages.values())
        language.invalidate(changedPaths);
      await this.publish(sessionId, 'documents', file || 'batch', {
        kind: method,
        paths:
          method === 'save'
            ? [file]
            : (params.edits as WorkspaceDocumentEdit[]).map((e) => e.path),
      });
      return result;
    }
    if (service === 'terminal') {
      const id = ['create', 'list'].includes(method)
        ? ''
        : requiredString(
            { ...params, id: params.id ?? params.terminalId },
            'id',
          );
      if (method === 'create') {
        for (const name of ['cwd', 'shell', 'label'])
          optionalString(params, name);
        for (const name of ['cols', 'rows'])
          optionalInteger(params, name, 1, 1000);
        if (
          params.args !== undefined &&
          (!Array.isArray(params.args) ||
            params.args.some((arg) => typeof arg !== 'string'))
        )
          throw Error('terminal args must be strings');
        const serviceOptions = validateServiceOptions(params);
        return this.terminals.create({
          ...serviceOptions,
          owner: sessionId,
          sessionId,
          cwd:
            typeof params.cwd === 'string'
              ? path.resolve(this.options.workspaceRoot, params.cwd)
              : undefined,
          shell: typeof params.shell === 'string' ? params.shell : undefined,
          args: params.args as string[] | undefined,
          cols: params.cols as number | undefined,
          rows: params.rows as number | undefined,
          label: params.label as string | undefined,
        });
      }
      if (method === 'list') return this.terminals.list(sessionId);
      if (method === 'write')
        return this.terminals.write(
          sessionId,
          id,
          requiredString(params, 'data', true),
        );
      if (method === 'resize')
        return this.terminals.resize(
          sessionId,
          id,
          requiredInteger(params, 'cols', 1, 1000),
          requiredInteger(params, 'rows', 1, 1000),
        );
      if (method === 'signal') {
        if (
          typeof params.signal !== 'string' ||
          !['SIGINT', 'SIGTERM', 'SIGKILL'].includes(params.signal)
        )
          throw Error('invalid terminal signal');
        return this.terminals.signal(
          sessionId,
          id,
          params.signal as TerminalSignal,
        );
      }
      if (method === 'close') return this.terminals.close(sessionId, id);
      if (method === 'restart') return this.terminals.restart(sessionId, id);
      if (method === 'replay')
        return this.terminals.replay(
          sessionId,
          id,
          requiredInteger(
            { after: params.afterSequence ?? params.after ?? 0 },
            'after',
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          requiredInteger({ limit: params.limit ?? 256 }, 'limit', 1, 2000),
        );
      throw Error('unknown terminal method');
    }
    if (service === 'language') {
      let language = this.languages.get(sessionId);
      if (!language) {
        language = new LanguageService(this.options.workspaceRoot);
        this.languages.set(sessionId, language);
      }
      const result = language.call(method, params);
      if (method === 'open' || method === 'change' || method === 'close')
        await this.publish(
          sessionId,
          'language',
          requiredString(params, 'path'),
          {
            kind: method,
          },
        );
      return result;
    }
    if (service === 'debug') {
      let debug = this.debuggers.get(sessionId);
      if (!debug) {
        debug = new WorkspaceDebugService({
          ...this.options,
          runInTerminal: async (request) => {
            if (
              !Array.isArray(request.args) ||
              !request.args.length ||
              request.args.some(
                (arg) => typeof arg !== 'string' || arg.includes('\0'),
              )
            )
              throw Error('debug terminal arguments are invalid');
            const options = {
              owner: sessionId,
              sessionId,
              cwd: request.cwd,
              command: { file: request.args[0], args: request.args.slice(1) },
              env: request.env,
              label: 'debug',
            };
            const terminal = await this.terminals.create(options);
            const ids = this.debugTerminals.get(sessionId) ?? new Set<string>();
            ids.add(terminal.id);
            this.debugTerminals.set(sessionId, ids);
            if (!terminal.pid)
              throw Error('debug terminal did not return a process id');
            return { processId: terminal.pid };
          },
          emit: (snapshot) => {
            void this.publish(sessionId, 'debug', sessionId, { snapshot });
          },
        });
        this.debuggers.set(sessionId, debug);
      }
      try {
        return await debug.handle(
          method === 'list'
            ? 'snapshot'
            : method === 'start'
              ? 'launch'
              : method,
          params,
        );
      } finally {
        if (method === 'stop') {
          await Promise.all(
            [...(this.debugTerminals.get(sessionId) ?? [])].map((id) =>
              this.terminals.close(sessionId, id),
            ),
          );
          this.debugTerminals.delete(sessionId);
        }
      }
    }
    if (service === 'git' || service === 'delivery') {
      if (
        service === 'delivery' &&
        this.options.enforceGitHubConnection &&
        !this.options.githubConnection
      )
        throw Error('GitHub connection is unavailable in this runtime');
      let target = service === 'git' ? await this.git : await this.delivery;
      if (service === 'delivery' && this.options.githubConnection) {
        const source = await this.delivery;
        const invocation = githubInvocation;
        target = new DeliveryService(source.root, source.ghPath, {
          connection: this.options.githubConnection,
          epoch: this.options.githubConnection.snapshot().epoch,
          ...invocation,
          assertActive: () => {
            invocation?.assertActive();
            if (!this.options.githubEnabled?.(sessionId))
              throw Error(
                'enable GitHub in extensions and connect in settings',
              );
          },
          spawn: () => {
            throw Error('GitHub login belongs in settings');
          },
        });
      }
      if (
        service === 'delivery' &&
        method === 'login' &&
        params.action !== 'start' &&
        typeof params.id === 'string' &&
        this.loginOwners.get(params.id) !== sessionId
      )
        throw Error('login request does not belong to this session');
      const result = await target.call(method, params);
      if (
        service === 'delivery' &&
        method === 'login' &&
        (params.action === undefined || params.action === 'start')
      ) {
        const login = result as { id: string };
        const owner = this.loginOwners.get(login.id);
        if (owner && owner !== sessionId)
          throw Error('another session is signing in');
        this.loginOwners.set(login.id, sessionId);
      }
      if (
        !this.failure &&
        !['status', 'snapshot', 'diff', 'branches', 'checks', 'logs'].includes(
          method,
        )
      )
        for (const session of this.sessions)
          await this.publish(session, service, service, {
            kind: method,
            actorSessionId: sessionId,
          });
      return result;
    }
    throw Error('workspace service is managed by the host scheduler');
  }
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOwned();
    return this.disposePromise;
  }
  private async disposeOwned() {
    this.closed = true;
    await Promise.allSettled(
      [...this.ownerCycles.keys()].map((session) => this.closeCycles(session)),
    );
    this.watch.close();
    this.documents.close();
    for (const language of this.languages.values()) language.dispose();
    await Promise.allSettled(
      [...this.debuggers.values()].map((debug) => debug.dispose()),
    );
    await this.terminals.dispose();
    await this.failureCleanup;
    await this.delivery.then(
      (service) => service.dispose(),
      () => {},
    );
    await this.pending;
    this.disposed = true;
    await this.ready.then(
      (stream) => stream.close(),
      () => undefined,
    );
  }
}

function requiredString(
  params: Record<string, unknown>,
  key: string,
  empty = false,
): string {
  const value = params[key];
  if (typeof value !== 'string' || (!empty && !value) || value.includes('\0'))
    throw Error(`${key} must be a string`);
  return value;
}
function optionalString(params: Record<string, unknown>, key: string) {
  if (params[key] !== undefined) requiredString(params, key);
}
function requiredInteger(
  params: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = params[key];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw Error(`${key} must be an integer between ${min} and ${max}`);
  return value;
}
function optionalInteger(
  params: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
) {
  if (params[key] !== undefined) requiredInteger(params, key, min, max);
}

function validateServiceOptions(params: Record<string, unknown>) {
  let command: { file: string; args?: string[] } | undefined;
  let readiness:
    { pattern?: string; port?: number; timeoutMs?: number } | undefined;
  if (params.command !== undefined) {
    const value = params.command;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error('service command is required');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !['file', 'args'].includes(key)))
      throw Error('unknown service command field');
    const file = requiredString(record, 'file');
    if (
      record.args !== undefined &&
      (!Array.isArray(record.args) ||
        record.args.some(
          (arg) => typeof arg !== 'string' || arg.includes('\0'),
        ))
    )
      throw Error('command args must be strings');
    if (params.shell !== undefined || params.args !== undefined)
      throw Error('command cannot be combined with shell startup options');
    command = { file, args: record.args as string[] | undefined };
  }
  if (params.readiness !== undefined) {
    if (!command) throw Error('readiness requires a service command');
    const value = params.readiness;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error('invalid service readiness');
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => !['pattern', 'port', 'timeoutMs'].includes(key),
      )
    )
      throw Error('unknown readiness field');
    optionalString(record, 'pattern');
    optionalInteger(record, 'port', 1, 65535);
    optionalInteger(record, 'timeoutMs', 1, 300000);
    if (record.pattern === undefined && record.port === undefined)
      throw Error('readiness requires a literal pattern or local port');
    readiness = {
      pattern: record.pattern as string | undefined,
      port: record.port as number | undefined,
      timeoutMs: record.timeoutMs as number | undefined,
    };
  }
  return {
    ...(command ? { command } : {}),
    ...(readiness ? { readiness } : {}),
  };
}

interface OwnedCycles {
  service: Promise<DeliveryCycleService>;
  timer?: ReturnType<typeof setInterval>;
  tick?: Promise<void>;
  stopped: boolean;
}

export class WorkspaceServicesClosedError extends Error {
  readonly code = 'WORKSPACE_SERVICES_CLOSED';
  constructor() {
    super('workspace services are closing or closed');
  }
}
