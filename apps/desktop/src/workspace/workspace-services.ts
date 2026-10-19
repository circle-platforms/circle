import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { spawnPty } from './native-pty.ts';
import { WorkspaceDocuments, type WorkspaceDocumentEdit } from './documents.ts';
import { TerminalManager, type TerminalSignal } from './terminal.ts';
import { GitWorkspaceService } from './git.ts';
import { DeliveryService } from './delivery.ts';
import { PullRequestReader } from './pulls.ts';
import type { NativeGitHubConnection } from './github-connection.ts';
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
  runtimeExecutable: string;
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
  private releasing = new Set<string>();
  private loginOwners = new Map<string, string>();
  private activeDelivery?: DeliveryService;
  private pullRequests?: PullRequestReader;
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
  async hasActiveSession(sessionId: string): Promise<boolean> {
    await this.terminals.activeIds(sessionId);
    return this.hasActiveSessionNow(sessionId);
  }
  hasActiveSessionNow(sessionId: string): boolean {
    if (this.terminals.activeIdsNow(sessionId).length) return true;
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
      await Promise.all(
        (await this.terminals.activeIds(sessionId)).map((id) =>
          this.terminals.close(sessionId, id),
        ),
      );
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
    this.failureCleanup = this.terminals.dispose().catch(() => {});
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
      (service === 'delivery' &&
        method === 'login' &&
        params.action === 'cancel');
    if (this.failure && !emergency) throw this.failure;
    this.sessions.add(sessionId);
    if (service === 'pulls') {
      // What the overview shows of the repository and its pull requests; reads only.
      this.pullRequests ??= new PullRequestReader(this.options.workspaceRoot, {
        ghPath: this.options.ghPath,
      });
      return this.pullRequests.call(method, params);
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
                'enable GitHub and connect from the GitHub plugin details',
              );
          },
          spawn: () => {
            throw Error('open the GitHub plugin details to connect');
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
        ![
          'status',
          'snapshot',
          'changes',
          'diff',
          'branches',
          'history',
          'commitDiff',
          'checks',
          'logs',
        ].includes(method)
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
    this.watch.close();
    this.documents.close();
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

export class WorkspaceServicesClosedError extends Error {
  readonly code = 'WORKSPACE_SERVICES_CLOSED';
  constructor() {
    super('workspace services are closing or closed');
  }
}
