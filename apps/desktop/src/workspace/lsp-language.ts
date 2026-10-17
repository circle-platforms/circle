import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_SERVERS,
  findExecutable,
  LspClient,
  type LspServer,
} from '../../../../src/lsp_tool.js';

import { LanguageService } from './language';

type Row = Record<string, any>;
export interface DiagnosticMetadata {
  provider: 'typescript' | 'lsp';
  documentVersion?: number;
}
const diagnosticMetadata = new WeakMap<object, DiagnosticMetadata>();
export function languageDiagnosticMetadata(
  result: unknown,
): DiagnosticMetadata | undefined {
  return result && typeof result === 'object'
    ? diagnosticMetadata.get(result)
    : undefined;
}
export interface LspLanguageOptions {
  /** Host-owned configuration only; never accept a renderer command or environment. */
  servers?: Readonly<Record<string, LspServer>>;
  timeout?: number;
  /** Existing document authorization, including credentials and symlink policy. */
  authorizePath(relative: string): Promise<string>;
}
const range = (value: Row) => ({
  startLineNumber: value.start.line + 1,
  startColumn: value.start.character + 1,
  endLineNumber: value.end.line + 1,
  endColumn: value.end.character + 1,
});
/** Optional non-TS language adapter. Missing executables fail explicitly; no install or fallback. */
export class LspLanguageService {
  private clients = new Map<string, Promise<LspClient>>();
  private documents = new Map<
    string,
    { client: LspClient; version: number; text: string }
  >();
  private diagnostics = new Map<string, Row[]>();
  private controller = new AbortController();
  private generation = 0;
  private closed = false;
  private disposing?: Promise<void>;
  private root: Promise<string>;
  private controls: Promise<unknown> = Promise.resolve();
  private lastProcesses = new Map<
    string,
    ReturnType<LspClient['processSnapshot']>
  >();
  constructor(
    root: string,
    private options: LspLanguageOptions,
  ) {
    this.root = fs.realpath(root);
  }
  private assertOpen() {
    if (this.closed) throw Error('language service is closed');
  }
  private async authorize(value: unknown): Promise<string> {
    this.assertOpen();
    if (
      typeof value !== 'string' ||
      !value ||
      path.isAbsolute(value) ||
      value.includes('\\') ||
      value.split('/').includes('..')
    )
      throw Error('use a workspace-relative language path');
    const root = await this.root;
    const authorized = await this.options.authorizePath(value);
    if (!path.isAbsolute(authorized))
      throw Error('language authorization must return an absolute path');
    let file: string;
    try {
      file = await fs.realpath(authorized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      file = path.join(
        await fs.realpath(path.dirname(authorized)),
        path.basename(authorized),
      );
    }
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative)
    )
      throw Error('language path is outside workspace');
    this.assertOpen();
    return file;
  }
  private async client(file: string): Promise<LspClient> {
    const extension = path.extname(file).toLowerCase();
    if (/^\.[cm]?[jt]sx?$/.test(extension))
      throw Error('use the bundled TypeScript language service');
    const server = (this.options.servers ?? DEFAULT_SERVERS)[extension];
    if (!server) throw Error(`no language server configured for ${extension}`);
    const key = JSON.stringify([server.command, server.args]);
    let pending = this.clients.get(key);
    if (!pending) {
      pending = (async () => {
        const root = await this.root;
        this.assertOpen();
        const client = new LspClient(server, root, this.options.timeout);
        client.onNotification((method, params) => {
          if (
            this.closed ||
            method !== 'textDocument/publishDiagnostics' ||
            !params ||
            typeof params !== 'object'
          )
            return;
          const message = params as Row;
          const document = this.documents.get(message.uri);
          // Unversioned push diagnostics cannot prove which overlay they describe.
          if (
            !document ||
            message.version !== document.version ||
            !Array.isArray(message.diagnostics)
          )
            return;
          this.diagnostics.set(message.uri, message.diagnostics);
        });
        try {
          await client.initialize(this.controller.signal);
          this.assertOpen();
          return client;
        } catch (error) {
          await client.close();
          this.lastProcesses.set(key, client.processSnapshot());
          this.clients.delete(key);
          throw error;
        }
      })();
      this.clients.set(key, pending);
    }
    return pending;
  }
  private async synchronize(file: string, content?: string, version?: number) {
    const client = await this.client(file);
    const uri = pathToFileURL(file).href;
    const disk =
      content === undefined && !this.documents.has(uri)
        ? await fs.readFile(file, 'utf8')
        : undefined;
    this.assertOpen();
    const previous = this.documents.get(uri);
    const text = content ?? previous?.text ?? disk!;
    const next =
      previous?.text === text && version === undefined
        ? previous.version
        : client.open(file, text, version);
    this.documents.set(uri, { client, version: next, text });
    if (previous?.text !== text) this.diagnostics.delete(uri);
    return { client, uri, version: next };
  }
  invalidate(_paths?: readonly string[]): void {
    this.generation++;
    this.diagnostics.clear();
  }
  async call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.assertOpen();
    if (method === 'request') {
      if (
        typeof params.method !== 'string' ||
        ['request', 'open', 'change'].includes(params.method)
      )
        throw Error('invalid language request');
      return this.call(params.method, params);
    }
    if (method === 'project' || method === 'refresh') {
      if (method === 'refresh') this.invalidate();
      const root = await this.root;
      return {
        version: this.generation,
        configPath: null,
        files: [...this.documents.keys()].map((uri) =>
          path.relative(root, fileURLToPath(uri)).split(path.sep).join('/'),
        ),
        diagnostics: [],
      };
    }
    if (Array.isArray(params.documents))
      for (const item of params.documents) {
        if (
          !item ||
          typeof item !== 'object' ||
          typeof (item as Row).content !== 'string'
        )
          throw Error('invalid document overlay');
        const row = item as Row;
        await this.synchronize(
          await this.authorize(row.path),
          row.content,
          row.version,
        );
      }
    const file = await this.authorize(params.path);
    if (['status', 'stop', 'restart'].includes(method)) {
      const run = this.controls.then(async () => {
        this.assertOpen();
        const server = (this.options.servers ?? DEFAULT_SERVERS)[
          path.extname(file).toLowerCase()
        ];
        if (!server) throw Error('no language server configured for this file');
        const key = JSON.stringify([server.command, server.args]);
        const existing = this.clients.get(key);
        if (method === 'status')
          return existing
            ? (await existing).processSnapshot()
            : (this.lastProcesses.get(key) ?? {
                kind: 'external',
                provider: 'lsp',
                canStop: false,
                canRestart: true,
                state: 'idle',
                command: server.command,
                cwd: await this.root,
                stderrTail: '',
              });
        this.generation++;
        this.diagnostics.clear();
        const old = existing ? await existing : undefined;
        const overlays = [...this.documents.entries()].filter(
          ([, value]) => value.client === old,
        );
        await old?.close();
        if (method === 'stop')
          return (
            old?.processSnapshot() ??
            this.lastProcesses.get(key) ?? {
              kind: 'external',
              provider: 'lsp',
              canStop: false,
              canRestart: true,
              state: 'idle',
              command: server.command,
              cwd: await this.root,
              stderrTail: '',
            }
          );
        this.assertOpen();
        this.clients.delete(key);
        this.lastProcesses.delete(key);
        const client = await this.client(file);
        for (const [uri, value] of overlays) {
          client.open(fileURLToPath(uri), value.text, value.version);
          this.documents.set(uri, { ...value, client });
        }
        return client.processSnapshot();
      });
      this.controls = run.catch(() => undefined);
      return run;
    }
    const uri = pathToFileURL(file).href;
    if (method === 'close') {
      this.documents.get(uri)?.client.closeDocument(file);
      this.documents.delete(uri);
      this.diagnostics.delete(uri);
      this.generation++;
      return {};
    }
    if (params.content !== undefined && typeof params.content !== 'string')
      throw Error('invalid document content');
    const snapshot = await this.synchronize(
      file,
      params.content as string | undefined,
      params.version as number | undefined,
    );
    if (['open', 'change', 'sync'].includes(method))
      return { version: snapshot.version };
    const epoch = this.generation;
    const request = async (name: string, body: Row) => {
      const result = await snapshot.client.request(
        name,
        body,
        this.controller.signal,
      );
      this.assertOpen();
      if (
        epoch !== this.generation ||
        this.documents.get(uri)?.version !== snapshot.version
      )
        throw Error('stale language response');
      return result as any;
    };
    const document = { uri };
    const position = {
      line: Math.max(0, Number(params.line ?? 1) - 1),
      character: Math.max(0, Number(params.column ?? 1) - 1),
    };
    const location = async (value: Row) => {
      const target = fileURLToPath(value.uri ?? value.targetUri);
      const relative = path
        .relative(await this.root, target)
        .split(path.sep)
        .join('/');
      await this.authorize(relative);
      return {
        path: relative,
        range: range(
          value.range ?? value.targetSelectionRange ?? value.targetRange,
        ),
      };
    };
    if (method === 'definition' || method === 'references') {
      const result = await request(`textDocument/${method}`, {
        textDocument: document,
        position,
        ...(method === 'references'
          ? { context: { includeDeclaration: true } }
          : {}),
      });
      const rows = result ? (Array.isArray(result) ? result : [result]) : [];
      const locations = await Promise.all(rows.map(location));
      this.assertOpen();
      if (
        epoch !== this.generation ||
        this.documents.get(uri)?.version !== snapshot.version
      )
        throw Error('stale language response');
      return locations;
    }
    if (method === 'completion') {
      const result = await request('textDocument/completion', {
        textDocument: document,
        position,
      });
      return (Array.isArray(result) ? result : (result?.items ?? [])).map(
        (item: Row) => ({
          label: item.label,
          insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
          kind: String(item.kind ?? 'text'),
          sortText: item.sortText,
        }),
      );
    }
    if (method === 'format')
      return (
        (await request('textDocument/formatting', {
          textDocument: document,
          options: { tabSize: 2, insertSpaces: true },
        })) ?? []
      ).map((item: Row) => ({ range: range(item.range), text: item.newText }));
    if (method === 'rename') {
      if (typeof params.newName !== 'string' || !params.newName.trim())
        throw Error('invalid symbol name');
      // WorkspaceEdit.changes and version:null carry no target version. Freeze
      // every known buffer before sending; never infer its old coordinates on reply.
      const targetBaselines = new Map(this.documents);
      const result = await request('textDocument/rename', {
        textDocument: document,
        position,
        newName: params.newName,
      });
      const changes: Row[] = Object.entries(result?.changes ?? {}).map(
        ([uri, edits]) => ({ uri, edits }),
      );
      for (const change of result?.documentChanges ?? []) {
        if (!change.textDocument || !Array.isArray(change.edits))
          throw Error('language resource operations are not supported');
        if (
          change.textDocument.version !== null &&
          change.textDocument.version !== undefined &&
          this.documents.get(change.textDocument.uri)?.version !==
            change.textDocument.version
        )
          throw Error('stale language rename');
        changes.push({ uri: change.textDocument.uri, edits: change.edits });
      }
      const assertTargetsCurrent = () => {
        for (const change of changes) {
          const baseline = targetBaselines.get(change.uri);
          const current = this.documents.get(change.uri);
          if (!baseline)
            throw Error('open all affected files, then rename again');
          if (
            !current ||
            current.version !== baseline.version ||
            current.text !== baseline.text
          )
            throw Error('stale language rename target');
        }
      };
      assertTargetsCurrent();
      const edits = (
        await Promise.all(
          changes.map(async (change) => {
            const resolved = await location({
              uri: change.uri,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
            });
            return change.edits.map((edit: Row) => ({
              path: resolved.path,
              range: range(edit.range),
              text: edit.newText,
            }));
          }),
        )
      ).flat();
      this.assertOpen();
      if (
        epoch !== this.generation ||
        this.documents.get(uri)?.version !== snapshot.version
      )
        throw Error('stale language response');
      assertTargetsCurrent();
      return edits;
    }
    if (method === 'diagnostics') {
      // Pull is deterministic for unsaved buffers; push fallback is only accepted with matching version.
      let rows = this.diagnostics.get(uri);
      if (!rows) {
        const result = await request('textDocument/diagnostic', {
          textDocument: document,
        });
        if (!result || !Array.isArray(result.items))
          throw Error(
            'language server did not provide diagnostics for this document',
          );
        rows = result.items;
      }
      const diagnostics = rows!.map((item) => ({
        path: params.path,
        source: item.source ?? 'lsp',
        ...range(item.range),
        message: item.message,
        severity: item.severity === 1 ? 8 : item.severity === 2 ? 4 : 2,
        code: String(item.code ?? ''),
      }));
      diagnosticMetadata.set(diagnostics, {
        provider: 'lsp',
        documentVersion: snapshot.version,
      });
      return diagnostics;
    }
    throw Error(`unknown language method: ${method}`);
  }
  dispose(): Promise<void> {
    return (this.disposing ??= this.finishDispose());
  }
  private async finishDispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.controller.abort();
    await Promise.allSettled(
      [...this.clients.values()].map(async (pending) =>
        (await pending).close(),
      ),
    );
    this.clients.clear();
    this.lastProcesses.clear();
    this.documents.clear();
    this.diagnostics.clear();
  }
}

/** Keeps the bundled TS/JS and JSON behavior while optionally routing installed LSPs. */
export class WorkspaceLanguageService {
  private builtin: LanguageService;
  private external: LspLanguageService;
  private servers: Record<string, LspServer>;
  constructor(
    root: string,
    private options: LspLanguageOptions,
  ) {
    this.builtin = new LanguageService(root);
    this.servers = Object.fromEntries(
      Object.entries(options.servers ?? DEFAULT_SERVERS).filter(
        ([extension, server]) =>
          !/^\.[cm]?[jt]sx?$/.test(extension) &&
          !!findExecutable(server.command),
      ),
    );
    this.external = new LspLanguageService(root, {
      ...options,
      servers: this.servers,
    });
  }
  private isExternal(value: unknown): boolean {
    return (
      typeof value === 'string' &&
      !!this.servers[path.extname(value).toLowerCase()]
    );
  }
  async call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === 'request') {
      if (
        typeof params.method !== 'string' ||
        ['request', 'open', 'change'].includes(params.method)
      )
        throw Error('invalid language request');
      return this.call(params.method, params);
    }
    // Authorize every main path and overlay before either provider sees content.
    if (method !== 'project' && method !== 'refresh') {
      if (typeof params.path !== 'string') throw Error('invalid language path');
      await this.options.authorizePath(params.path);
    }
    if (
      ['status', 'stop', 'restart'].includes(method) &&
      !this.isExternal(params.path)
    ) {
      if (method === 'stop')
        throw Error(
          'the bundled language service runs inside Circle and cannot be stopped separately',
        );
      if (method === 'restart') this.builtin.call('refresh', {});
      return {
        state: 'running',
        kind: 'in-process',
        provider: 'typescript',
        restart: 'refresh',
        canStop: false,
        canRestart: true,
      };
    }
    const external: Row[] = [],
      builtin: Row[] = [];
    if (Array.isArray(params.documents))
      for (const item of params.documents) {
        if (
          !item ||
          typeof item !== 'object' ||
          typeof (item as Row).path !== 'string' ||
          typeof (item as Row).content !== 'string'
        )
          throw Error('invalid document overlay');
        await this.options.authorizePath((item as Row).path);
        (this.isExternal((item as Row).path) ? external : builtin).push(
          item as Row,
        );
      }
    // Sync each non-target provider explicitly; the target receives only its own overlays.
    const externalTarget = this.isExternal(params.path);
    const other = externalTarget ? builtin : external;
    for (const document of other) {
      if (externalTarget) this.builtin.call('sync', document);
      else await this.external.call('sync', document);
    }
    const targetParams = {
      ...params,
      documents: externalTarget ? external : builtin,
    };
    if (externalTarget) return this.external.call(method, targetParams);
    const result = this.builtin.call(method, targetParams);
    if (method === 'diagnostics' && result && typeof result === 'object') {
      const state = this.builtin.call('sync', { path: params.path }) as {
        version: number;
      };
      diagnosticMetadata.set(result, {
        provider: 'typescript',
        ...(state.version > 0 ? { documentVersion: state.version } : {}),
      });
    }
    return result;
  }
  invalidate(paths?: readonly string[]): void {
    this.builtin.invalidate(paths);
    this.external.invalidate(paths);
  }
  async dispose(): Promise<void> {
    this.builtin.dispose();
    await this.external.dispose();
  }
}
