import { createHash, randomUUID } from 'node:crypto';
import type { GitHubConnectionBackend } from './github_connection.js';
import { join, dirname } from 'node:path';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import type { ChatModel, Message, ToolCall } from './types.js';
import { GatewayModel, EFFORT_LEVELS, defaultEffort } from './model.js';
import { WebSearchService } from './websearch_service.js';
import type { NativeSearchConnection } from './native_websearch.js';
import { CheckpointStore, type Session } from './checkpoint_store.js';
import {
  occupiedSessionMessage,
  SessionOccupiedError,
} from './session_lock.js';
import {
  defaultPolicy,
  DEFAULT_CREDENTIAL_FILES,
  type SessionMode,
} from './approvals.js';
import { Sandbox } from './sandbox.js';
import { buildTools, type Todo } from './tools.js';
import { browserToolsWanted } from './browser/tools.js';
import {
  loadSecrets,
  MAX_SECRET,
  secretNames,
  secretRedactor,
  written,
  type Redactor,
} from './secrets.js';
import {
  buildSystemPrompt,
  planModePrompt,
  type ContextInstruction,
} from './system_prompt.js';
import {
  PLAN_CHOICE_NOTES,
  PLAN_CHOICES,
  planAnswer,
  planFile,
  planSession,
  shownPath,
  type PlanChoice,
} from './plan_file.js';
import {
  Harness,
  type ApprovalDecision,
  type HarnessOptions,
} from './harness.js';
import { EventBus } from './events.js';
import { defaultRunOptions, type RunOptions } from './run_options.js';
import type { CircleSettings } from './settings.js';
import { discoverSkills, loadSkillBody, type SkillInfo } from './skills.js';
import { fromJsonl, toSessionBundle } from './session_export.js';
import { projectDataDir, circleHome, normalizeWorkspace } from './paths.js';
import { McpManager } from './mcp_loader.js';
import { ExtensionHost, type SubagentSpec } from './extensions.js';
import { discoverSubagents, type SubagentFileInfo } from './subagent_files.js';
import { abortable } from './watch.js';
import {
  isFolderTrusted,
  isReady,
  loadSettings,
  loadCredentials,
  withConnectionLock,
  saveSettingsChange,
  settingsForRun,
  VARIABLE_NAME,
} from './settings.js';
import { BUILTIN_SLASH } from './tui/slash_commands.js';
import { discoverCustomCommands } from './commands.js';
import { LspManager } from './lsp_tool.js';
import type { Tool, ToolContext } from './types.js';
import { FileMutationTools, type FileMutations } from './file_mutations.js';
import { readFileBytes } from './file_access.js';
import {
  ContextManager,
  restoredTodos,
  restoredPlanMode,
} from './context_middleware.js';
import { askQuestions } from './questions.js';
import type { SecretRequest } from './secret_prompt.js';
import type { CommandLauncher, CommandExecution } from './command_process.js';
import { JobRegistry, jobLine, type Job } from './jobs.js';
import { ModelCatalog } from './model_catalog.js';
import {
  priceCall,
  messageCosts,
  UsageCostTotals,
  type CostSummary,
} from './pricing.js';
import { addUsage, emptyUsage } from './types.js';
import {
  VisionService,
  visionConnection,
  type VisionConnection,
} from './vision.js';
import { saveMediaAttachment } from './media.js';
import { UserShells } from './user_shell.js';
import { toolCallLine } from './headless.js';
import { canScreenshot, type ScreenshotOptions } from './screenshot.js';
import { titleNeedsRefresh, userPrompts } from './session_title.js';
import {
  HookRunner,
  approveHookFile,
  approvedHookDigest,
  loadHooks,
  type HookChange,
  type HookDefinition,
} from './hooks.js';
const BUILTIN_TOOL_NAMES = new Set([
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute',
  'write_todos',
  'task',
  'compact_conversation',
  'webfetch',
  'question',
  'skill',
  'websearch',
  'lsp',
  'apply_patch',
  'plan_enter',
  'plan_exit',
  'list_jobs',
  'stop_job',
  'wait_jobs',
]);
const EXPLORE_TOOLS = new Set([
  'ls',
  'read_file',
  'glob',
  'grep',
  'webfetch',
  'websearch',
  'lsp',
  'skill',
  'list_jobs',
  'stop_job',
  'wait_jobs',
]);
export interface InteractionContext {
  jobId?: string;
  name?: string;
  // The subagent's session, so a card can say which of several running agents asks.
  agent?: string;
}
export interface RuntimeOptions {
  /** Optional host process transport; the CLI keeps its existing pipe launcher. */
  commandLauncher?: CommandLauncher;
  /** Safe process identity projection; never receives expanded command or env. */
  onCommandExecution?: (execution: CommandExecution) => void;
  githubConnection?: GitHubConnectionBackend;
  /** Native workspace compare-and-save backend; omitted by the CLI. */
  fileMutations?: FileMutations;
  workspace: string;
  home: string;
  // Embedders can isolate global context without changing the process HOME.
  userHome?: string;
  localContext?: boolean;
  settings: CircleSettings;
  run?: RunOptions;
  session?: string;
  sessionId?: string;
  continue?: boolean;
  fork?: string;
  // `--model`: used for this run, kept over a reload, never saved.
  modelOverride?: string;
  model?: ChatModel;
  /** Wrap every parent/child completion without replacing the provider used for connection ownership. */
  wrapModel?: (model: ChatModel) => ChatModel;
  /** Trusted desktop resource scheduling. The CLI keeps direct tool execution. */
  executeTool?: HarnessOptions['executeTool'];
  /** Called only for host-built coordination tools, before extension/extra tools are added. */
  classifyTool?: (tool: Tool, kind: 'control') => Tool;
  catalog?: ModelCatalog;
  extraTools?: Tool[];
  /**
   * Tools left out of a short turn and added on the turn that needs them.
   * The terminal keeps browser tool schemas here until a page is requested.
   */
  deferredTools?: Tool[];
  /** Where the extensions that ship with Circle are; false for none (tests). */
  bundledExtensions?: string | false;
  /** An extension's status line changed. */
  onExtensionStatus?: () => void;
  /** The shared database is locked and startup is about to wait. */
  onStoreBusy?: () => void;
  /** Opens a link an extension asked for (api.openUrl); the URL is already checked. */
  openUrl?: (url: string) => Promise<void>;
  /** External session resources must be gone before history and ownership are removed. */
  beforeDelete?: () => Promise<void>;
  /** How `screenshot` takes the screen: tests give their own runner; false leaves it out.
   * By default it is offered where there is a desktop on this machine. */
  screenshot?: Omit<ScreenshotOptions, 'app' | 'target'> | false;
  headless?: boolean;
  /** Load MCP servers and extensions even when headless (`--extensions`). */
  integrations?: boolean;
  approve?: (
    call: ToolCall,
    signal: AbortSignal,
    origin?: InteractionContext,
  ) => Promise<ApprovalDecision>;
  question?: (
    args: Record<string, unknown>,
    signal: AbortSignal,
    origin?: InteractionContext,
  ) => Promise<string>;
  secret?: (
    request: SecretRequest,
    signal: AbortSignal,
    origin?: InteractionContext,
  ) => Promise<void>;
  /**
   * Ask the person whether a project hooks file that was never approved, or changed
   * since, may run: true approves exactly the bytes in `change`. Asked once per file
   * version when a turn starts, and again after a reload or in a new session. Without
   * it (print, line and rpc mode) such a file does not run and the turn says so.
   */
  approveHooks?: (change: HookChange, signal: AbortSignal) => Promise<boolean>;
  /**
   * The terminal's `circle -c`: a session another terminal holds opens view only
   * instead of failing. Nothing else gets this; the desktop starts a session of its own.
   */
  viewOccupied?: boolean;
  /**
   * Keep a new session out of the database until its first message. The terminal uses this
   * so startup and /new do not leave an empty row.
   */
  deferSession?: boolean;
  /**
   * Leave a sentence untitled until its generated title arrives. A stale stored
   * title is still asked again when the session opens. The desktop shows a new
   * sentence as a new session until that summary arrives.
   */
  holdTitle?: boolean;
  /**
   * Open stored history without taking the lease. Another terminal is running
   * the session: this one can read it and cannot continue, change or delete it.
   */
  inspect?: boolean;
  /**
   * Keep messages still queued when the runtime closes, for the host to offer
   * back later (the desktop). The terminal drops them, as a stopped turn does.
   */
  preserveQueuedInputs?: boolean;
}
export class AgentRuntime {
  private readonly searches = new WebSearchService();
  private readonly vision = new VisionService();
  private readonly searchConnections = new WeakMap<
    ChatModel,
    NativeSearchConnection
  >();
  // Extensions wrap the model first, then the host's wrapper; the harness passes
  // that outermost model to web search, so its connection is recorded there.
  private modelWithSearch(base: ChatModel): ChatModel {
    const wrapped = this.wrapModel(this.extensions.model(base));
    const connection =
      base instanceof GatewayModel
        ? base.webSearchConnection()
        : this.searchConnections.get(base);
    if (connection) this.searchConnections.set(wrapped, connection);
    return wrapped;
  }
  private async searchFromModel(
    model: ChatModel,
    query: string,
    numResults: number,
    context: ToolContext,
  ): Promise<string> {
    this.requireCurrentConnection();
    return this.searches.search(
      this.searchConnections.get(model),
      query,
      numResults,
      context.signal,
      (record) =>
        context.recordModelCall?.({
          model: record.model,
          usage: record.usage,
          cost: {
            ...priceCall(
              this.catalog.facts(record.model, this.options.settings),
              record.usage,
            ),
            tool_fee_unknown: true,
          },
          ...(record.searchRequests !== undefined
            ? { search_requests: record.searchRequests }
            : {}),
        }),
    );
  }
  /** The side vision model this run describes pictures with, when one is configured. */
  private visionForRun(): VisionConnection | undefined {
    return visionConnection(
      this.options.settings,
      loadCredentials(this.options.home),
    );
  }
  /** Where a picture the model cannot read is written, once, named by its bytes. */
  private offloadImages(): string {
    return (
      this.sandbox.offloadRoot ??
      projectDataDir(this.options.workspace, this.options.home)
    );
  }
  private describeImages(
    connection: VisionConnection,
    paths: string[],
    question: string,
    context: ToolContext,
  ): Promise<{ model: string; text: string }> {
    return this.vision.describe(
      connection,
      paths,
      question,
      context.signal,
      (call) =>
        context.recordModelCall?.({
          model: call.model,
          usage: {
            ...emptyUsage(),
            input_tokens: call.usage.input_tokens,
            output_tokens: call.usage.output_tokens,
          },
          cost: {
            ...priceCall(
              this.catalog.facts(call.model, this.options.settings),
              {
                ...emptyUsage(),
                input_tokens: call.usage.input_tokens,
                output_tokens: call.usage.output_tokens,
              },
            ),
            tool_fee_unknown: true,
          },
        }),
    );
  }
  readonly options: RuntimeOptions;
  readonly store: CheckpointStore;
  readonly bus = new EventBus();
  readonly sandbox: Sandbox;
  readonly jobs: JobRegistry;
  /** Hides secrets' values in what the model reads, from calls and background jobs. */
  readonly redact: Redactor;
  readonly catalog: ModelCatalog;
  private childJobOwners = new Map<string, import('./jobs.js').JobOwner>();
  private closing = false;
  private ownershipError?: Error;
  private ownershipCleanup?: Promise<void>;
  private deleting = false;
  /** Left the screen. The lock drops once a background turn, job or queue finishes. */
  private away = false;
  get isDeleting(): boolean {
    return this.deleting;
  }
  /** close() has begun: the session store may already be closed. */
  get isClosing(): boolean {
    return this.closing;
  }
  private closingPromise?: Promise<void>;
  readonly policy;
  readonly runOptions: RunOptions;
  private promptInstructions: ContextInstruction[] = [];
  /** Project rules actually included in the current system prompt, not a disk scan. */
  get loadedInstructions(): ContextInstruction[] {
    return this.promptInstructions.map((file) => ({ ...file }));
  }
  // Read again with every system prompt, see systemPrompt().
  skills: SkillInfo[] = [];
  private hookRunner?: HookRunner;
  /** The hooks this session would run. Reloaded with the harness. */
  get hookCatalog() {
    return this.ensureHooks().loaded;
  }
  /** Configured hooks and whether this session will run them. */
  hookListing(): { hook: HookDefinition; active: boolean }[] {
    return this.ensureHooks().listing();
  }
  readonly mcp: McpManager;
  readonly lsp: LspManager;
  readonly context: ContextManager;
  private compactionController?: AbortController;
  private activeCompaction?: Promise<string>;
  extensions: ExtensionHost;
  private integrationsReady?: Promise<void>;
  /** The subagents the agent folders define, read again with every system prompt. */
  private fileAgents: SubagentFileInfo[] = [];
  private fileAgentProblems: string[] = [];
  private extensionChanges = new Map<string, Promise<void>>();
  private extensionChangeListeners = new Set<() => void>();
  private readonly integrationLifetime = new AbortController();
  private baseModel?: ChatModel;
  private readonly modelWrappers = new WeakMap<ChatModel, ChatModel>();
  private readonly wrappedModels = new WeakSet<ChatModel>();
  private authFingerprint?: string;
  private coreTools: Tool[] = [];
  // An extension changed its tools after loading; applied between turns, never inside one.
  private toolsStale = false;
  private toolsCheck?: ReturnType<typeof setTimeout>;
  get allTools(): Tool[] {
    return this.withIntegrationTools(this.coreTools, false);
  }
  todos: Todo[] = [];
  readonly userShells: UserShells;
  session: Session;
  harness: Harness;
  constructor(options: RuntimeOptions) {
    this.options = {
      ...options,
      workspace: normalizeWorkspace(options.workspace),
      home: circleHome(options.home),
    };
    options = this.options;
    this.runOptions = options.run ?? defaultRunOptions();
    this.catalog = options.catalog ?? new ModelCatalog(options.home);
    this.store = new CheckpointStore(
      this.runOptions.no_session ? undefined : options.home,
      options.onStoreBusy ? { onBusy: options.onStoreBusy } : undefined,
    );
    try {
      let session: Session | undefined;
      if (options.session) {
        session = this.store.find(options.session);
        if (!session) throw new Error('unknown session');
        if (session.workspace !== options.workspace) {
          if (options.inspect)
            throw new Error('session belongs to a different workspace');
          session = this.store.fork(session.id, options.workspace);
        }
      } else if (options.continue) {
        session = this.store.list(options.workspace)[0];
        if (!session) throw new Error('no saved session in this folder');
      } else if (options.fork) {
        const parent = this.store.find(options.fork);
        if (!parent) throw new Error('unknown session to fork');
        session = this.store.fork(parent.id, options.workspace);
      }
      this.session =
        session ??
        this.store.create(
          options.workspace,
          options.settings.auth.model,
          this.runOptions.session_name,
          options.sessionId,
          null,
          Boolean(options.deferSession) &&
            !this.runOptions.session_name &&
            !options.sessionId,
        );
      if (!options.inspect) {
        try {
          this.store.claimSession(this.session.id, (error) =>
            this.ownershipLost(error),
          );
        } catch (error) {
          // Only the terminal's `circle -c` watches a held session. Everyone else
          // (print mode, the desktop) is told it is taken.
          if (
            !options.viewOccupied ||
            options.headless ||
            !(error instanceof SessionOccupiedError)
          )
            throw error;
          this.options.inspect = true;
        }
      }
      // A delete may have completed between discovery and acquiring the lease.
      const current = this.store.get(this.session.id);
      if (!current) throw new Error('unknown session');
      this.session = current;
      // A view-only open does not rename another terminal's session.
      if (!this.options.inspect) {
        this.store.repairStaleTitles();
        const repaired = this.store.get(this.session.id);
        if (repaired) this.session = repaired;
      }
    } catch (error) {
      this.store.close();
      throw error;
    }
    this.sandbox = new Sandbox(
      options.workspace,
      projectDataDir(options.workspace, options.home),
      [
        ...new Set([
          ...DEFAULT_CREDENTIAL_FILES,
          ...options.settings.credential_files,
        ]),
      ],
    );
    this.policy = defaultPolicy(
      options.workspace,
      options.home,
      this.sandbox.credentialFiles,
      (path) => this.sandbox.resolvePath(path),
      options.settings.allowed_commands,
    );
    this.jobs = new JobRegistry(
      this.sandbox,
      (kind, job) => {
        if (kind === 'job_ended') this.userShells?.ended(job);
        this.bus.emit(kind, {
          payload: { job },
          tags: { session_id: job.sessionId },
        });
        if (kind === 'job_ended') this.releaseIfAway();
      },
      16,
      JobRegistry.outputLimit(),
      {
        commandLauncher: options.commandLauncher,
        onExecution: (execution) => {
          this.userShells?.executionChanged(execution);
          options.onCommandExecution?.(execution);
        },
      },
    );
    // A background command can print a secret: its notice reaches the model and history.
    // Calls and notices share what values each secret had.
    this.redact = secretRedactor(
      () => loadSecrets(this.options.home),
      () => this.options.settings.variables ?? {},
    );
    this.jobs.redact = (text, sessionId) =>
      this.redact(text, {}, () => written(this.store.messages(sessionId)));
    this.userShells = new UserShells(this.jobs, this.store, {
      sessionId: () => this.session.id,
      busy: () =>
        Boolean(this.ownershipError) ||
        this.closing ||
        this.deleting ||
        this.busy,
      modelBusy: () => this.harness.busy,
      planMode: () => this.harness.planMode,
      changed: () => {
        this.bus.emit('info', { payload: { user_shell: true } });
        this.releaseIfAway();
      },
    });
    // A file an MCP tool is given is read as read_file reads: with the desktop's backend, a
    // file outside the workspace only with the person's grant
    const fileReads = options.fileMutations
      ? new FileMutationTools(this.sandbox, options.fileMutations)
      : undefined;
    this.mcp = new McpManager(options.workspace, undefined, undefined, {
      secrets: () => loadSecrets(this.options.home),
      sessionId: () => this.session.id,
      readFile: (path, context, limit) =>
        readFileBytes(this.sandbox, fileReads, path, context, limit),
      // A server that went away leaves the system prompt between turns, as tools do
      onChange: () => {
        if (this.closing) return;
        this.toolsStale = true;
        this.scheduleToolRefresh();
      },
    });
    this.policy.declareHints((tool) => this.mcp.hint(tool));
    this.lsp = new LspManager(this.sandbox);
    this.context = new ContextManager(this.store, this.sandbox.offloadRoot!, {
      progress: (event) =>
        this.bus.emit('compaction', { payload: { ...event } }),
      runningJobs: (sessionId) =>
        this.jobs
          .list(sessionId)
          .filter(
            (job) => job.status === 'running' && job.startedBy !== 'user',
          ),
      priceUsage: (model, usage) =>
        priceCall(this.catalog.facts(model, this.options.settings), usage),
      notice: (event) =>
        this.bus.emit('info', { payload: { model_notice: event } }),
    });
    this.extensions = this.extensionHost(new Set());
    if (this.runOptions.session_name)
      this.store.rename(this.session.id, this.runOptions.session_name, true);
    try {
      this.harness = this.createHarness(options.model);
      this.todos = restoredTodos(this.harness.messages);
      this.applyDefaultMode();
    } catch (error) {
      // Integrations have not loaded and jobs cannot have started in the constructor.
      void this.jobs.close();
      void this.catalog.close();
      this.store.close();
      throw error;
    }
    this.refreshFallbackTitle();
    this.bus.setRunId(this.session.id);
    if (!options.model)
      void this.catalog.refreshIfStale(() =>
        this.bus.emit('info', { payload: { model_catalog_refreshed: true } }),
      );
    this.bus.subscribe((event) => {
      if (event.kind === 'run_start')
        this.extensions.emit('turn_start', {
          ...event.payload,
          session_id: event.run_id,
        });
      else if (event.kind === 'run_end') {
        this.extensions.emit('turn_end', {
          ...event.payload,
          session_id: event.run_id,
          usage: event.usage,
        });
        if (this.toolsStale) this.scheduleToolRefresh();
      } else if (event.kind === 'tool_result')
        this.extensions.emit('tool_result', {
          ...event.payload,
          session_id: event.run_id,
        });
    });
  }
  private wrapModel(model: ChatModel): ChatModel {
    if (!this.options.wrapModel || this.wrappedModels.has(model)) return model;
    const previous = this.modelWrappers.get(model);
    if (previous) return previous;
    const wrapped = this.options.wrapModel(model);
    if (!wrapped || typeof wrapped.complete !== 'function')
      throw new Error('model wrapper must return a ChatModel');
    this.modelWrappers.set(model, wrapped);
    this.wrappedModels.add(wrapped);
    return wrapped;
  }
  private createHarness(modelOverride?: ChatModel): Harness {
    const model =
      modelOverride ??
      this.baseModel ??
      this.gatewayModel(this.options.settings);
    if (model instanceof GatewayModel && !this.authFingerprint)
      this.authFingerprint = this.savedConnectionFingerprint();
    this.baseModel = model;
    const system = this.systemPrompt(model.model);
    const vision = this.visionForRun();
    let tools = buildTools(this.sandbox, {
      fileMutations: this.options.fileMutations,
      jobs: this.jobs,
      ...(vision
        ? {
            vision: (paths: string[], question: string, context: ToolContext) =>
              this.describeImages(vision, paths, question, context),
          }
        : {}),
      displayCommand: (raw, context) =>
        this.redact(raw, {}, () =>
          written(this.store.messages(context.sessionId)),
        ),
      screenshot:
        this.options.screenshot === false
          ? undefined
          : (this.options.screenshot ?? (canScreenshot() ? {} : undefined)),
      todos: (todos) => {
        this.todos = todos;
        this.bus.emit('todo_list', { payload: { todos } });
      },
      skill: async (name, signal) => {
        await this.activateSkillHooks(name, signal);
        return loadSkillBody(name, this.skills);
      },
      question: async (args, context) =>
        askQuestions(this.options.home, this.sandbox, args, context.signal, {
          ask: this.options.question,
          secret: this.options.secret,
          keep: (name, value) => this.keepVariable(name, value),
        }),
      plan: async (enabled, context) => {
        const { file, path } = this.planFile;
        if (enabled) {
          this.setPlanMode(true);
          return `Plan mode is on: research, write the plan to ${file}, then call plan_exit.`;
        }
        if (!this.options.question)
          throw new Error('plan_exit requires an interactive answer');
        const reply = await this.options.question(
          {
            questions: [
              {
                question: `The plan is ready: ${shownPath(path)}\nHow should Circle go on?`,
                header: 'plan',
                options: (Object.keys(PLAN_CHOICES) as PlanChoice[]).map(
                  (choice) => ({
                    label: PLAN_CHOICES[choice],
                    description: PLAN_CHOICE_NOTES[choice],
                  }),
                ),
                multiple: false,
                // Written words say what to change
                custom: true,
              },
            ],
            // The desktop shows its plan card for this question, beside the plan
            plan: { file },
          },
          context.signal,
        );
        context.signal.throwIfAborted();
        const { choice, words } = planAnswer(reply);
        if (choice === 'auto' || choice === 'manual') {
          this.setMode(choice);
          return (
            (choice === 'auto'
              ? 'Plan mode is off and auto mode is on: changes run without asking.'
              : 'Plan mode is off: each change asks the user first.') +
            ` Implement the plan in ${file} now.` +
            (words ? ` The user added: ${words}` : '')
          );
        }
        if (choice === 'change')
          return words
            ? `The user wants the plan changed before it is implemented. They said: ${words}\nRevise ${file}, then call plan_exit again.`
            : `The user wants the plan changed but did not say how. Ask what to change with question, revise ${file}, then call plan_exit again.`;
        if (choice === 'keep')
          return `The user is keeping the plan in ${file} and does not want it implemented now. Plan mode stays on. Change nothing, and end your turn with one short line.`;
        return 'The user closed the question without choosing. Plan mode stays on; end your turn.';
      },
      compact: async (hint, context) => this.compact(hint, context.signal),
      task: async (args, context) => {
        context.signal.throwIfAborted();
        if (this.ownershipError) throw this.ownershipError;
        if (this.closing || this.deleting)
          throw new Error('session is closing');
        const parentHarness = this.harness;
        const parentSessionId = context.sessionId;
        const name = String(args.subagent_type || 'general-purpose');
        const custom = this.customSubagents().find(
          (agent) => agent.spec.name === name,
        );
        if (!custom && !['general-purpose', 'explore'].includes(name))
          throw new Error('unknown subagent type');
        const childModel = custom?.spec.model
          ? this.modelWithSearch(
              this.gatewayModel(this.options.settings, custom.spec.model),
            )
          : this.wrapModel(parentHarness.model);
        const session = this.store.create(
          this.options.workspace,
          childModel.model,
          `${name}: ${String(args.description || '')}`.slice(0, 160),
          undefined,
          parentSessionId,
        );
        const parentState = this.store.contextState(parentSessionId);
        this.childJobOwners.set(session.id, {
          sessionId: parentSessionId,
          parent: session.id,
          startedBy: 'model',
        });
        this.store.setContextState(parentSessionId, {
          ...parentState,
          subagentSessionIds: [
            ...new Set([...(parentState.subagentSessionIds ?? []), session.id]),
          ],
        });
        const childBus = new EventBus(session.id);
        let backgroundJob: Job | undefined;
        let backgroundLog: ((text: string) => void) | undefined;
        const interact = async <T>(
          action: (origin: InteractionContext) => Promise<T>,
        ): Promise<T> => {
          // what the job said it was doing comes back once the answer is in
          const before = backgroundJob?.detail;
          if (backgroundJob)
            this.jobs.activity(backgroundJob.id, 'waiting for you');
          try {
            return await action({
              jobId: backgroundJob?.id,
              name,
              agent: session.id,
            });
          } finally {
            if (backgroundJob)
              this.jobs.activity(
                backgroundJob.id,
                before && before !== 'waiting for you' ? before : 'working',
              );
          }
        };
        childBus.subscribe((event) => {
          if (event.kind === 'tool_call') {
            // The log keeps the whole call for the model to read; the strip shows the
            // step as a tool row does, `Write(notes/a.md)`, not its raw JSON.
            backgroundLog?.(
              `${event.payload.name}(${JSON.stringify(event.payload.args)})`,
            );
            if (backgroundJob)
              this.jobs.activity(
                backgroundJob.id,
                toolCallLine(String(event.payload.name), event.payload.args),
              );
          }
          if (event.kind === 'llm_end')
            backgroundLog?.(
              String((event.payload.message as Message)?.content || ''),
            );
          this.bus.emit(event.kind, {
            payload: event.payload,
            usage: event.usage,
            tags: {
              subagent: session.id,
              name,
              ...(backgroundJob ? { job_id: backgroundJob.id } : {}),
            },
            parent_run_id: parentSessionId,
          });
        });
        const childTools = (custom?.tools ?? this.allTools).filter(
          (tool) =>
            tool.subagents !== false &&
            tool.name !== 'task' &&
            tool.name !== 'compact_conversation' &&
            tool.name !== 'plan_enter' &&
            tool.name !== 'plan_exit' &&
            (name !== 'explore' ||
              custom !== undefined ||
              EXPLORE_TOOLS.has(tool.name)),
        );
        const jobTools = buildTools(this.sandbox, {
          fileMutations: this.options.fileMutations,
          jobs: this.jobs,
          ...(vision
            ? {
                vision: (
                  paths: string[],
                  question: string,
                  context: ToolContext,
                ) => this.describeImages(vision, paths, question, context),
              }
            : {}),
          displayCommand: (raw, context) =>
            this.redact(raw, {}, () =>
              written(this.store.messages(context.sessionId)),
            ),
          jobOwner: () => ({
            sessionId: parentSessionId,
            parent: backgroundJob?.id ?? session.id,
            startedBy: 'model',
          }),
          question: (args, context) =>
            askQuestions(
              this.options.home,
              this.sandbox,
              args,
              context.signal,
              {
                ask: this.options.question
                  ? (args, signal) =>
                      interact((origin) =>
                        this.options.question!(args, signal, origin),
                      )
                  : undefined,
                secret: this.options.secret
                  ? (request, signal) =>
                      interact((origin) =>
                        this.options.secret!(request, signal, origin),
                      )
                  : undefined,
                keep: (name, value) => this.keepVariable(name, value),
              },
            ),
        });
        const ownedChildTools = this.classifyCoreTools(
          childTools.map((tool) =>
            tool.name === 'write_todos'
              ? {
                  ...tool,
                  run: async (args: Record<string, unknown>) => {
                    childBus.emit('todo_list', {
                      payload: { todos: args.todos },
                    });
                    return 'Updated todo list.';
                  },
                }
              : [
                    'execute',
                    'list_jobs',
                    'stop_job',
                    'wait_jobs',
                    'question',
                  ].includes(tool.name)
                ? jobTools.find((jobTool) => jobTool.name === tool.name)!
                : tool,
          ),
        );
        const child: Harness = new Harness({
          commandExecution: {
            epoch: this.jobs.runName,
            forCall: (sessionId, callId) =>
              this.jobs.executionFor(sessionId, callId),
          },
          variables: () => this.options.settings.variables,
          secrets: () => loadSecrets(this.options.home),
          redact: this.redact,
          model: childModel,
          tools: ownedChildTools,
          store: this.store,
          session,
          policy: this.policy,
          system:
            (custom?.spec.system_prompt ??
              readFileSync(
                join(
                  import.meta.dirname,
                  'prompts/agent',
                  name === 'explore' ? 'explore.md' : 'generate.md',
                ),
                'utf8',
              )) +
            '\n' +
            parentHarness.system,
          bus: childBus,
          approve: this.options.approve
            ? (call, signal) =>
                interact((origin) =>
                  this.options.approve!(call, signal, origin),
                )
            : undefined,
          hooks: this.ensureHooks(),
          sessionHooks: false,
          headless: this.options.headless,
          approvalSessionId: parentSessionId,
          priceUsage: (model, usage) =>
            priceCall(this.catalog.facts(model, this.options.settings), usage),
          parentPlanMode: () => this.harness.planMode,
          toolBoundary: (tool, args, context) =>
            this.extensionToolBoundary(tool, args, context),
          executeTool: this.options.executeTool,
          ...(vision
            ? {
                vision: (
                  paths: string[],
                  question: string,
                  context: ToolContext,
                ) => this.describeImages(vision, paths, question, context),
              }
            : {}),
          saveImageAttachment: (item) =>
            saveMediaAttachment(this.offloadImages(), item),
          webSearch: (model, query, count, context) =>
            this.searchFromModel(model, query, count, context),
          prepareMessages: (signal): Promise<Message[]> =>
            this.context.prepare(
              session.id,
              child.model,
              child.system,
              child.tools,
              signal,
              true,
            ),
        });
        child.planMode = name === 'explore';
        const runChild = async (signal: AbortSignal): Promise<string> => {
          const abort = (): void => {
            void child.cancel();
          };
          signal.addEventListener('abort', abort, { once: true });
          try {
            signal.throwIfAborted();
            return (await child.run(String(args.description || ''))).answer;
          } finally {
            signal.removeEventListener('abort', abort);
            await this.jobs.stopOwned(backgroundJob?.id ?? session.id);
            this.childJobOwners.delete(session.id);
          }
        };
        if (args.background === true) {
          context.signal.throwIfAborted();
          const job = this.jobs.startAgent(
            `${name}: ${String(args.description || '')}`,
            { sessionId: parentSessionId, startedBy: 'model' },
            async (signal, log, job) => {
              backgroundJob = job;
              this.childJobOwners.set(session.id, {
                sessionId: parentSessionId,
                parent: job.id,
                startedBy: 'model',
              });
              backgroundLog = log;
              return runChild(signal);
            },
            session.id,
          );
          return `In background: ${jobLine(job)}. The subagent report will arrive as a notice; do not poll or sleep.`;
        }
        return runChild(context.signal);
      },
    });
    tools.push(this.lsp.tool());
    tools = this.classifyCoreTools(tools);
    tools.push(...(this.options.extraTools ?? []));
    this.coreTools = tools;
    tools = this.withIntegrationTools(
      tools.filter((tool) => tool.name !== 'wait_jobs'),
    );
    // A new or resumed session after the integrations loaded keeps their subagents.
    if (this.integrationsReady) this.describeSubagents(tools);
    const harness = new Harness({
      commandExecution: {
        epoch: this.jobs.runName,
        forCall: (sessionId, callId) =>
          this.jobs.executionFor(sessionId, callId),
      },
      variables: () => this.options.settings.variables,
      secrets: () => loadSecrets(this.options.home),
      redact: this.redact,
      model: this.modelWithSearch(model),
      holdTitle: this.options.holdTitle,
      inspect: this.options.inspect,
      tools,
      store: this.store,
      session: this.session,
      policy: this.policy,
      system,
      bus: this.bus,
      headless: this.options.headless,
      approve: this.options.approve,
      hooks: this.ensureHooks(),
      reviewHooks: (signal) => this.reviewHooks(signal),
      priceUsage: (model, usage) =>
        priceCall(this.catalog.facts(model, this.options.settings), usage),
      beforeRun: async (signal) => {
        if (this.ownershipError) throw this.ownershipError;
        this.requireTurnConnection();
        if (this.closing || this.deleting)
          throw new Error('session is closing');
        if (this.userShells.busy) throw new Error('a user command is running');
        if (this.activeCompaction) throw new Error('a compaction is running');
        await this.initialize(signal);
        await this.waitForExtensionChanges(signal);
        this.refreshIntegrationTools();
      },
      beforeTurn: (prompt) => {
        this.requireTurnConnection();
        this.promoteDeferredTools(prompt);
      },
      beforeStep: () => {
        this.userShells.flush();
        const messages = this.jobs.takeNotices(this.harness.sessionId);
        if (messages.length)
          this.store.append(this.harness.sessionId, messages);
      },
      toolBoundary: (tool, args, context) =>
        this.extensionToolBoundary(tool, args, context),
      executeTool: this.options.executeTool,
      ...(vision
        ? {
            vision: (paths: string[], question: string, context: ToolContext) =>
              this.describeImages(vision, paths, question, context),
          }
        : {}),
      saveImageAttachment: (item) =>
        saveMediaAttachment(this.offloadImages(), item),
      webSearch: (model, query, count, context) =>
        this.searchFromModel(model, query, count, context),
      prepareMessages: (signal) =>
        this.context.prepare(
          this.session.id,
          this.harness.model,
          this.harness.system,
          this.harness.tools,
          signal,
        ),
      settled: () => this.releaseIfAway(),
      planFileMutation: (call) => {
        let paths: string[];
        if (call.name === 'write_file' || call.name === 'edit_file')
          paths = [String(call.args.file_path || call.args.path || '')];
        else if (call.name === 'apply_patch') {
          const patch = String(call.args.patchText || '');
          if (/^\*\*\* (?:Delete File|Move to):/m.test(patch)) return false;
          paths = [
            ...patch.matchAll(/^\*\*\* (?:Add File|Update File):\s*(.+)$/gm),
          ].map((match) => match[1]!);
        } else return false;
        try {
          const own = this.planFile.path;
          return (
            paths.length > 0 &&
            paths.every(
              (path) =>
                path.trim() !== '' && this.sandbox.resolvePath(path) === own,
            )
          );
        } catch {
          return false;
        }
      },
      planPrompt: () => planModePrompt(this.planFile.file),
    });
    harness.planMode = restoredPlanMode(harness.messages);
    this.adoptPlan(harness.messages);
    return harness;
  }
  private classifyCoreTools(tools: Tool[]): Tool[] {
    const control = new Set([
      'task',
      'list_jobs',
      'stop_job',
      'wait_jobs',
      'question',
      'plan_enter',
      'plan_exit',
      'compact_conversation',
    ]);
    return tools.map((tool) =>
      control.has(tool.name) && this.options.classifyTool
        ? this.options.classifyTool(tool, 'control')
        : tool,
    );
  }
  private extensionHost(reservedTools: Set<string>): ExtensionHost {
    const commands =
      this.options.localContext === false
        ? []
        : discoverCustomCommands(
            this.options.workspace,
            this.options.home,
            this.options.userHome,
          );
    return new ExtensionHost({
      jobs: this.jobs,
      jobOwner: (context) =>
        this.childJobOwners.get(context.sessionId) ?? {
          sessionId: context.sessionId,
          startedBy: 'model',
        },
      home: this.options.home,
      workspace: this.options.workspace,
      trusted: isFolderTrusted(this.options.settings, this.options.workspace),
      secret: this.options.secret
        ? (request, signal) => this.options.secret!(request, signal)
        : undefined,
      bundledRoot: this.options.bundledExtensions,
      githubConnection: this.options.githubConnection,
      onStatus: () => this.options.onExtensionStatus?.(),
      onTools: () => {
        this.toolsStale = true;
        this.scheduleToolRefresh();
      },
      openUrl: this.options.openUrl,
      settings: this.options.settings.extensions,
      reservedTools: new Set([...BUILTIN_TOOL_NAMES, ...reservedTools]),
      reservedCommands: new Set([
        ...BUILTIN_SLASH.flatMap((command) => [
          command.name,
          ...(command.aliases ?? []),
        ]),
        ...commands.map((command) => command.name),
      ]),
    });
  }
  /** The main system prompt. Every rebuild goes through here: start, a new or resumed
   * session, a model switch, /reload, /mcp reload, /extensions reload, /plan and a change
   * of thinking depth. Skills are read again each time, so the list and the `skill` tool
   * see the same skills. */
  private loadSubagentFiles(): void {
    const found =
      this.options.localContext === false
        ? { agents: [], problems: [] }
        : discoverSubagents(
            this.options.workspace,
            this.options.home,
            this.options.userHome,
          );
    this.fileAgents = found.agents;
    this.fileAgentProblems = found.problems;
  }
  /**
   * The subagents a person or an extension defined. Folders first, so an extension of the
   * same name wins, as it already does over a built-in. A file naming a tool that does not
   * exist is passed over and `problems` says so, rather than running with a broken set.
   */
  private customSubagents(
    problems: string[] = [],
  ): { spec: SubagentSpec; tools?: Tool[]; source: string; path?: string }[] {
    const byName = new Map<
      string,
      { spec: SubagentSpec; tools?: Tool[]; source: string; path?: string }
    >();
    for (const agent of this.fileAgents) {
      const missing = (agent.tools ?? []).filter(
        (name) => !this.allTools.some((tool) => tool.name === name),
      );
      if (missing.length) {
        problems.push(
          `${agent.spec.name} names tools that do not exist: ${missing.join(', ')} · not offered`,
        );
        continue;
      }
      byName.set(agent.spec.name, {
        spec: agent.spec,
        source: agent.source_label,
        path: agent.path,
        ...(agent.tools
          ? {
              tools: agent.tools.map((name) =>
                this.allTools.find((tool) => tool.name === name)!,
              ),
            }
          : {}),
      });
    }
    for (const agent of this.extensions.subagents(this.allTools))
      byName.set(agent.spec.name, {
        spec: agent.spec,
        tools: agent.tools,
        source: 'Extension',
      });
    return [...byName.values()];
  }
  /**
   * Everything `task` may choose, for `/agents`: the two that ship with Circle, then the
   * folders and extensions, with the reason any definition was passed over. The folders are
   * read again here, as `task` will see them.
   */
  inspectSubagents(): {
    agents: {
      name: string;
      description: string;
      source: string;
      model?: string;
      tools?: string[];
      path?: string;
    }[];
    problems: string[];
  } {
    this.loadSubagentFiles();
    const problems = [...this.fileAgentProblems];
    const byName = new Map([
      [
        'general-purpose',
        {
          name: 'general-purpose',
          description: 'General coding tasks.',
          source: 'Circle',
          tools: undefined,
          model: undefined,
        },
      ],
      [
        'explore',
        {
          name: 'explore',
          description: 'Read-only project exploration.',
          source: 'Circle',
          tools: undefined,
          model: undefined,
        },
      ],
    ] as [
      string,
      {
        name: string;
        description: string;
        source: string;
        model?: string;
        tools?: string[];
      },
    ][]);
    for (const agent of this.customSubagents(problems))
      byName.set(agent.spec.name, {
        name: agent.spec.name,
        description: agent.spec.description,
        source: agent.source,
        ...(agent.spec.model ? { model: agent.spec.model } : {}),
        ...(agent.tools ? { tools: agent.tools.map((tool) => tool.name) } : {}),
        ...(agent.path ? { path: agent.path } : {}),
      });
    return { agents: [...byName.values()], problems };
  }
  private systemPrompt(model: string): string {
    this.loadSubagentFiles();
    this.skills =
      this.options.localContext === false
        ? []
        : discoverSkills(
            this.options.workspace,
            this.options.home,
            this.options.userHome,
          );
    return buildSystemPrompt(
      this.options.workspace,
      model,
      this.options.settings.auth.protocol,
      this.runOptions,
      this.options.home,
      {
        skills: this.skills,
        onContextFiles: (files) => {
          this.promptInstructions = files.map((file) => ({ ...file }));
        },
        extensionTools: this.extensions.tools(),
        userHome: this.options.userHome,
        localContext: this.options.localContext,
        variables: this.options.settings.variables,
        secrets: secretNames(this.options.home),
        attribution: this.options.settings.attribution,
        headless: this.options.headless,
        mcpInstructions: this.mcp.instructions(),
      },
    );
  }
  /** The variables or the secrets changed: the next request tells the model. */
  refreshPrompt(): void {
    this.refreshSystemPrompt();
  }
  /**
   * Keeps a value the person gave as a Circle variable, in the settings and for this run;
   * the model's next request lists it.
   */
  keepVariable(name: string, value: string): void {
    if (!VARIABLE_NAME.test(name))
      throw new Error(
        'a variable name is capital letters, digits and _, starting with a letter',
      );
    if (secretNames(this.options.home).includes(name))
      throw new Error(`${name} is a secret; it keeps its own value`);
    if (value.length > MAX_SECRET || /[\r\n]/.test(value))
      throw new Error('a variable is one line of at most 4,096 characters');
    const next = { ...(this.options.settings.variables ?? {}), [name]: value };
    this.options.settings.variables = next;
    saveSettingsChange(this.options.home, (saved) => {
      saved.variables = { ...(saved.variables ?? {}), [name]: value };
    });
    this.refreshSystemPrompt();
  }
  private refreshSystemPrompt(): void {
    this.harness.system = this.systemPrompt(this.harness.model.model);
  }
  /** Move deferred tools onto the harness once this turn's text asks for them. */
  private promoteDeferredTools(prompt: string | undefined): void {
    const extra = this.options.deferredTools;
    if (!extra?.length) return;
    if (
      extra.every((tool) =>
        this.coreTools.some((have) => have.name === tool.name),
      )
    )
      return;
    if (!browserToolsWanted(this.harness.messages, prompt ?? '')) return;
    this.coreTools.push(
      ...extra.filter(
        (tool) => !this.coreTools.some((have) => have.name === tool.name),
      ),
    );
    this.harness.tools = this.withIntegrationTools(
      this.coreTools.filter((tool) => tool.name !== 'wait_jobs'),
    );
    this.describeSubagents(this.harness.tools);
  }
  private describeSubagents(tools: Tool[]): void {
    const task = tools.find((tool) => tool.name === 'task');
    if (!task) return;
    const subagents = new Map<string, string>([
      ['general-purpose', 'General coding tasks.'],
      ['explore', 'Read-only project exploration.'],
    ]);
    for (const agent of this.customSubagents())
      subagents.set(agent.spec.name, agent.spec.description);
    task.description =
      readFileSync(
        join(import.meta.dirname, 'prompts/tools/task.md'),
        'utf8',
      ).trim() +
      '\n\nAvailable subagents:\n' +
      [...subagents]
        .map(([name, description]) => `- ${name}: ${description}`)
        .join('\n');
  }
  private withIntegrationTools(tools: Tool[], limits = true): Tool[] {
    const names = new Set<string>();
    return [...tools, ...this.mcp.tools, ...this.extensions.tools()].filter(
      (tool) => {
        if (names.has(tool.name))
          throw new Error(`tool '${tool.name}' already exists`);
        if (limits && tool.name !== 'compact_conversation') {
          if (
            this.runOptions.tools !== null &&
            !this.runOptions.tools.includes(tool.name)
          )
            return false;
          if (this.runOptions.exclude_tools.includes(tool.name)) return false;
        }
        names.add(tool.name);
        return true;
      },
    );
  }
  private async extensionToolBoundary(
    tool: Tool,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<string> {
    const original = JSON.stringify(args);
    return this.extensions.toolBoundary(
      { tool, args, context },
      (invocation) => {
        if (
          invocation.tool !== tool ||
          invocation.context !== context ||
          JSON.stringify(invocation.args) !== original
        )
          throw new Error(
            'extension middleware cannot replace an approved tool invocation',
          );
        context.signal.throwIfAborted();
        return tool.run(invocation.args, context);
      },
    );
  }
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.ownershipError) throw this.ownershipError;
    if (this.closing || this.deleting) throw new Error('session is closing');
    if (this.options.headless && !this.options.integrations) return;
    const active = signal
      ? AbortSignal.any([signal, this.integrationLifetime.signal])
      : this.integrationLifetime.signal;
    active.throwIfAborted();
    if (!this.integrationsReady) {
      this.integrationsReady = (async () => {
        const base = this.coreTools;
        await this.mcp.load(
          this.options.settings.mcp_servers,
          new Set(base.map((tool) => tool.name)),
          active,
        );
        const host = this.extensionHost(
          new Set([...base, ...this.mcp.tools].map((tool) => tool.name)),
        );
        const stop = () => {
          // This host is not installed yet, but already owns background work.
          void host.close(2000);
        };
        active.addEventListener('abort', stop, { once: true });
        try {
          active.throwIfAborted();
          await abortable(host.load(), active);
          active.throwIfAborted();
          for (const ext of host.extensions)
            if (
              ext.source === 'bundled' &&
              this.options.settings.extensions[ext.name]?.enabled !== true
            )
              await host.disableBundled(ext.name);
          active.throwIfAborted();
        } catch (error) {
          await host.close(2000);
          throw error;
        } finally {
          active.removeEventListener('abort', stop);
        }
        const previous = this.extensions;
        this.extensions = host;
        this.harness.tools = this.withIntegrationTools(
          base.filter((tool) => tool.name !== 'wait_jobs'),
        );
        this.describeSubagents(this.harness.tools);
        this.harness.model = this.modelWithSearch(this.baseModel!);
        this.refreshSystemPrompt();
        host.emit('session_start', {
          workspace: this.options.workspace,
          session_id: this.session.id,
        });
        // The extensions loaded before end: what they still did on their own stops, and the
        // old host is waited for up to two seconds, as a watch's on_stop is.
        await previous.close(2000);
      })().catch((error) => {
        this.integrationsReady = undefined;
        throw error;
      });
    }
    await this.integrationsReady;
  }
  /** Change one bundled extension without restarting unrelated integrations. */
  setBundledExtensionEnabled(name: string, enabled: boolean): Promise<void> {
    this.options.settings.extensions[name] = {
      ...this.options.settings.extensions[name],
      enabled,
    };
    const work = (async () => {
      if (!enabled) {
        await this.extensions.disableBundled(name);
        return;
      }
      await this.initialize();
      if (
        this.options.settings.extensions[name]?.enabled === true &&
        !this.isClosing
      )
        await this.extensions.enableBundled(name);
    })();
    this.extensionChanges.set(name, work);
    for (const listener of [...this.extensionChangeListeners]) listener();
    void work
      .finally(() => {
        if (this.extensionChanges.get(name) === work)
          this.extensionChanges.delete(name);
      })
      .catch(() => {});
    return work;
  }
  private async waitForExtensionChanges(signal: AbortSignal): Promise<void> {
    while (true) {
      signal.throwIfAborted();
      const pending = [...this.extensionChanges]
        .filter(
          ([name]) => this.options.settings.extensions[name]?.enabled === true,
        )
        .map(([, work]) => work);
      if (!pending.length) return;
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const cleanup = () => {
          this.extensionChangeListeners.delete(changed);
          signal.removeEventListener('abort', abort);
        };
        const changed = () => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve();
        };
        const abort = () => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(signal.reason ?? new Error('cancelled'));
        };
        this.extensionChangeListeners.add(changed);
        signal.addEventListener('abort', abort, { once: true });
        void Promise.allSettled(pending).then(changed);
        if (signal.aborted) abort();
      });
    }
  }
  private refreshIntegrationTools() {
    if (!this.toolsStale || !this.integrationsReady) return;
    this.toolsStale = false;
    this.harness.tools = this.withIntegrationTools(
      this.coreTools.filter((tool) => tool.name !== 'wait_jobs'),
    );
    this.describeSubagents(this.harness.tools);
    this.refreshSystemPrompt();
  }
  private scheduleToolRefresh(): void {
    if (this.toolsCheck) return;
    // A macrotask later: several changes in a row become one rebuild, and a turn that just
    // ended has let go of the harness.
    this.toolsCheck = setTimeout(() => {
      this.toolsCheck = undefined;
      if (!this.toolsStale || !this.integrationsReady || this.busy) return;
      this.toolsStale = false;
      this.harness.tools = this.withIntegrationTools(
        this.coreTools.filter((tool) => tool.name !== 'wait_jobs'),
      );
      this.describeSubagents(this.harness.tools);
      this.refreshSystemPrompt();
    }, 0);
    this.toolsCheck.unref?.();
  }
  /** Configured hooks, including skill hooks this session has not loaded. */
  listHooks(): {
    hooks: { hook: HookDefinition; active: boolean }[];
    projectIgnored: boolean;
    projectChanged: HookChange[];
  } {
    const runner = this.ensureHooks();
    this.syncHookApprovals(runner);
    return {
      hooks: runner.listing(),
      projectIgnored: runner.loaded.projectIgnored,
      projectChanged: [...runner.loaded.projectChanged],
    };
  }
  /** Project hooks files this session is not running because they wait for approval. */
  pendingHooks(): HookChange[] {
    const runner = this.ensureHooks();
    this.syncHookApprovals(runner);
    return [...runner.loaded.projectChanged];
  }
  /**
   * Approve a file that waits in this session: the digest, and the hooks that load,
   * are those of `change`, the read the person was shown. False when this session is
   * not waiting for exactly that version (the file was read again since).
   */
  approveHooks(change: HookChange): boolean {
    if (this.viewOnly) throw new Error(occupiedSessionMessage(this.session.id));
    const runner = this.ensureHooks();
    const waiting = runner.loaded.projectChanged.find(
      (item) => item.file === change.file && item.digest === change.digest,
    );
    if (!waiting) return false;
    approveHookFile(this.options.home, waiting);
    return runner.approve(waiting);
  }
  /** A file approved elsewhere (another session, another Circle) loads here too. */
  private syncHookApprovals(runner: HookRunner): void {
    for (const change of [...runner.loaded.projectChanged])
      if (approvedHookDigest(this.options.home, change.file) === change.digest)
        runner.approve(change);
  }
  /** Files this session asked about and the person left off. A reload asks again. */
  private hooksAsked = new Set<string>();
  /**
   * When a turn starts: load files approved elsewhere (another session, another
   * Circle), then ask the person about each version not asked about yet.
   */
  private async reviewHooks(signal: AbortSignal): Promise<void> {
    const runner = this.ensureHooks();
    this.syncHookApprovals(runner);
    if (this.viewOnly || !runner.loaded.projectChanged.length) return;
    const ask = this.options.approveHooks;
    if (!ask) return;
    for (const change of [...runner.loaded.projectChanged]) {
      const key = `${change.file}\0${change.digest}`;
      if (this.hooksAsked.has(key)) continue;
      let approved: boolean;
      try {
        approved = await ask(change, signal);
      } catch (error) {
        // An interrupted turn did not answer; the next turn asks again.
        if (signal.aborted) throw error;
        approved = false;
      }
      this.hooksAsked.add(key);
      if (approved) this.approveHooks(change);
    }
  }
  /** Skills whose hooks are armed for the current session. */
  private armedSkills = new Set<string>();
  private ensureHooks(): HookRunner {
    if (!this.hookRunner) {
      const trusted = isFolderTrusted(
        this.options.settings,
        this.options.workspace,
      );
      this.hookRunner = new HookRunner(
        loadHooks({
          workspace: this.options.workspace,
          home: this.options.home,
          trusted,
          userHome: this.options.userHome,
        }),
        { workspace: this.options.workspace, home: this.options.home },
      );
      for (const name of this.armedSkills) this.hookRunner.activateSkill(name);
      // A fresh read asks again about every file still waiting.
      this.hooksAsked.clear();
    }
    return this.hookRunner;
  }
  /**
   * Arm the hooks that ship with a skill. Installing the skill does nothing;
   * this runs from /skill and from the skill tool, and only for this session.
   */
  async activateSkillHooks(name: string, signal?: AbortSignal): Promise<void> {
    const key = name.trim().toLowerCase();
    if (!key || this.armedSkills.has(key)) return;
    this.armedSkills.add(key);
    const runner = this.hookRunner;
    if (!runner) return;
    const armed = runner.activateSkill(key);
    if (this.harness && armed.length)
      await this.harness.skillHooksArmed(armed, signal);
  }
  /** Read hooks again. /reload uses this so a changed file applies to the next call. */
  reloadHooks(): void {
    this.hookRunner = undefined;
    if (this.harness) this.harness.options.hooks = this.ensureHooks();
  }
  async reloadIntegrations(): Promise<void> {
    if (this.ownershipError) throw this.ownershipError;
    if (this.closing || this.deleting) throw new Error('session is closing');
    if (this.busy) throw new Error('reload after the current turn');
    this.options.settings = settingsForRun(
      this.options.home,
      this.options.workspace,
      this.options.modelOverride,
    ).settings;
    this.policy.setAllowedCommands(this.options.settings.allowed_commands);
    this.reloadHooks();
    this.integrationsReady = undefined;
    await this.initialize();
  }
  /** This conversation's plan file: the path the model writes, and where it is kept. */
  get planFile(): { file: string; path: string } {
    const file = planFile(this.session.id);
    let path = this.planPaths.get(file);
    if (!path)
      this.planPaths.set(file, (path = this.sandbox.resolvePath(file)));
    return { file, path };
  }
  private planPaths = new Map<string, string>();
  private planRead?: {
    path: string;
    mtime: number;
    size: number;
    text: string;
  };
  /** The plan as last written, read again only when the file changed. */
  plan(): { file: string; text: string; updatedAt: string } | undefined {
    const { file, path } = this.planFile;
    try {
      const stat = statSync(path);
      if (
        this.planRead?.path !== path ||
        this.planRead.mtime !== stat.mtimeMs ||
        this.planRead.size !== stat.size
      )
        this.planRead = {
          path,
          mtime: stat.mtimeMs,
          size: stat.size,
          text: readFileSync(path, 'utf8'),
        };
      return {
        file,
        text: this.planRead.text,
        updatedAt: stat.mtime.toISOString(),
      };
    } catch {
      return undefined;
    }
  }
  // A fork or a clone has a new id, so its history names the plan of the conversation it
  // came from. It starts with a copy of that plan, which it then keeps as its own.
  private adoptPlan(messages: Message[]): void {
    try {
      const own = this.planFile.path;
      if (existsSync(own)) return;
      for (const message of [...messages].reverse())
        for (const call of message.tool_calls ?? []) {
          if (call.name !== 'write_file' && call.name !== 'edit_file') continue;
          const source = planSession(
            String(call.args.file_path || call.args.path || ''),
          );
          if (!source || source === this.session.id) continue;
          const from = this.sandbox.resolvePath(planFile(source));
          if (!existsSync(from)) continue;
          mkdirSync(dirname(own), { recursive: true });
          copyFileSync(from, own);
          return;
        }
    } catch {
      /* The conversation goes on without the plan it came from. */
    }
  }
  setPlanMode(enabled: boolean): void {
    if (this.viewOnly) throw new Error(occupiedSessionMessage(this.session.id));
    if (this.harness.planMode === enabled) return;
    this.harness.planMode = enabled;
    // /plan between turns builds the system prompt again at once; plan_enter and plan_exit
    // run mid-turn.
    if (!this.busy) this.refreshSystemPrompt();
    this.store.append(this.session.id, [
      {
        id: randomUUID(),
        role: 'user',
        internal: 'mode-boundary',
        content: enabled
          ? `[Circle system] Plan mode is now ON. Do not change the workspace or run shell commands. Research, write the plan to ${this.planFile.file}, and call plan_exit when it is ready.`
          : '[Circle system] Plan mode is now OFF. Previous plan-mode constraints no longer apply. Implement changes subject to normal approval.',
      },
    ]);
  }
  get mode(): SessionMode {
    return this.harness.planMode ? 'plan' : this.policy.mode(this.session.id);
  }
  // Plan leaves the approval mode at manual, so leaving plan asks again.
  setMode(mode: SessionMode): void {
    this.setPlanMode(mode === 'plan');
    this.policy.setMode(this.session.id, mode === 'plan' ? 'manual' : mode);
  }
  // A saved default_mode starts each session. A plan mode restored from the
  // transcript wins over it, and --yolo, applied after construction, wins
  // over both.
  private applyDefaultMode(): void {
    const wanted = this.options.settings.default_mode;
    if (!wanted || this.harness.planMode || this.mode === wanted) return;
    this.setMode(wanted);
  }
  setModel(model: string): void {
    if (this.busy) throw new Error('a turn is running');
    if (!model.trim()) throw new Error('model ID is required');
    const effort = this.thinkingLevel;
    const nextModel = this.gatewayModel(this.options.settings, model);
    nextModel.effort = effort;
    this.baseModel = nextModel;
    this.harness.model = this.modelWithSearch(this.baseModel);
    this.refreshSystemPrompt();
  }
  /** An explicit login/logout replaces every cached client, including future sessions. */
  refreshConnection(settings: CircleSettings): void {
    this.requireIdleSession();
    const nextSettings = structuredClone(settings);
    const ready = isReady(nextSettings);
    const nextModel: ChatModel = ready
      ? this.gatewayModel(nextSettings, undefined, true)
      : {
          model: 'not connected',
          async complete(): Promise<never> {
            throw new Error('connect an API URL, key and model first');
          },
        };
    if (nextModel instanceof GatewayModel)
      nextModel.effort = this.thinkingLevel;
    this.options.settings = nextSettings;
    this.options.modelOverride = undefined;
    this.options.model = ready ? undefined : nextModel;
    this.baseModel = nextModel;
    this.harness.model = this.modelWithSearch(nextModel);
    if (!ready) this.authFingerprint = this.savedConnectionFingerprint();
    this.refreshSystemPrompt();
  }
  private savedConnectionFingerprint(): string {
    return withConnectionLock(this.options.home, () => {
      const saved = loadSettings(this.options.home);
      // The default model can change while each session keeps its selected model.
      const { protocol, base_url, api_key_ref } = saved.auth;
      return createHash('sha256')
        .update(
          JSON.stringify({
            initialized: saved.initialized,
            auth: { protocol, base_url, api_key_ref },
            credentials: Object.entries(
              loadCredentials(this.options.home),
            ).sort(([a], [b]) => a.localeCompare(b)),
          }),
        )
        .digest('hex');
    });
  }
  private requireCurrentConnection(): void {
    // Scripted/injected models have no saved credentials or network client to invalidate.
    if (!(this.baseModel instanceof GatewayModel)) return;
    if (this.authFingerprint !== this.savedConnectionFingerprint())
      throw new Error(
        'saved connection changed in another Circle runtime; reconnect before continuing',
      );
  }
  private requireTurnConnection(): void {
    // The harness reports the failure once. Emitting here as well printed it twice.
    this.requireCurrentConnection();
  }
  private gatewayModel(
    settings: CircleSettings,
    model?: string,
    explicit = false,
  ): GatewayModel {
    return withConnectionLock(this.options.home, () => {
      if (!explicit) this.requireCurrentConnection();
      const saved = loadSettings(this.options.home);
      if (saved.initialized && isReady(settings)) {
        const endpoint = (value: string) => value.trim().replace(/\/+$/, '');
        if (
          saved.auth.protocol !== settings.auth.protocol ||
          endpoint(saved.auth.base_url) !== endpoint(settings.auth.base_url) ||
          saved.auth.api_key_ref !== settings.auth.api_key_ref
        )
          throw new Error(
            'saved connection changed in another Circle runtime; reconnect before continuing',
          );
      }
      const fingerprint = this.savedConnectionFingerprint();
      const gateway = new GatewayModel(
        settings,
        this.options.home,
        model,
        {},
        this.catalog,
      );
      if (fingerprint !== this.savedConnectionFingerprint())
        throw new Error(
          'saved connection changed in another Circle runtime; reconnect before continuing',
        );
      this.authFingerprint = fingerprint;
      return gateway;
    });
  }
  get thinkingLevel(): string {
    return this.baseModel instanceof GatewayModel
      ? this.baseModel.effort
      : this.options.settings.default_thinking;
  }
  setThinkingLevel(level: string): void {
    if (this.busy) throw new Error('a turn is running');
    if (!(EFFORT_LEVELS as readonly string[]).includes(level))
      throw new Error('unknown thinking depth');
    if (this.baseModel instanceof GatewayModel) this.baseModel.effort = level;
    this.options.settings.default_thinking = level;
    this.refreshSystemPrompt();
  }
  /**
   * A chosen depth, or `default` when the user has not chosen one. `default` clears
   * the saved preference and sends the protocol's usual effort (Anthropic `medium`).
   * A request already built keeps the depth it read. The next request uses this choice.
   */
  applyThinkingChoice(level: string): void {
    const clearing = level === 'default' || level === '';
    if (!clearing && !(EFFORT_LEVELS as readonly string[]).includes(level))
      throw new Error('unknown thinking depth');
    if (this.baseModel instanceof GatewayModel)
      this.baseModel.effort = clearing
        ? defaultEffort(this.baseModel.settings.auth.protocol, '')
        : level;
    this.options.settings.default_thinking = clearing ? '' : level;
    if (!this.busy) this.refreshSystemPrompt();
  }
  stats(): {
    messages: number;
    toolCalls: number;
    usage: import('./types.js').Usage;
    costs: CostSummary;
  } {
    const messages = this.harness.messages;
    const usage = emptyUsage();
    let estimatedIn = 0;
    let estimatedOut = 0;
    let unreportedIn = 0;
    const countEstimate = (message: {
      interrupted?: boolean;
      cache_reported?: boolean;
      usage?: import('./types.js').Usage;
    }): void => {
      if (!message.usage) return;
      if (message.interrupted) {
        estimatedIn += message.usage.input_tokens;
        estimatedOut += message.usage.output_tokens;
        return;
      }
      if (message.cache_reported === false)
        unreportedIn += message.usage.input_tokens;
    };
    for (const message of messages)
      if (message.usage) {
        addUsage(usage, message.usage);
        countEstimate(message);
      }
    const costs = messageCosts(messages);
    const compactions = new UsageCostTotals();
    const state = this.store.contextState(this.session.id);
    for (const id of state.subagentSessionIds ?? []) {
      if (!this.store.get(id)) continue;
      const messages = this.store.messages(id);
      for (const message of messages)
        if (message.usage) {
          addUsage(usage, message.usage);
          countEstimate(message);
          if (message.model_calls?.length)
            for (const call of message.model_calls) compactions.add(call.cost);
          else compactions.add(message.cost, message.interrupted === true);
        }
      const childState = this.store.contextState(id);
      const calls =
        childState.compactionCalls ??
        (childState.summary?.usage
          ? [
              {
                usage: childState.summary.usage,
                cost: childState.summary.response?.cost,
              },
            ]
          : []);
      for (const call of calls) {
        addUsage(usage, call.usage);
        compactions.add(call.cost);
      }
    }
    const calls =
      state.compactionCalls ??
      (state.summary?.usage
        ? [{ usage: state.summary.usage, cost: state.summary.response?.cost }]
        : []);
    for (const call of calls) {
      addUsage(usage, call.usage);
      compactions.add(call.cost);
    }
    const summary = compactions.snapshot();
    for (const [currency, amount] of Object.entries(summary.amounts))
      costs.amounts[currency] = (costs.amounts[currency] ?? 0) + amount;
    costs.calls += summary.calls;
    costs.unpriced_calls += summary.unpriced_calls;
    if (summary.estimated_amounts) {
      costs.estimated_amounts ??= {};
      for (const [currency, amount] of Object.entries(
        summary.estimated_amounts,
      ))
        costs.estimated_amounts[currency] =
          (costs.estimated_amounts[currency] ?? 0) + amount;
    }
    if (estimatedIn || estimatedOut) {
      usage.estimated_input_tokens = estimatedIn;
      usage.estimated_output_tokens = estimatedOut;
    }
    if (unreportedIn) usage.cache_unreported_input = unreportedIn;
    return {
      messages: messages.length,
      toolCalls: messages.reduce(
        (sum, message) => sum + (message.tool_calls?.length || 0),
        0,
      ),
      usage,
      costs,
    };
  }
  async compact(hint = '', signal?: AbortSignal): Promise<string> {
    if (this.ownershipError) throw this.ownershipError;
    if (this.viewOnly) throw new Error(occupiedSessionMessage(this.session.id));
    if (!signal) this.requireCurrentConnection();
    if (this.closing || this.deleting) throw new Error('session is closing');
    if (signal)
      return this.context.compact(
        this.session.id,
        this.harness.model,
        signal,
        hint,
        { system: this.harness.system, tools: this.harness.tools },
      );
    if (this.activeCompaction || this.harness.busy)
      throw new Error('a turn is running');
    this.compactionController = new AbortController();
    this.activeCompaction = this.context.compact(
      this.session.id,
      this.harness.model,
      this.compactionController.signal,
      hint,
      { system: this.harness.system, tools: this.harness.tools },
    );
    try {
      return await this.activeCompaction;
    } finally {
      this.activeCompaction = undefined;
      this.compactionController = undefined;
      this.releaseIfAway();
    }
  }
  /** Another terminal owns this session. History is readable; nothing may write. */
  get viewOnly(): boolean {
    return this.options.inspect === true;
  }
  /** A turn, a job or a queued message still belongs to this terminal. */
  private retainsLease(): boolean {
    if (this.busy || this.closing) return true;
    if (this.jobs.list().some((job) => job.status === 'running')) return true;
    const queued = this.harness.queuedMessages;
    return queued.steering.length > 0 || queued.followUp.length > 0;
  }
  /**
   * Drop the lease when the session leaves the screen. A turn, a job or a queue
   * keeps it until that work finishes, then the lock goes.
   */
  yieldLease(): void {
    if (this.viewOnly) return;
    this.away = true;
    this.releaseIfAway();
  }
  private releaseIfAway(): void {
    if (!this.away || this.viewOnly || this.retainsLease()) return;
    this.store.releaseSession(this.session.id);
  }
  /**
   * Take the lease back after a switch. False when another Circle holds it:
   * this runtime stays view-only until a later call succeeds.
   */
  resumeLease(): boolean {
    if (this.closing) return false;
    this.away = false;
    const wasInspect = this.viewOnly;
    try {
      this.store.claimSession(this.session.id, (error) =>
        this.ownershipLost(error),
      );
    } catch (error) {
      if (!(error instanceof SessionOccupiedError)) throw error;
      this.options.inspect = true;
      this.harness.options.inspect = true;
      return false;
    }
    this.options.inspect = false;
    this.harness.options.inspect = false;
    if (wasInspect) this.store.repairInterrupted(this.session.id);
    return true;
  }
  get busy(): boolean {
    return (
      this.harness.busy ||
      this.userShells.busy ||
      Boolean(this.activeCompaction)
    );
  }
  async cancel(options: { keepQueue?: boolean } = {}): Promise<void> {
    this.compactionController?.abort(new Error('Interrupted'));
    await Promise.allSettled([
      this.activeCompaction,
      this.harness.cancel(options),
      this.userShells.cancel(),
    ]);
  }
  async newSession(): Promise<void> {
    this.requireIdleSession();
    const previous = this.session.id;
    const session = this.store.create(
      this.options.workspace,
      this.harness.model.model,
      this.runOptions.session_name,
      undefined,
      null,
      Boolean(this.options.deferSession) && !this.runOptions.session_name,
    );
    this.store.claimSession(session.id, (error) => this.ownershipLost(error));
    this.session = session;
    this.todos = [];
    this.armedSkills.clear();
    this.hookRunner = undefined;
    this.harness = this.createHarness(this.options.model);
    this.todos = restoredTodos(this.harness.messages);
    this.applyDefaultMode();
    this.bus.setRunId(this.session.id);
    this.store.releaseSession(previous);
    this.store.dropDeferred(previous);
    this.extensions.emit('session_start', {
      workspace: this.options.workspace,
      session_id: this.session.id,
    });
  }
  async switchSession(id: string): Promise<void> {
    this.requireIdleSession();
    let session = this.store.find(id);
    if (!session) throw new Error('unknown session');
    if (session.workspace !== this.options.workspace)
      session = this.store.fork(session.id, this.options.workspace);
    const previous = this.session.id;
    this.store.claimSession(session.id, (error) => this.ownershipLost(error));
    this.session = session;
    this.store.repairStaleTitles();
    const repaired = this.store.get(session.id);
    if (repaired) this.session = repaired;
    this.armedSkills.clear();
    this.hookRunner = undefined;
    this.harness = this.createHarness(this.options.model);
    this.todos = restoredTodos(this.harness.messages);
    this.applyDefaultMode();
    this.bus.setRunId(session.id);
    if (previous !== session.id) this.store.releaseSession(previous);
    this.refreshFallbackTitle();
  }
  private requireIdleSession(): void {
    if (this.ownershipError) throw this.ownershipError;
    if (this.closing || this.deleting) throw new Error('session is closing');
    if (this.busy) throw new Error('a turn is running');
    if (this.jobs.list().some((job) => job.status === 'running'))
      throw new Error('background tasks are running');
  }
  async importSession(text: string): Promise<void> {
    this.requireIdleSession();
    const { header, messages, graph } = fromJsonl(text);
    if (graph) {
      const session = this.store.importGraph(graph, this.options.workspace);
      const previous = this.session.id;
      this.store.claimSession(session.id, (error) => this.ownershipLost(error));
      this.session = session;
      this.armedSkills.clear();
      this.hookRunner = undefined;
      this.harness = this.createHarness(this.options.model);
      this.todos = restoredTodos(this.harness.messages);
      this.applyDefaultMode();
      this.bus.setRunId(session.id);
      this.store.releaseSession(previous);
      this.store.repairStaleTitles();
      const repaired = this.store.get(session.id);
      if (repaired) this.session = repaired;
      this.refreshFallbackTitle();
      this.extensions.emit('session_start', {
        workspace: this.options.workspace,
        session_id: session.id,
      });
      return;
    }
    await this.newSession();
    this.store.append(this.session.id, messages);
    const restored = restoredPlanMode(messages);
    // The imported transcript decides plan mode. A saved default_mode may
    // have turned plan on inside newSession; setPlanMode(false) then records
    // the correction, so resuming this session reads the same state. Without
    // that it is a no-op and the assignment behaves as before.
    if (restored) this.harness.planMode = true;
    else this.setPlanMode(false);
    this.todos = restoredTodos(messages);
    if (typeof header.title === 'string')
      this.store.rename(this.session.id, header.title);
    this.store.repairStaleTitles();
    const repaired = this.store.get(this.session.id);
    if (repaired) this.session = repaired;
    this.refreshFallbackTitle();
  }
  /**
   * Ask again when a finished session still has the trimmed first message, a
   * cut of that message, several messages stuck together, or a title that
   * reads as work already done. A greeting is not worth a request. A name
   * from /name stays.
   */
  private refreshFallbackTitle(): void {
    if (this.options.inspect) return;
    void this.retitleSession(this.session.id);
  }
  /**
   * The welcome list shows three other sessions. Ask for those titles once, one
   * at a time, when a reply is already stored and the name is not locked.
   * Opening them is not required. A model with no side request is left alone.
   */
  repairRecentTitles(): void {
    if (
      this.closing ||
      this.options.inspect ||
      !this.harness.model.sideRequests
    )
      return;
    const pending = this.store
      .list(this.options.workspace)
      .filter((session) => session.id !== this.session.id)
      .slice(0, 3);
    if (!pending.length) return;
    void this.repairRecent(pending.map((session) => session.id));
  }
  private repairingRecent = false;
  private async repairRecent(ids: string[]): Promise<void> {
    if (this.repairingRecent) return;
    this.repairingRecent = true;
    try {
      for (const id of ids) {
        if (this.closing) return;
        await this.retitleSession(id);
      }
    } finally {
      this.repairingRecent = false;
    }
  }
  private retitleSession(id: string): Promise<void> {
    // A repair on open is quiet: a model that cannot be asked is not a failure here.
    if (!this.harness.model.sideRequests) return Promise.resolve();
    const session = this.store.get(id);
    if (!session?.title || !session.head || session.title_locked)
      return Promise.resolve();
    let messages;
    try {
      messages = this.store.messages(session.id);
    } catch {
      return Promise.resolve();
    }
    const prompts = userPrompts(messages);
    const source = prompts[0];
    if (
      !source ||
      !titleNeedsRefresh(session.title, source, prompts.slice(1)) ||
      !messages.some((message) => message.role === 'assistant')
    )
      return Promise.resolve();
    return this.harness.retitle(prompts.join('\n'), session.title, session.id);
  }
  exportSession(): string {
    if (
      this.busy ||
      this.jobs
        .list(this.session.id)
        .some((job) => job.kind === 'agent' && job.status === 'running')
    )
      throw new Error(
        'export after the current turn and background subagents finish',
      );
    return toSessionBundle(this.store, this.session.id);
  }
  async close(saveJobNotes = true): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    this.integrationLifetime.abort(new Error('runtime closed'));
    this.closingPromise = this.closeResources(saveJobNotes);
    return this.closingPromise;
  }
  private ownershipLost(error: Error): void {
    this.ownershipError = error;
    this.bus.emit('error', {
      payload: { message: error.message, session_ownership_lost: true },
    });
    // Turn cancellation deliberately leaves background jobs alive for an ordinary
    // stop. Losing execution ownership must instead stop every owned writer, while
    // retaining the readable store so the UI can still show this session's history.
    this.ownershipCleanup ??= this.stopUnownedWork();
  }
  private async stopUnownedWork(): Promise<void> {
    const results = await Promise.allSettled([
      this.cancel(),
      this.jobs.close(),
    ]);
    await this.integrationsReady?.catch(() => {});
    results.push(
      ...(await Promise.allSettled([
        this.extensions.close(2000, { requireSettled: true }),
        this.mcp.close(),
        this.lsp.close(),
      ])),
    );
    for (const result of results)
      if (result.status === 'rejected')
        this.bus.emit('error', {
          payload: {
            message: `session ownership cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
            session_ownership_lost: true,
          },
        });
  }
  /** Delete only after all writers and owned processes have finished, while still leased. */
  async deleteSession(): Promise<void> {
    if (this.closing && !this.deleting)
      throw new Error('session is already closing');
    if (this.closingPromise) return this.closingPromise;
    this.deleting = true;
    this.closing = true;
    this.closingPromise = this.closeResources(false, true);
    try {
      await this.closingPromise;
    } catch (error) {
      // Keep both history and ownership for a safe retry after cleanup failed.
      this.closingPromise = undefined;
      throw error;
    }
  }
  private async closeResources(
    saveJobNotes: boolean,
    deleteSession = false,
  ): Promise<void> {
    await this.ownershipCleanup;
    if (this.toolsCheck) clearTimeout(this.toolsCheck);
    await this.catalog.close();
    this.compactionController?.abort(new Error('Interrupted'));
    await this.activeCompaction?.catch(() => {});
    await this.harness
      .cancel({
        preserveInputs: !deleteSession && this.options.preserveQueuedInputs,
      })
      // The turn is stopped either way. A queue the store could not drop stays
      // queued, and the next open offers it back rather than sending it.
      .catch((error) => {
        if (deleteSession) throw error;
      });
    await this.harness.finishTitle();
    await this.userShells.cancel();
    const stopped = await this.jobs.close();
    if (!this.ownershipError) this.userShells.flush();
    for (const sessionId of saveJobNotes && !this.ownershipError
      ? new Set(stopped.map((job) => job.sessionId))
      : []) {
      const notices = this.jobs.takeNotices(sessionId);
      if (notices.length && this.store.get(sessionId))
        this.store.append(sessionId, notices);
    }
    await this.integrationsReady?.catch(() => {});
    await this.extensions.close(2000, { requireSettled: deleteSession });
    await this.mcp.close();
    await this.lsp.close();
    if (deleteSession) await this.options.beforeDelete?.();
    if (deleteSession)
      this.store.delete(this.session.id, (ids) => {
        for (const id of ids) {
          this.policy.store.remove(id);
          // A plan left behind is harmless; it never keeps a session from going
          try {
            rmSync(this.sandbox.resolvePath(planFile(id)), { force: true });
          } catch {
            /* kept */
          }
        }
      });
    this.store.close();
  }
  async runJobNotices(): Promise<string | undefined> {
    if (
      this.closing ||
      this.busy ||
      !this.jobs.hasNotices(this.session.id, true)
    )
      return undefined;
    return (await this.harness.run()).answer;
  }
}
