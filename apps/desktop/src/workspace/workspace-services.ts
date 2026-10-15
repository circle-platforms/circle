import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { spawn as spawnPty } from 'node-pty';
import { WorkspaceDocuments, type WorkspaceDocumentEdit } from './documents.ts';
import { TerminalManager, type TerminalSignal } from './terminal.ts';
import { GitWorkspaceService } from './git.ts';
import { LanguageService } from './language.ts';
import { WorkspaceDebugService } from './debug.ts';
import { DeliveryService } from './delivery.ts';
import type { CredentialStore } from './delivery-login.ts';
import { WorkspaceEventStream } from './event-stream.ts';
import type {
  WorkspaceService,
  WorkspaceServiceEvent,
} from '../workspace-protocol.ts';
const exec = promisify(execFile);
export interface WorkspaceServicesOptions {
  workspaceRoot: string;
  dataDir: string;
  nodeExecutable: string;
  runtimeExecutable: string;
  adapterPath: string;
  ghPath: string;
  credentialStore?: CredentialStore;
  emit: (event: WorkspaceServiceEvent) => void;
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
  private sessions = new Set<string>();
  private epoch = randomUUID();
  private seq = 0;
  private workspaceId: string;
  private pending = Promise.resolve();
  private failure?: Error;
  private closed = false;
  private watch: ReturnType<WorkspaceDocuments['watch']>;
  constructor(options: WorkspaceServicesOptions) {
    this.options = options;
    this.workspaceId = createHash('sha256')
      .update(path.resolve(options.workspaceRoot))
      .digest('hex');
    const directory = path.join(
      options.dataDir,
      'workspaces',
      this.workspaceId,
    );
    this.ready = WorkspaceEventStream.open(
      path.join(directory, 'events.jsonl'),
    );
    this.ready.catch((e) => {
      this.failure = e;
    });
    this.documents = new WorkspaceDocuments(options.workspaceRoot);
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
      this.failure = e;
    });
    this.terminals = new TerminalManager(
      {
        workspaceRoot: options.workspaceRoot,
        logRoot: path.join(directory, 'terminals'),
      },
      (event) =>
        this.persist({
          workspaceId: this.workspaceId,
          sessionId: event.sessionId,
          service: 'terminal',
          resourceId: event.terminalId,
          epoch: event.epoch,
          seq: event.sequence,
          at: event.at,
          data: { ...event },
        }),
    );
    this.git = exec(
      'git',
      ['-C', options.workspaceRoot, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8' },
    ).then(async ({ stdout }) => {
      const root = await realpath(options.workspaceRoot);
      if (stdout.trim() !== root)
        throw Error('open the repository root to grant Git workspace access');
      return new GitWorkspaceService(root);
    });
    this.git.catch(() => {});
    this.delivery = this.git.then(
      (g) =>
        new DeliveryService(g.root, options.ghPath, {
          spawn: (file, args, opts) => spawnPty(file, args, opts),
          credentialStore: options.credentialStore,
        }),
    );
    this.delivery.catch(() => {});
  }
  private persist(event: WorkspaceServiceEvent): Promise<void> {
    const operation = this.pending.then(async () => {
      if (this.failure) throw this.failure;
      const stream = await this.ready;
      const persisted = await stream.appendSource(event);
      this.options.emit(persisted);
    });
    this.pending = operation.catch((e) => {
      this.failure = e instanceof Error ? e : Error(String(e));
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
    if (!sessionId || sessionId.includes('\0'))
      throw Error('session identity is required');
    await this.ready;
    if (this.failure) throw this.failure;
    this.sessions.add(sessionId);
    if (service === 'documents') {
      let result: unknown;
      const file = String(params.path ?? '');
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
        if (!Array.isArray(params.edits))
          throw Error('document edits are required');
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
      const id = String(params.id ?? params.terminalId ?? '');
      if (method === 'create')
        return this.terminals.create({
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
      if (method === 'list') return this.terminals.list(sessionId);
      if (method === 'write')
        return this.terminals.write(sessionId, id, params.data as string);
      if (method === 'resize')
        return this.terminals.resize(
          sessionId,
          id,
          params.cols as number,
          params.rows as number,
        );
      if (method === 'signal')
        return this.terminals.signal(
          sessionId,
          id,
          params.signal as TerminalSignal,
        );
      if (method === 'close') return this.terminals.close(sessionId, id);
      if (method === 'restart') return this.terminals.restart(sessionId, id);
      if (method === 'replay')
        return this.terminals.replay(
          sessionId,
          id,
          (params.afterSequence ?? params.after ?? 0) as number,
          (params.limit ?? 256) as number,
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
        await this.publish(sessionId, 'language', String(params.path), {
          kind: method,
        });
      return result;
    }
    if (service === 'debug') {
      let debug = this.debuggers.get(sessionId);
      if (!debug) {
        debug = new WorkspaceDebugService({
          ...this.options,
          emit: (snapshot) => {
            void this.publish(sessionId, 'debug', sessionId, { snapshot });
          },
        });
        this.debuggers.set(sessionId, debug);
      }
      return debug.handle(
        method === 'list' ? 'snapshot' : method === 'start' ? 'launch' : method,
        params,
      );
    }
    if (service === 'git' || service === 'delivery') {
      const target = service === 'git' ? await this.git : await this.delivery;
      const result = await target.call(method, params);
      if (
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
  async dispose() {
    if (this.closed) return;
    this.closed = true;
    this.watch.close();
    this.documents.close();
    for (const language of this.languages.values()) language.dispose();
    await Promise.allSettled(
      [...this.debuggers.values()].map((debug) => debug.dispose()),
    );
    await this.terminals.dispose();
    await this.delivery.then(
      (service) => service.dispose(),
      () => {},
    );
    await this.pending;
    await (await this.ready).close();
  }
}
