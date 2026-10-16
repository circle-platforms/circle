import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ChatModel,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolContext,
} from './types.js';
import { isRecord } from './settings.js';
import { Watch, waitWatch, abortable } from './watch.js';
import { JobRegistry, jobLine, type JobOwner } from './jobs.js';
import { ExtensionSecrets, SecretMask } from './extension_secrets.js';
import { checkedUrl } from './open_url.js';
import {
  SecretPromptError,
  cancelRequest,
  createExtensionRequest,
  pollAnswer,
  type SecretRequest,
} from './secret_prompt.js';

export class ToolError extends Error {}
export class ExtensionError extends Error {}
export interface CommandContext {
  workspace: string;
  toast(message: string): void;
  append(message: string): void;
  sendUserMessage(message: string): void;
}
export interface ExtensionCommand {
  name: string;
  description: string;
  handler(args: string, context: CommandContext): void | Promise<void>;
}
export interface SubagentSpec {
  name: string;
  description: string;
  system_prompt: string;
  model?: string;
}
export interface ToolInvocation {
  tool: Tool;
  args: Record<string, unknown>;
  context: ToolContext;
}
export type ModelMiddleware = (
  request: ModelRequest,
  next: (request: ModelRequest) => Promise<ModelResponse>,
) => Promise<ModelResponse>;
export type ToolMiddleware = (
  request: ToolInvocation,
  next: (request: ToolInvocation) => Promise<string>,
) => Promise<string>;
export type AfterModelMiddleware = (
  response: ModelResponse,
  request: ModelRequest,
) => ModelResponse | void | Promise<ModelResponse | void>;
export type ExtensionMiddleware =
  | { slot: 'model_call'; handler: ModelMiddleware }
  | { slot: 'tool_boundary'; handler: ToolMiddleware }
  | { slot: 'after_model'; handler: AfterModelMiddleware };
type ExtensionEvent =
  'session_start' | 'turn_start' | 'turn_end' | 'tool_result';
/** The lamps of the interface: running (yellow), ok (green), error (red), wait (cyan), none. */
export type ExtensionLamp = 'running' | 'ok' | 'error' | 'wait' | 'none';
export interface ExtensionStatus {
  extension: string;
  text: string;
  lamp: ExtensionLamp;
}
/** bundled: shipped with Circle and off until enabled; user and project: on until disabled. */
export type ExtensionSource = 'bundled' | 'user' | 'project';
// The folder of extensions that ship with Circle: src/extensions in a checkout, dist/extensions
// in a release, beside the bundled runtime in the desktop application.
export function bundledExtensionsRoot(): string {
  return fileURLToPath(new URL('./extensions/', import.meta.url));
}
export interface Extension {
  name: string;
  source: ExtensionSource;
  path: string;
  /** From an optional extension.json beside the entry file. */
  version: string;
  description: string;
  enabled: boolean;
  error: string;
  warnings: string[];
  tools: Tool[];
  commands: ExtensionCommand[];
  middleware: ExtensionMiddleware[];
  subagents: { spec: SubagentSpec; tools: string[] }[];
  renderers: Map<string, (update: Record<string, unknown>) => string[]>;
  handlers: Map<
    ExtensionEvent,
    ((event: Record<string, unknown>) => void | Promise<void>)[]
  >;
  /** Values from api.secrets and api.askSecret, masked in what the extension shows or returns. */
  mask: SecretMask;
  /** What it last set with api.setStatus. */
  status?: { text: string; lamp: ExtensionLamp };
  /** What it last published with api.setView, for an interface of its own to show. */
  view?: unknown;
}
// What the interface lends an extension: the Circle home, and a way to ask the user for a
// value without it passing through the conversation.
export interface ExtensionServices {
  home: string;
  /** The folder Circle works in. */
  workspace?: string;
  secret?: (request: SecretRequest, signal: AbortSignal) => Promise<void>;
  secretTimeoutMs?: number;
  /** The extension's own entry under `extensions` in settings.json. */
  settings?: Record<string, unknown>;
  /** Called when a status changes, so the interface can redraw. */
  onStatus?: () => void;
  /** Opens a checked http(s) link where this interface opens links. */
  openUrl?: (url: string) => Promise<void>;
  /** Fires when the host closes: what the extension sees as api.signal. */
  signal?: AbortSignal;
  /** Work of the extension that the host waits for when it closes. */
  track?: (work: Promise<unknown>) => void;
  /** Called when an extension adds or removes a tool after it loaded. */
  onTools?: () => void;
}
const live = new WeakSet<ExtensionAPI>();
const settled = (): void => undefined;
export class ExtensionAPI {
  readonly ToolError = ToolError;
  readonly Watch = Watch;
  /** Values this extension keeps between runs, in a private file of its own. */
  readonly secrets: ExtensionSecrets;
  /**
   * Fires when Circle closes the extension: when it leaves, and before extensions are loaded
   * again. Pass it to requests and timers, and end loops on it.
   */
  readonly signal: AbortSignal;
  constructor(
    private ext: Extension,
    private reservedTools: Set<string>,
    private reservedCommands: Set<string>,
    private jobs?: JobRegistry,
    private owner?: (context: ToolContext) => JobOwner,
    private services?: ExtensionServices,
  ) {
    this.secrets = new ExtensionSecrets(
      services?.home ?? '',
      ext.name,
      (value) => ext.mask.remember(value),
    );
    this.signal = services?.signal ?? new AbortController().signal;
  }
  /**
   * Work that goes on after a tool or command returned, such as following something until it
   * ends. Circle waits for it when it closes the extension, once api.signal has fired, so
   * nothing of the extension runs after Circle has left or loaded extensions again. An error
   * in it is shown under the extension in /extensions.
   */
  background(work: Promise<unknown>): void {
    if (!work || typeof work.then !== 'function')
      throw new ExtensionError('background needs a promise');
    const done = Promise.resolve(work).catch((error: unknown) => {
      const note = `background work failed: ${this.ext.mask.text(error instanceof Error ? error.message : String(error))}`;
      if (!this.ext.warnings.includes(note)) this.ext.warnings.push(note);
    });
    this.services?.track?.(done);
  }
  // A tool call or command in flight is work the host waits for when it closes.
  private tracked<T>(work: Promise<T>): Promise<T> {
    this.services?.track?.(work.then(settled, settled));
    return work;
  }
  get name(): string {
    return this.ext.name;
  }
  /** The folder Circle works in, where a tool would read or save the user's files. */
  get workspace(): string {
    return this.services?.workspace ?? '';
  }
  /** A folder of the extension's own for what it keeps that is not secret; made on first use.
   * Closing cleanup may still locate it, but cannot create it after the signal fires. */
  get dataDir(): string {
    if (!this.services?.home)
      throw new ExtensionError('this interface has no data folder');
    const path = join(this.services.home, 'extension_data', this.ext.name);
    if (!this.signal.aborted) mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
  /**
   * One short line that stays at the right of the footer while it holds, with a lamp: what
   * the extension is connected to, or what it is doing. null (or '') removes it.
   */
  setStatus(text: string | null, lamp: ExtensionLamp = 'none'): void {
    if (!['running', 'ok', 'error', 'wait', 'none'].includes(lamp))
      throw new ExtensionError(`unknown lamp '${String(lamp)}'`);
    const line = this.ext.mask
      .text(String(text ?? ''))
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    const next = line ? { text: line, lamp } : undefined;
    if (
      next?.text === this.ext.status?.text &&
      next?.lamp === this.ext.status?.lamp
    )
      return;
    this.ext.status = next;
    this.services?.onStatus?.();
  }
  /**
   * Publish data for the extension's own part of an interface, such as a page of the desktop
   * application paired with it. JSON only, at most 64 KB, with secrets masked; null removes it.
   */
  setView(data: unknown): void {
    if (data === null || data === undefined) {
      if (this.ext.view === undefined) return;
      this.ext.view = undefined;
      this.services?.onStatus?.();
      return;
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(data);
    } catch {
      json = undefined;
    }
    if (json === undefined)
      throw new ExtensionError('a view must be data that JSON can hold');
    if (Buffer.byteLength(json) > 65536)
      throw new ExtensionError('a view may be at most 64 KB');
    const masked = this.ext.mask.value(JSON.parse(json));
    if (JSON.stringify(masked) === JSON.stringify(this.ext.view)) return;
    this.ext.view = masked;
    this.services?.onStatus?.();
  }
  /** Open a web address in the browser: the system's, from the terminal or the application. */
  async openUrl(url: string): Promise<void> {
    const open = this.services?.openUrl;
    if (!open) throw new ExtensionError('this interface cannot open links');
    await open(checkedUrl(url));
  }
  /** Its entry under `extensions` in settings.json, read when it loaded. Changing it saves nothing. */
  get settings(): Record<string, unknown> {
    return structuredClone(this.services?.settings ?? {});
  }
  /**
   * Ask the user for a value on a masked card. It goes back to the extension only: not into
   * the conversation, the session or a file. null when the user cancels or does not answer.
   */
  async askSecret(
    question: string,
    options: { mask?: boolean; signal?: AbortSignal } = {},
  ): Promise<string | null> {
    if (typeof question !== 'string' || !question.trim())
      throw new ExtensionError('askSecret needs a question');
    const present = this.services?.secret;
    if (!present || !this.services?.home)
      throw new ExtensionError('this interface cannot ask for a secret');
    const home = this.services.home;
    const request = createExtensionRequest(home, {
      question,
      extension: this.ext.name,
      mask: options.mask,
    });
    const controller = new AbortController();
    // The card also goes when the extension is closed.
    const signal = AbortSignal.any([
      controller.signal,
      this.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const answering = pollAnswer(
      home,
      request.id,
      signal,
      this.services.secretTimeoutMs,
    );
    const presenting = present(request, signal).catch((error: unknown) => {
      controller.abort(error);
      throw error;
    });
    try {
      const [value] = await Promise.all([answering, presenting]);
      this.ext.mask.remember(value);
      return value;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof SecretPromptError) return null;
      throw error;
    } finally {
      controller.abort();
      await Promise.allSettled([answering, presenting]);
      await cancelRequest(home, request.id);
    }
  }
  private masked(error: unknown): unknown {
    if (error instanceof Error && this.ext.mask.size)
      error.message = this.ext.mask.text(error.message);
    return error;
  }
  registerTool(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (
      args: Record<string, unknown>,
      context: ToolContext,
    ) => unknown | Promise<unknown>,
    options: { readOnly?: boolean; approval?: boolean } = {},
  ): void {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
      throw new ExtensionError(`invalid tool name '${name}'`);
    if (
      this.reservedTools.has(name) ||
      this.ext.tools.some((tool) => tool.name === name)
    )
      throw new ExtensionError(`tool '${name}' already exists`);
    if (!isRecord(parameters) || parameters.type !== 'object')
      throw new ExtensionError(
        `tool '${name}': parameters must be a JSON Schema object`,
      );
    if (typeof execute !== 'function')
      throw new ExtensionError(`tool '${name}': execute must be callable`);
    if (live.has(this)) this.reservedTools.add(name);
    this.ext.tools.push({
      name,
      description: description || name,
      parameters,
      effect: options.readOnly ? 'read' : 'unknown',
      approval: options.approval ?? !options.readOnly,
      run: (args, context) =>
        this.tracked(this.runTool(execute, args, context)),
    });
    if (live.has(this)) this.services?.onTools?.();
  }
  /** Removes a tool this extension registered. A running session sees it gone from its next turn. */
  unregisterTool(name: string): boolean {
    const index = this.ext.tools.findIndex((tool) => tool.name === name);
    if (index < 0) return false;
    this.ext.tools.splice(index, 1);
    this.reservedTools.delete(name);
    if (live.has(this)) this.services?.onTools?.();
    return true;
  }
  private async runTool(
    execute: (
      args: Record<string, unknown>,
      context: ToolContext,
    ) => unknown | Promise<unknown>,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<string> {
    let result: unknown;
    try {
      result = await execute(args, context);
    } catch (error) {
      throw this.masked(error);
    }
    if (result instanceof Watch) result = this.maskWatch(result);
    else result = this.ext.mask.value(result);
    if (result instanceof Watch) {
      if (!this.jobs) {
        const complete = await waitWatch(result, context.signal);
        return typeof complete === 'string'
          ? complete
          : JSON.stringify(complete);
      }
      context.signal.throwIfAborted();
      const job = this.jobs.startWatch(
        result,
        this.owner?.(context) ?? {
          sessionId: context.sessionId,
          startedBy: 'model',
        },
        this.ext.name,
      );
      const initial = result.options.result;
      return (
        (initial === undefined
          ? ''
          : typeof initial === 'string'
            ? initial + '\n'
            : JSON.stringify(initial) + '\n') +
        `Watching in background: ${jobLine(job)}. A notice arrives when it ends; do not poll or sleep.`
      );
    }
    return typeof result === 'string' ? result : JSON.stringify(result ?? null);
  }
  registerCommand(
    name: string,
    description: string,
    handler: ExtensionCommand['handler'],
  ): void {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name))
      throw new ExtensionError(`invalid command name '${name}'`);
    if (
      this.reservedCommands.has(name) ||
      this.ext.commands.some((command) => command.name === name)
    )
      throw new ExtensionError(`command /${name} already exists`);
    if (typeof handler !== 'function')
      throw new ExtensionError('command handler must be callable');
    const mask = this.ext.mask;
    this.ext.commands.push({
      name,
      description,
      handler: (args, context) =>
        this.tracked(
          (async () => {
            try {
              await handler(args, {
                workspace: context.workspace,
                toast: (message) => context.toast(mask.text(String(message))),
                append: (message) => context.append(mask.text(String(message))),
                sendUserMessage: (message) =>
                  context.sendUserMessage(mask.text(String(message))),
              });
            } catch (error) {
              throw this.masked(error);
            }
          })(),
        ),
    });
  }
  // A watch whose results pass through the mask, read when each one arrives.
  private maskWatch(watch: Watch): Watch {
    const mask = this.ext.mask;
    return new Watch(
      mask.text(watch.title),
      async (signal) => mask.value(await watch.poll(signal)),
      { ...watch.options, result: mask.value(watch.options.result) },
    );
  }
  registerMiddleware(
    handler: ModelMiddleware | ToolMiddleware | AfterModelMiddleware,
    slot: ExtensionMiddleware['slot'] = 'tool_boundary',
  ): void {
    if (!['model_call', 'tool_boundary', 'after_model'].includes(slot))
      throw new ExtensionError(`unknown middleware slot '${slot}'`);
    if (typeof handler !== 'function')
      throw new ExtensionError('middleware must be callable');
    this.ext.middleware.push({ slot, handler } as ExtensionMiddleware);
  }
  registerSubagent(spec: SubagentSpec, tools: string[] = []): void {
    if (
      !isRecord(spec) ||
      !['name', 'description', 'system_prompt'].every(
        (key) => typeof spec[key] === 'string' && String(spec[key]).trim(),
      )
    )
      throw new ExtensionError(
        'subagent spec needs name, description and system_prompt',
      );
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(spec.name))
      throw new ExtensionError('invalid subagent name');
    if (
      !Array.isArray(tools) ||
      !tools.every((tool) => typeof tool === 'string')
    )
      throw new ExtensionError('subagent tools must be names');
    this.ext.subagents.push({ spec: { ...spec }, tools: [...tools] });
  }
  registerRenderer(
    kind: string,
    renderer: (update: Record<string, unknown>) => string[],
  ): void {
    if (!/^tool_result:.+/.test(kind) || typeof renderer !== 'function')
      throw new ExtensionError('renderer kind must be tool_result:<tool name>');
    this.ext.renderers.set(kind, renderer);
  }
  on(
    event: ExtensionEvent,
    handler: (event: Record<string, unknown>) => void | Promise<void>,
  ): void {
    if (
      !['session_start', 'turn_start', 'turn_end', 'tool_result'].includes(
        event,
      ) ||
      typeof handler !== 'function'
    )
      throw new ExtensionError(`unknown event '${event}'`);
    this.ext.handlers.set(event, [
      ...(this.ext.handlers.get(event) ?? []),
      handler,
    ]);
  }
}
export interface ExtensionHostOptions {
  home: string;
  workspace: string;
  trusted: boolean;
  /** Where bundled extensions are; false for none. Defaults to bundledExtensionsRoot(). */
  bundledRoot?: string | false;
  /** Called when an extension's status changes. */
  onStatus?: () => void;
  /** Where api.openUrl opens a link; without it openUrl fails. */
  openUrl?: (url: string) => Promise<void>;
  /** Called when a loaded extension adds or removes a tool. */
  onTools?: () => void;
  /** Shows a masked card for api.askSecret; without it askSecret fails. */
  secret?: ExtensionServices['secret'];
  secretTimeoutMs?: number;
  settings?: Record<string, Record<string, unknown>>;
  reservedTools?: Set<string>;
  reservedCommands?: Set<string>;
  jobs?: JobRegistry;
  jobOwner?: (context: ToolContext) => JobOwner;
}
export class ExtensionHost {
  extensions: Extension[] = [];
  // Fired by close(); every extension's api.signal.
  private readonly controller = new AbortController();
  // Work of the extensions that close() waits for: tool calls and commands in flight, event
  // handlers, and what they gave api.background.
  private readonly pending = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  constructor(readonly options: ExtensionHostOptions) {}
  discover(): Pick<
    Extension,
    'name' | 'source' | 'path' | 'version' | 'description'
  >[] {
    const found = new Map<
      string,
      Pick<Extension, 'name' | 'source' | 'path' | 'version' | 'description'>
    >();
    // Later roots replace earlier ones of the same name: yours over Circle's, the project's
    // over yours.
    const roots: [ExtensionSource, string][] = [];
    const bundled = this.options.bundledRoot ?? bundledExtensionsRoot();
    if (bundled) roots.push(['bundled', bundled]);
    roots.push(['user', join(this.options.home, 'extensions')]);
    if (this.options.trusted)
      roots.push([
        'project',
        join(this.options.workspace, '.circle', 'extensions'),
      ]);
    for (const [source, root] of roots) {
      if (!existsSync(root)) continue;
      for (const directory of readdirSync(root, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (
          !directory.isDirectory() ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(directory.name)
        )
          continue;
        const entry = ['extension.ts', 'extension.mjs', 'extension.js']
          .map((file) => join(root, directory.name, file))
          .find((path) => existsSync(path));
        if (entry)
          found.set(directory.name, {
            name: directory.name,
            source,
            path: entry,
            ...manifest(join(root, directory.name, 'extension.json')),
          });
      }
    }
    return [...found.values()];
  }
  async load(): Promise<this> {
    this.controller.signal.throwIfAborted();
    const loaded: Extension[] = [];
    const tools = new Set(this.options.reservedTools);
    const commands = new Set(this.options.reservedCommands);
    for (const discovered of this.discover()) {
      this.controller.signal.throwIfAborted();
      const setting = this.options.settings?.[discovered.name]?.enabled;
      const ext: Extension = {
        ...discovered,
        enabled:
          discovered.source === 'bundled'
            ? setting === true
            : setting !== false,
        error: '',
        warnings: [],
        tools: [],
        commands: [],
        middleware: [],
        subagents: [],
        renderers: new Map(),
        handlers: new Map(),
        mask: new SecretMask(),
      };
      loaded.push(ext);
      if (!ext.enabled) continue;
      try {
        const module: unknown = await import(
          pathToFileURL(ext.path).href + '?reload=' + randomUUID()
        );
        this.controller.signal.throwIfAborted();
        if (!isRecord(module) || typeof module.register !== 'function')
          throw new ExtensionError('extension defines no register(api)');
        const api = new ExtensionAPI(
          ext,
          tools,
          commands,
          this.options.jobs,
          this.options.jobOwner,
          {
            home: this.options.home,
            workspace: this.options.workspace,
            secret: this.options.secret,
            secretTimeoutMs: this.options.secretTimeoutMs,
            settings: this.options.settings?.[discovered.name],
            onStatus: this.options.onStatus,
            openUrl: this.options.openUrl,
            onTools: this.options.onTools,
            signal: this.controller.signal,
            track: (work) => this.track(work),
          },
        );
        await abortable(
          Promise.resolve(module.register(api)),
          this.controller.signal,
        );
        this.controller.signal.throwIfAborted();
        for (const tool of ext.tools) tools.add(tool.name);
        live.add(api);
        for (const command of ext.commands) commands.add(command.name);
      } catch (error) {
        this.controller.signal.throwIfAborted();
        ext.error =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        ext.tools = [];
        ext.commands = [];
        ext.middleware = [];
        ext.subagents = [];
        ext.renderers.clear();
        ext.handlers.clear();
      }
    }
    this.extensions = loaded;
    return this;
  }
  private loaded(): Extension[] {
    return this.extensions.filter((ext) => ext.enabled && !ext.error);
  }
  tools(): Tool[] {
    return this.loaded().flatMap((ext) => ext.tools);
  }
  /** What a loaded extension last published with api.setView. */
  view(name: string): unknown {
    return this.loaded().find((ext) => ext.name === name)?.view;
  }
  /** The status lines set by loaded extensions, in load order. */
  statuses(): ExtensionStatus[] {
    return this.loaded().flatMap((ext) =>
      ext.status ? [{ extension: ext.name, ...ext.status }] : [],
    );
  }
  commands(): Map<string, ExtensionCommand> {
    return new Map(
      this.loaded()
        .flatMap((ext) => ext.commands)
        .map((command) => [command.name, command]),
    );
  }
  subagents(available: Tool[]): { spec: SubagentSpec; tools: Tool[] }[] {
    const byName = new Map(available.map((tool) => [tool.name, tool]));
    const agents = new Map<string, { spec: SubagentSpec; tools: Tool[] }>();
    for (const ext of this.loaded())
      for (const agent of ext.subagents) {
        const missing = agent.tools.filter((name) => !byName.has(name));
        if (missing.length) {
          const warning = `subagent ${agent.spec.name} names tools that do not exist ${missing.join(', ')}; skipped`;
          if (!ext.warnings.includes(warning)) ext.warnings.push(warning);
          continue;
        }
        agents.set(agent.spec.name, {
          spec: agent.spec,
          tools: agent.tools.map((name) => byName.get(name)!),
        });
      }
    return [...agents.values()];
  }
  model(base: ChatModel): ChatModel {
    const middleware = this.loaded().flatMap((ext) => ext.middleware);
    return {
      model: base.model,
      // A session title is a second complete() beside the turn. Dropping this made every
      // terminal session keep the fallback: the wrapper was what the harness called.
      sideRequests: base.sideRequests,
      get contextWindow() {
        return base.contextWindow;
      },
      get outputBudget() {
        return base.outputBudget;
      },
      get modelFacts() {
        return base.modelFacts;
      },
      get imageInput() {
        return base.imageInput;
      },
      complete: async (request) => {
        let next = (request: ModelRequest) => base.complete(request);
        for (const item of middleware
          .filter((item) => item.slot === 'model_call')
          .reverse()) {
          const downstream = next;
          next = (request) => item.handler(request, downstream);
        }
        let response = await next(request);
        for (const item of middleware)
          if (item.slot === 'after_model')
            response = (await item.handler(response, request)) ?? response;
        return response;
      },
    };
  }
  async toolBoundary(
    request: ToolInvocation,
    run: (request: ToolInvocation) => Promise<string>,
  ): Promise<string> {
    let next = run;
    for (const item of this.loaded()
      .flatMap((ext) => ext.middleware)
      .filter((item) => item.slot === 'tool_boundary')
      .reverse()) {
      const downstream = next;
      next = (request) => item.handler(request, downstream);
    }
    return next(request);
  }
  renderer(
    name: string,
  ): ((update: Record<string, unknown>) => string[]) | undefined {
    return this.loaded()
      .map((ext) => ext.renderers.get('tool_result:' + name))
      .find((renderer) => renderer !== undefined);
  }
  emit(event: ExtensionEvent, payload: Record<string, unknown>): void {
    if (this.closing) return;
    for (const ext of this.loaded())
      for (const handler of ext.handlers.get(event) ?? []) {
        try {
          this.track(
            Promise.resolve(handler({ ...payload })).catch((error) =>
              this.warn(ext, event, error),
            ),
          );
        } catch (error) {
          this.warn(ext, event, error);
        }
      }
  }
  private track(work: Promise<unknown>): void {
    const tracked: Promise<void> = work.then(
      () => void this.pending.delete(tracked),
      () => void this.pending.delete(tracked),
    );
    this.pending.add(tracked);
  }
  /**
   * End the extensions: their api.signal fires, then nothing of them runs any more, once the
   * tool calls and commands in flight, the event handlers and the work they gave
   * api.background have ended. With a bound in milliseconds the wait stops when the time is
   * up; the signal has fired either way. Closing again waits for the same end.
   */
  async close(
    timeoutMs = Infinity,
    options: { requireSettled?: boolean } = {},
  ): Promise<void> {
    // Deletion must not release history ownership while extension work remains. A
    // strict retry drains the live pending set again, rather than reusing an earlier
    // bounded close which may have returned before cleanup finished.
    if (options.requireSettled) return this.drain(timeoutMs, true);
    this.closing ??= this.drain(timeoutMs);
    return this.closing;
  }
  private async drain(
    timeoutMs: number,
    requireSettled = false,
  ): Promise<void> {
    this.controller.abort(new ExtensionError('the extension was closed'));
    const timer = new AbortController();
    const expired: Promise<'expired'> = Number.isFinite(timeoutMs)
      ? delay(timeoutMs, 'expired' as const, { signal: timer.signal }).catch(
          () => 'expired' as const,
        )
      : new Promise<never>(() => {});
    try {
      // Work that ends may start more: wait until nothing is left, or the time is up.
      while (this.pending.size) {
        const outcome = await Promise.race([
          Promise.allSettled([...this.pending]).then(() => 'settled' as const),
          expired,
        ]);
        if (outcome === 'expired') {
          if (requireSettled && this.pending.size)
            throw new ExtensionError(
              'extension cleanup is still running; retry after it finishes',
            );
          return;
        }
      }
    } finally {
      timer.abort();
    }
  }
  private warn(ext: Extension, event: string, error: unknown): void {
    const note = `${event} handler failed: ${error instanceof Error ? error.message : String(error)}`;
    if (!ext.warnings.includes(note)) ext.warnings.push(note);
  }
  describe(): string {
    if (!this.extensions.length)
      return 'No extensions. Put an extension.ts or extension.js in each extension folder.';
    return this.extensions
      .map(
        (ext) =>
          `${ext.name}${ext.version ? ' ' + ext.version : ''} (${ext.source}) · ${!ext.enabled ? (ext.source === 'bundled' ? `off · /extensions enable ${ext.name}` : 'off') : ext.error ? 'failed to load: ' + ext.error : `${ext.tools.length} tools · ${ext.commands.length} commands`}${ext.description ? '\n  ' + ext.description : ''}${ext.warnings.length ? '\n  ' + ext.warnings.join('\n  ') : ''}`,
      )
      .join('\n');
  }
}
// extension.json is optional: { "version": "1.2.0", "description": "..." }, shown in /extensions.
function manifest(path: string): { version: string; description: string } {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isRecord(value))
      return {
        version:
          typeof value.version === 'string' ? value.version.slice(0, 40) : '',
        description:
          typeof value.description === 'string'
            ? value.description.slice(0, 200)
            : '',
      };
  } catch {
    /* No manifest, or one that cannot be read: the extension still loads. */
  }
  return { version: '', description: '' };
}
