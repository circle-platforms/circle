import { createHash, randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ChatModel, Message, ToolCall } from './types.js';
import { GatewayModel, EFFORT_LEVELS, defaultEffort } from './model.js';
import { CheckpointStore, type Session } from './checkpoint_store.js';
import {
  defaultPolicy,
  DEFAULT_CREDENTIAL_FILES,
  type SessionMode,
} from './approvals.js';
import { Sandbox } from './sandbox.js';
import { buildTools, type Todo } from './tools.js';
import {
  loadSecrets,
  MAX_SECRET,
  secretNames,
  secretRedactor,
  written,
  type Redactor,
} from './secrets.js';
import { buildSystemPrompt } from './system_prompt.js';
import { Harness, type ApprovalDecision } from './harness.js';
import { EventBus } from './events.js';
import { defaultRunOptions, type RunOptions } from './run_options.js';
import type { CircleSettings } from './settings.js';
import { discoverSkills, loadSkillBody, type SkillInfo } from './skills.js';
import { fromJsonl, toSessionBundle } from './session_export.js';
import { projectDataDir, circleHome, normalizeWorkspace } from './paths.js';
import { McpManager } from './mcp_loader.js';
import { ExtensionHost } from './extensions.js';
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
import {
  ContextManager,
  restoredTodos,
  restoredPlanMode,
} from './context_middleware.js';
import { migrateLegacy } from './migration.js';
import type { MigrationReport } from './legacy_sessions.js';
import { askQuestions } from './questions.js';
import type { SecretRequest } from './secret_prompt.js';
import { JobRegistry, jobLine, type Job } from './jobs.js';
import { ModelCatalog } from './model_catalog.js';
import {
  priceCall,
  messageCosts,
  UsageCostTotals,
  type CostSummary,
} from './pricing.js';
import { addUsage, emptyUsage } from './types.js';
import { UserShells } from './user_shell.js';
import { toolCallLine } from './headless.js';
import { canScreenshot, type ScreenshotOptions } from './screenshot.js';
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
  catalog?: ModelCatalog;
  extraTools?: Tool[];
  /** Where the extensions that ship with Circle are; false for none (tests). */
  bundledExtensions?: string | false;
  /** An extension's status line changed. */
  onExtensionStatus?: () => void;
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
}
export class AgentRuntime {
  readonly migration: MigrationReport;
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
  // Read again with every system prompt, see systemPrompt().
  skills: SkillInfo[] = [];
  readonly mcp: McpManager;
  readonly lsp: LspManager;
  readonly context: ContextManager;
  private compactionController?: AbortController;
  private activeCompaction?: Promise<string>;
  extensions: ExtensionHost;
  private integrationsReady?: Promise<void>;
  private baseModel?: ChatModel;
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
    );
    this.migration = this.runOptions.no_session
      ? { imported: [], skipped: [], errors: [] }
      : migrateLegacy(options.home, this.store);
    try {
      let session: Session | undefined;
      if (options.session) {
        session = this.store.find(options.session);
        if (!session) throw new Error('unknown session');
        if (session.workspace !== options.workspace)
          session = this.store.fork(session.id, options.workspace);
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
        );
      this.store.claimSession(this.session.id, (error) =>
        this.ownershipLost(error),
      );
      // A delete may have completed between discovery and acquiring the lease.
      const current = this.store.get(this.session.id);
      if (!current) throw new Error('unknown session');
      this.session = current;
      this.store.repairStaleTitles();
      const repaired = this.store.get(this.session.id);
      if (repaired) this.session = repaired;
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
    this.jobs = new JobRegistry(this.sandbox, (kind, job) => {
      if (kind === 'job_ended') this.userShells?.ended(job);
      this.bus.emit(kind, {
        payload: { job },
        tags: { session_id: job.sessionId },
      });
    });
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
      changed: () => this.bus.emit('info', { payload: { user_shell: true } }),
    });
    this.mcp = new McpManager(options.workspace);
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
      this.store.rename(this.session.id, this.runOptions.session_name);
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
  private createHarness(modelOverride?: ChatModel): Harness {
    const model =
      modelOverride ??
      this.baseModel ??
      this.gatewayModel(this.options.settings);
    if (model instanceof GatewayModel && !this.authFingerprint)
      this.authFingerprint = this.savedConnectionFingerprint();
    this.baseModel = model;
    const system = this.systemPrompt(model.model);
    let tools = buildTools(this.sandbox, {
      jobs: this.jobs,
      screenshot:
        this.options.screenshot === false
          ? undefined
          : (this.options.screenshot ?? (canScreenshot() ? {} : undefined)),
      todos: (todos) => {
        this.todos = todos;
        this.bus.emit('todo_list', { payload: { todos } });
      },
      skill: async (name) => loadSkillBody(name, this.skills),
      question: async (args, context) =>
        askQuestions(this.options.home, this.sandbox, args, context.signal, {
          ask: this.options.question,
          secret: this.options.secret,
          keep: (name, value) => this.keepVariable(name, value),
        }),
      plan: async (enabled, context) => {
        if (!enabled && !this.options.question)
          throw new Error('plan_exit requires an interactive answer');
        if (!enabled) {
          const reply = await this.options.question!(
            {
              questions: [
                {
                  question: 'Implement the completed plan?',
                  header: 'plan',
                  options: [
                    {
                      label: 'implement plan',
                      description: 'Leave read-only mode, ask before edits',
                    },
                    {
                      label: 'implement plan, accept edits',
                      description:
                        'Leave read-only mode, edit workspace files without asking',
                    },
                    {
                      label: 'continue planning',
                      description: 'Stay in read-only mode',
                    },
                  ],
                  multiple: false,
                  custom: false,
                },
              ],
            },
            context.signal,
          );
          context.signal.throwIfAborted();
          let answers: unknown;
          try {
            answers = JSON.parse(reply);
          } catch {
            answers = undefined;
          }
          const chosen = Array.isArray(answers) ? answers.flat() : [];
          if (chosen.includes('implement plan, accept edits')) {
            this.setMode('accept-edits');
            return 'Read-only mode disabled. File edits inside the workspace are accepted without asking.';
          }
          if (!chosen.includes('implement plan'))
            return 'The user kept read-only mode active. Continue planning.';
          this.setMode('manual');
          return 'Read-only mode disabled.';
        }
        this.setPlanMode(enabled);
        return enabled ? 'Read-only mode enabled.' : 'Read-only mode disabled.';
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
        const custom = this.extensions
          .subagents(this.allTools)
          .find((agent) => agent.spec.name === name);
        if (!custom && !['general-purpose', 'explore'].includes(name))
          throw new Error('unknown subagent type');
        const childModel = custom?.spec.model
          ? this.extensions.model(
              this.gatewayModel(this.options.settings, custom.spec.model),
            )
          : parentHarness.model;
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
          jobs: this.jobs,
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
        const ownedChildTools = childTools.map((tool) =>
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
        );
        const child: Harness = new Harness({
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
          headless: this.options.headless,
          approvalSessionId: parentSessionId,
          priceUsage: (model, usage) =>
            priceCall(this.catalog.facts(model, this.options.settings), usage),
          parentPlanMode: () => this.harness.planMode,
          toolBoundary: (tool, args, context) =>
            this.extensionToolBoundary(tool, args, context),
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
          );
          return `In background: ${jobLine(job)}. The subagent report will arrive as a notice; do not poll or sleep.`;
        }
        return runChild(context.signal);
      },
    });
    tools.push(this.lsp.tool());
    tools.push(...(this.options.extraTools ?? []));
    this.coreTools = tools;
    tools = this.withIntegrationTools(
      tools.filter((tool) => tool.name !== 'wait_jobs'),
    );
    // A new or resumed session after the integrations loaded keeps their subagents.
    if (this.integrationsReady) this.describeSubagents(tools);
    const harness = new Harness({
      variables: () => this.options.settings.variables,
      secrets: () => loadSecrets(this.options.home),
      redact: this.redact,
      model: this.extensions.model(model),
      tools,
      store: this.store,
      session: this.session,
      policy: this.policy,
      system,
      bus: this.bus,
      headless: this.options.headless,
      approve: this.options.approve,
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
      },
      beforeTurn: () => this.requireTurnConnection(),
      beforeStep: () => {
        this.userShells.flush();
        const messages = this.jobs.takeNotices(this.harness.sessionId);
        if (messages.length)
          this.store.append(this.harness.sessionId, messages);
      },
      toolBoundary: (tool, args, context) =>
        this.extensionToolBoundary(tool, args, context),
      prepareMessages: (signal) =>
        this.context.prepare(
          this.session.id,
          this.harness.model,
          this.harness.system,
          this.harness.tools,
          signal,
        ),
      planFileMutation: (call) => {
        if (['write_file', 'edit_file', 'delete'].includes(call.name)) {
          const path = this.sandbox.resolvePath(
            String(call.args.file_path || call.args.path || ''),
          );
          return ['plan.md', 'plan'].includes(basename(path).toLowerCase());
        }
        if (call.name !== 'apply_patch') return false;
        const paths = [
          ...String(call.args.patchText || '').matchAll(
            /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+)$/gm,
          ),
        ].map((match) => this.sandbox.resolvePath(match[1]!));
        return (
          paths.length > 0 &&
          paths.every((path) =>
            ['plan.md', 'plan'].includes(basename(path).toLowerCase()),
          )
        );
      },
    });
    harness.planMode = restoredPlanMode(harness.messages);
    return harness;
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
   * of thinking depth. Skills are read again each time, as 0.5.0 read them whenever it
   * rebuilt its agent, so the list and the `skill` tool see the same skills. */
  private systemPrompt(model: string): string {
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
        extensionTools: this.extensions.tools(),
        userHome: this.options.userHome,
        localContext: this.options.localContext,
        variables: this.options.settings.variables,
        secrets: secretNames(this.options.home),
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
  private describeSubagents(tools: Tool[]): void {
    const task = tools.find((tool) => tool.name === 'task');
    if (!task) return;
    const subagents = new Map<string, string>([
      ['general-purpose', 'General coding tasks.'],
      ['explore', 'Read-only project exploration.'],
    ]);
    for (const agent of this.extensions.subagents(this.allTools))
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
    if (!this.integrationsReady) {
      this.integrationsReady = (async () => {
        const base = this.coreTools;
        await this.mcp.load(
          this.options.settings.mcp_servers,
          new Set(base.map((tool) => tool.name)),
          signal,
        );
        const host = this.extensionHost(
          new Set([...base, ...this.mcp.tools].map((tool) => tool.name)),
        );
        await host.load();
        if (signal?.aborted) {
          await host.close(2000);
          signal.throwIfAborted();
        }
        const previous = this.extensions;
        this.extensions = host;
        this.harness.tools = this.withIntegrationTools(
          base.filter((tool) => tool.name !== 'wait_jobs'),
        );
        this.describeSubagents(this.harness.tools);
        this.harness.model = host.model(this.baseModel!);
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
    this.integrationsReady = undefined;
    await this.initialize();
  }
  setPlanMode(enabled: boolean): void {
    if (this.harness.planMode === enabled) return;
    this.harness.planMode = enabled;
    // /plan between turns rebuilt the agent in 0.5.0; plan_enter and plan_exit run mid-turn.
    if (!this.busy) this.refreshSystemPrompt();
    this.store.append(this.session.id, [
      {
        id: randomUUID(),
        role: 'user',
        internal: 'mode-boundary',
        content: enabled
          ? '[Circle system] Plan mode is now ON. Do not create/edit/delete project files except plan.md; do not run shell commands. Research and update the plan only.'
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
    this.harness.model = this.extensions.model(this.baseModel);
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
    this.harness.model = this.extensions.model(nextModel);
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
    try {
      this.requireCurrentConnection();
    } catch (error) {
      this.bus.emit('run_error', {
        payload: {
          message: error instanceof Error ? error.message : String(error),
          connection_changed: true,
        },
      });
      throw error;
    }
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
    for (const message of messages)
      if (message.usage) addUsage(usage, message.usage);
    const costs = messageCosts(messages);
    const compactions = new UsageCostTotals();
    const state = this.store.contextState(this.session.id);
    for (const id of state.subagentSessionIds ?? []) {
      if (!this.store.get(id)) continue;
      const messages = this.store.messages(id);
      for (const message of messages)
        if (message.usage) {
          addUsage(usage, message.usage);
          compactions.add(message.cost);
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
    }
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
    );
    this.store.claimSession(session.id, (error) => this.ownershipLost(error));
    this.session = session;
    this.todos = [];
    this.harness = this.createHarness(this.options.model);
    this.todos = restoredTodos(this.harness.messages);
    this.applyDefaultMode();
    this.bus.setRunId(this.session.id);
    this.store.releaseSession(previous);
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
    this.harness = this.createHarness(this.options.model);
    this.todos = restoredTodos(this.harness.messages);
    this.applyDefaultMode();
    this.bus.setRunId(session.id);
    if (previous !== session.id) this.store.releaseSession(previous);
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
      this.harness = this.createHarness(this.options.model);
      this.todos = restoredTodos(this.harness.messages);
      this.applyDefaultMode();
      this.bus.setRunId(session.id);
      this.store.releaseSession(previous);
      this.store.repairStaleTitles();
      const repaired = this.store.get(session.id);
      if (repaired) this.session = repaired;
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
    await this.harness.cancel();
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
        for (const id of ids) this.policy.store.remove(id);
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
