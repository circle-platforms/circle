import { prepareKnowledgeShare } from './knowledge/sharing.js';
import {
  deferredKnowledgeTool,
  knowledgeToolsWanted,
} from './knowledge/tools.js';
import { KnowledgeService, type KnowledgeAccess } from './knowledge/service.js';
import { createHash, randomUUID } from 'node:crypto';
import type { GitHubConnectionBackend } from './github_connection.js';
import { basename, join, dirname } from 'node:path';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { SKILL_DATA_FOLDER, SKILLS_ROOT } from './local_skills.js';
import { packTool, readPackTools } from './pack_tools.js';
import type { ChatModel, Message, PreparedRun, ToolCall } from './types.js';
import { GatewayModel, EFFORT_LEVELS, defaultEffort } from './model.js';
import { WebSearchService } from './websearch_service.js';
import type { NativeSearchConnection } from './native_websearch.js';
import { CheckpointStore, type Session } from './checkpoint_store.js';
import { requestBudget, resolveBudget, contentHash } from './request_budget.js';
import {
  occupiedSessionMessage,
  SessionOccupiedError,
} from './session_lock.js';
import {
  defaultPolicy,
  DEFAULT_CREDENTIAL_FILES,
  type ApprovalMode,
  type SessionMode,
} from './approvals.js';
import { Sandbox, WORKFLOW_RUNS_FOLDER } from './sandbox.js';
import { EditorBridge } from './editor_bridge.js';
import { buildTools, type Todo } from './tools.js';
import { browserToolsWanted } from './browser/tools.js';
import { mcpPlaceholders } from './mcp_placeholders.js';
import {
  loadSecrets,
  MAX_SECRET,
  secretNames,
  secretRedactor,
  secretsPath,
  written,
  type Redactor,
} from './secrets.js';
import { mcpAuthPath } from './mcp_auth.js';
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
import { EventBus, type CircleEvent } from './events.js';
import { defaultRunOptions, type RunOptions } from './run_options.js';
import type { CircleSettings } from './settings.js';
import { discoverSkills, loadSkillBody, type SkillInfo } from './skills.js';
import { fromJsonl, toSessionBundle } from './session_export.js';
import { projectDataDir, circleHome, normalizeWorkspace } from './paths.js';
import { repositoryWorktrees } from './worktrees.js';
import { KnowledgeConnection } from './knowledge/connection.js';
import {
  loadSessionMemory,
  formatSessionMemory,
  SESSION_MEMORY_BYTES,
  type SessionMemory,
} from './knowledge/session-memory.js';
import {
  connectionText,
  McpManager,
  mcpToolName,
  type McpStatus,
} from './mcp_loader.js';
import {
  mcpServersForRun,
  recordMcpjsonChoice,
  type McpEntry,
} from './mcp_config.js';
import { ExtensionHost, type SubagentSpec } from './extensions.js';
import {
  discoverSubagents,
  readSubagentFolder,
  type SubagentFileInfo,
  type SubagentPermissionMode,
} from './subagent_files.js';
import { abortable } from './watch.js';
import {
  isFolderTrusted,
  isReady,
  isRecord,
  loadSettings,
  loadCredentials,
  migrateMcpSettings,
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
import { FileRewindJournal } from './file_rewind.js';
import { FileSystemFileMutations } from './file_mutations_fs.js';
import { readFileBytes } from './file_access.js';
import { discoverWorkflows, type WorkflowSources } from './workflow_files.js';
import {
  prepareWorkflowScript,
  type PreparedScript,
} from './workflow_script.js';
import {
  AgentCallError,
  RUN_ID,
  WorkflowRun,
  agentStallMs,
  maxWorkflowAgents,
  readJournal,
  readRunRecord,
  realStallTimer,
  savedRuns,
  structuredOutputAttempts,
  workflowSummary,
  type AgentRequest,
  type AttemptHooks,
  type StallTimer,
  type WorkflowRunView,
} from './workflows.js';
import {
  ContextManager,
  restoredTodos,
  restoredPlanMode,
} from './context_middleware.js';
import { askQuestions } from './questions.js';
import type { SecretRequest } from './secret_prompt.js';
import type { CommandLauncher, CommandExecution } from './command_process.js';
import {
  jobReachable,
  JobRegistry,
  jobLine,
  outcomeWords,
  type Job,
} from './jobs.js';
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
import { migrateHookFiles } from './hook_migration.js';
import {
  combineOutcomes,
  HookRunner,
  loadHooks,
  type ConfiguredHook,
  type HookDefinition,
  stopHookCap,
  type HookLoadError,
} from './hooks.js';
const BUILTIN_TOOL_NAMES = new Set([
  'knowledge_search',
  'knowledge_read',
  'knowledge_write',
  'knowledge_share',
  'memory_write',
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
  'workflow',
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
  knowledgeAccess?: () => KnowledgeAccess;
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
  /** Where `skill_install` puts packs and `skill_run` runs them. Tests give their own. */
  localSkillsRoot?: string;
  /** How long an approval card waits, and a finished turn idles, before Notification hooks hear of it (ms). */
  notificationDelays?: { permission?: number; idle?: number };
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
  /** How a workflow agent's stall window is timed; tests give their own. */
  workflowStallTimer?: StallTimer;
  /** How long a stretch of a workflow script may run without waiting for an agent (ms). */
  workflowSliceMs?: number;
  catalog?: ModelCatalog;
  extraTools?: Tool[];
  /**
   * Tools left out of a short turn and added on the turn that needs them.
   * The terminal keeps browser tool schemas here until a page is requested.
   */
  deferredTools?: Tool[];
  /**
   * A PNG of the page a session's browser shows, for an after_tool hook that asks for one (`screenshot`); the front
   * end that owns the browser gives it. Never starts a browser.
   */
  hookScreenshot?: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<Buffer | undefined>;
  /** Where the extensions that ship with Circle are; false for none (tests). */
  bundledExtensions?: string | false;
  /** An extension's status line changed. */
  onExtensionStatus?: () => void;
  /** An MCP server's status changed between reloads: a sign-in finished or failed, or a server went away. */
  onMcpStatus?: () => void;
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
/** What one message to a running subagent may hold, and how many may wait for it. */
export const SEND_MAX_CHARS = 4000;
export const SEND_MAX_WAITING = 8;

/** The prompt file of each subagent that ships with Circle, in `prompts/agent`. */
export const BUILTIN_SUBAGENT_PROMPTS: Readonly<Record<string, string>> = {
  'general-purpose': 'general-purpose.md',
  explore: 'explore.md',
  plan: 'plan.md',
};
/** What `task` and `/agents` say of each subagent that ships with Circle. */
const BUILTIN_SUBAGENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'general-purpose': 'General coding tasks.',
  explore: 'Read-only project exploration.',
  plan: 'Read-only research before a plan: how the code works now and what a change would touch.',
};
/** Built-ins that only read: they get the read-only tools and run in read-only mode. */
const READ_ONLY_BUILTINS = new Set(['explore', 'plan']);
/** Tools no subagent gets, whatever its definition lists: they ask the person, or act on the conversation itself. */
const NOT_FOR_SUBAGENTS = new Set([
  'question',
  'plan_enter',
  'plan_exit',
  'compact_conversation',
  'workflow',
]);
/** The largest workflow script a call may name by its path. */
const MAX_WORKFLOW_SCRIPT_BYTES = 1024 * 1024;
/** The type a workflow's agent has when its script names none: its prompt is `prompts/agent/workflow.md`. */
export const WORKFLOW_AGENT = 'workflow';
/** The tool a workflow agent with a schema returns its value with. */
export const STRUCTURED_OUTPUT = 'structured_output';
const STRUCTURED_OUTPUT_PROMPT =
  'Your result goes back to the script as data: when your work is done, call structured_output once, with the result as its arguments, matching its schema. Text you write is not read.';
const STRUCTURED_OUTPUT_REMINDER =
  '<system-reminder>\nYou ended without calling structured_output. Call it now with your result as its arguments, matching its schema: it is the only way your result reaches the script.\n</system-reminder>';
/** The prompt of a workflow's own agents. */
function workflowAgentPrompt(
  dir = join(import.meta.dirname, 'prompts/agent'),
): string {
  return readFileSync(join(dir, 'workflow.md'), 'utf8');
}
/** What a workflow's run gives `task`'s path for one attempt of one agent. */
interface WorkflowLaunch {
  /** The run's job: the agent's cards wait under it, and its events carry it. */
  jobId: string;
  run: string;
  label: string;
  model?: string;
  effort?: string;
  schema?: Record<string, unknown>;
  /** Tries the agent has to return a value that fits `schema`. */
  attempts: number;
  /** Every event of the agent's own conversation, as it happens. */
  observe(event: CircleEvent): void;
  session(id: string): void;
  /** What structured_output was given. */
  value?: unknown;
  /** Set when the tries ran out: the call fails with it. */
  failure?: AgentCallError;
}
/** A positive whole number from the environment, or the default. */
function countFrom(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return value?.trim() && Number.isInteger(number) && number > 0
    ? number
    : fallback;
}
/** How many layers of subagents may run below the conversation (`CIRCLE_MAX_SUBAGENT_SPAWN_DEPTH`); 1 is no nesting. */
export function maxSubagentDepth(env: NodeJS.ProcessEnv = process.env): number {
  return countFrom(env.CIRCLE_MAX_SUBAGENT_SPAWN_DEPTH, 3);
}
/** How many subagents may run at once for one conversation (`CIRCLE_MAX_CONCURRENT_SUBAGENTS`). */
export function maxConcurrentSubagents(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return countFrom(env.CIRCLE_MAX_CONCURRENT_SUBAGENTS, 20);
}
/**
 * The approval a subagent works under. The conversation's `accept-edits` and `auto` hold for it whatever its
 * definition says; under `manual` its `permissionMode` decides, except that `bypassPermissions` and `auto` (a mode
 * Circle does not have) keep `manual`.
 */
export function subagentApproval(
  conversation: ApprovalMode,
  wanted: SubagentPermissionMode | undefined,
): { mode: ApprovalMode; readOnly: boolean; dontAsk: boolean } {
  if (conversation !== 'manual' || !wanted)
    return { mode: conversation, readOnly: false, dontAsk: false };
  return {
    mode: wanted === 'acceptEdits' ? 'accept-edits' : 'manual',
    readOnly: wanted === 'plan',
    dontAsk: wanted === 'dontAsk',
  };
}
/** A subagent's own `task`: the subagents it starts run in the foreground, so it is not offered `background`. */
function foregroundTask(tool: Tool): Tool {
  const parameters = tool.parameters as {
    properties?: Record<string, unknown>;
  };
  const { background: _background, ...properties } =
    parameters.properties ?? {};
  return { ...tool, parameters: { ...tool.parameters, properties } };
}
/** One subagent as `/agents` shows it. */
export interface SubagentListing {
  name: string;
  description: string;
  source: string;
  model?: string;
  effort?: string;
  tools?: string[];
  path?: string;
  disallowedTools?: string[];
  permissionMode?: string;
  maxTurns?: number;
  /** Skills loaded into its conversation before its task. */
  skills?: string[];
  /** Those of them that are not installed: they are left out. */
  missingSkills?: string[];
  mcpServers?: string[];
  /** The events its own hooks run at. */
  hooks?: string[];
  /** Why its hooks do not run: hooks are off, or its project folder is not trusted. */
  hooksHeld?: string;
  background?: boolean;
  /** Keys it has that Circle reads and does not apply yet, with their values. */
  unsupported?: string[];
  /** Keys a pack's definition has that are not read for a pack. */
  ignored?: string[];
  /** Values it sets that are not applied, each with why. */
  notApplied?: string[];
}
/** One subagent a person, a pack or an extension defined, as `task` runs it. */
interface CustomSubagent {
  spec: SubagentSpec;
  /** Its allowlist; undefined for every tool a subagent may have. */
  tools?: Tool[];
  /** The tools of the MCP servers its definition names. */
  serverTools?: Tool[];
  /** Whether its `disallowedTools` take a tool, by the tool's name. */
  withholds?: (name: string) => boolean;
  source: string;
  path?: string;
  /** What its file says beyond the spec; absent for an extension's. */
  file?: SubagentFileInfo;
}
/** A built-in subagent's own prompt. A missing file is an error that names it, never another agent's prompt (#547). */
export function builtinSubagentPrompt(
  name: string,
  dir = join(import.meta.dirname, 'prompts/agent'),
): string {
  const file = BUILTIN_SUBAGENT_PROMPTS[name];
  if (!file) throw new Error(`unknown subagent type: ${name}`);
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    throw new Error(
      `the built-in ${name} subagent has no prompt: prompts/agent/${file} is missing`,
    );
  }
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
  /**
   * The conversation's file journal, for a Circle that writes straight to the host
   * filesystem: the terminal, line mode, print mode and RPC. The desktop brings its own
   * backend and its own journal, so this stays unset there.
   */
  readonly fileRewind?: FileRewindJournal;
  /** How `buildTools` records a direct write into the journal. */
  private readonly captures?: <T>(
    paths: string[],
    signal: AbortSignal,
    write: () => T | Promise<T>,
  ) => Promise<T>;
  readonly bus = new EventBus();
  readonly sandbox: Sandbox;
  /** What the editor the person uses knows, once the bridge is open. */
  readonly editorBridge: EditorBridge;
  readonly jobs: JobRegistry;
  /** Hides secrets' values in what the model reads, from calls and background jobs. */
  readonly redact: Redactor;
  readonly catalog: ModelCatalog;
  private childJobOwners = new Map<string, import('./jobs.js').JobOwner>();
  /**
   * The running background subagents of this session that a message can reach:
   * the job id to the harness that is reading it. A channel exists while the job
   * runs, so a message never reaches a session that is not there to read it.
   */
  private channels = new Map<
    string,
    { harness: Harness; waiting: number; sent: string[] }
  >();
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
  hookListing(): {
    hook: ConfiguredHook;
    active: boolean;
    spent: boolean;
  }[] {
    return this.ensureHooks().listing();
  }
  readonly mcp: McpManager;
  readonly knowledge: KnowledgeConnection;
  private sessionMemory?: SessionMemory;
  private memorySession?: string;
  private memoryLoading?: Promise<void>;
  private memoryPrompt = '';
  get sessionMemoryContext(): string {
    return this.memoryPrompt;
  }
  get sessionMemoryStatus() {
    return {
      bytes: Buffer.byteLength(this.memoryPrompt),
      truncated:
        !!this.sessionMemory?.documents.length &&
        (!this.memoryPrompt ||
          /memory truncated|memory omitted/.test(this.memoryPrompt)),
    };
  }
  get knowledgeSignal(): AbortSignal {
    return this.integrationLifetime.signal;
  }
  get loadedSessionMemory(): SessionMemory | undefined {
    return this.sessionMemory ? structuredClone(this.sessionMemory) : undefined;
  }
  readonly lsp: LspManager;
  readonly context: ContextManager;
  private compactionController?: AbortController;
  private activeCompaction?: Promise<string>;
  extensions: ExtensionHost;
  private integrationsReady?: Promise<void>;
  /** The subagents the agent folders define, read again with every system prompt. */
  private fileAgents: SubagentFileInfo[] = [];
  private fileAgentProblems: string[] = [];
  /** The subagents the installed packs define in their `agents` folders (#552), named `<pack>:<name>`. */
  private packAgents: (SubagentFileInfo & { pack: string })[] = [];
  private packAgentProblems: string[] = [];
  private extensionChanges = new Map<string, Promise<void>>();
  private extensionChangeListeners = new Set<() => void>();
  private readonly integrationLifetime = new AbortController();
  private baseModel?: ChatModel;
  private readonly modelWrappers = new WeakMap<ChatModel, ChatModel>();
  private readonly wrappedModels = new WeakSet<ChatModel>();
  private authFingerprint?: string;
  private coreTools: Tool[] = [];
  private deferredKnowledgeTools: Tool[] = [];
  // An extension changed its tools after loading; applied between turns, never inside one.
  private toolsStale = false;
  private toolsCheck?: ReturnType<typeof setTimeout>;
  get allTools(): Tool[] {
    return this.withIntegrationTools(
      [
        ...this.coreTools,
        ...this.deferredKnowledgeTools.filter(
          (tool) => !this.coreTools.some((have) => have.name === tool.name),
        ),
      ],
      false,
    );
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
    // The editor bridge: a localhost MCP server that stays closed until the
    // person opens it with /bridge start. It writes only through the sandbox.
    this.editorBridge = new EditorBridge(
      options.home,
      options.workspace,
      this.sandbox,
    );
    this.policy = defaultPolicy(
      options.workspace,
      options.home,
      this.sandbox.credentialFiles,
      (path) => this.sandbox.resolvePath(path),
      options.settings.allowed_commands,
    );
    // The plan folder takes this conversation's plan and nothing else
    this.sandbox.ownPlan = () => this.planFile;
    // Where file tools keep to the workspace (the desktop's backend), another checkout of
    // its repository counts as the workspace: read, searched and changed without a grant
    if (options.fileMutations) {
      this.sandbox.worktrees = () => repositoryWorktrees(options.workspace);
      this.policy.worktree = (path) => !!this.sandbox.worktreeRoot(path);
    }
    this.jobs = new JobRegistry(
      this.sandbox,
      (kind, job) => {
        if (kind === 'job_ended') this.userShells?.ended(job);
        // A background subagent's place frees when its job ends, also one stopped before it ran
        if (kind === 'job_ended' && job.kind === 'agent' && job.agent)
          this.runningSubagents.delete(job.agent);
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
      () => this.runSecrets(),
      () => this.runVariables(),
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
      // A server that asks for a sign-in gets one in the browser; what it gives is kept in this home
      home: this.options.home,
      openUrl: this.options.openUrl,
      readFile: (path, context, limit) =>
        readFileBytes(this.sandbox, fileReads, path, context, limit),
      // A server's question in the middle of a call is asked in the question panel (#556)
      ask: this.options.question
        ? (args, signal) => this.options.question!(args, signal)
        : undefined,
      // A server that went away leaves the system prompt between turns, as tools do
      onChange: () => {
        if (this.closing) return;
        this.toolsStale = true;
        this.scheduleToolRefresh();
        this.options.onMcpStatus?.();
      },
    });
    // MCP servers written in the list format before this one move into mcpServers once, the file kept beside
    try {
      this.mcp.notes = migrateMcpSettings(this.options.home);
    } catch (error) {
      this.mcp.notes = [
        `mcp_servers in settings.json could not be moved into mcpServers: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
    this.knowledge = new KnowledgeConnection(
      this.options.home,
      () => this.options.settings,
      () => loadSecrets(this.options.home),
      this.mcp,
      (authorizationChanged) => {
        if (this.closing) return;
        if (
          (authorizationChanged ||
            this.knowledge.status().condition === 'login-required') &&
          this.sessionMemory?.documents.some((d) => d.scope === 'team')
        ) {
          this.sessionMemory = {
            ...this.sessionMemory,
            documents: this.sessionMemory.documents.filter(
              (d) => d.scope !== 'team',
            ),
            warnings: [
              ...this.sessionMemory.warnings,
              'team memory authorization changed; it was removed',
            ],
          };
          this.toolsStale = true;
          this.scheduleToolRefresh();
        }
        if (!this.closing)
          this.bus.emit('info', {
            payload: { knowledge_sync: this.knowledge.status().condition },
          });
      },
    );
    this.policy.declareHints((tool) => this.mcp.hint(tool));
    this.lsp = new LspManager(this.sandbox);
    this.context = new ContextManager(this.store, this.sandbox.offloadRoot!, {
      readOnly: () => this.viewOnly,
      compactHooks: {
        before: (sessionId, trigger, hint, signal) =>
          this.preCompactHooks(sessionId, trigger, hint, signal),
        after: (sessionId, trigger, summary) =>
          this.postCompactHooks(sessionId, trigger, summary),
      },
      progress: (event) => {
        const owner = this.childJobOwners.get(event.sessionId);
        // The background job a subagent works under, its own or one above it
        const job =
          this.childHarnesses.get(event.sessionId)?.job() ??
          (owner?.parent && owner.parent !== event.sessionId
            ? owner.parent
            : undefined);
        this.bus.emit('compaction', {
          payload: { ...event },
          ...(event.sessionId !== this.session.id
            ? {
                tags: {
                  subagent: event.sessionId,
                  ...(job ? { job_id: job } : {}),
                },
                parent_run_id: owner?.sessionId ?? this.session.id,
              }
            : {}),
        });
      },
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
    // Without a native backend the tools write to the host filesystem, so this runtime
    // keeps the journal itself, in the conversation's own database: /rewind still knows
    // the turn after Circle restarts.
    this.fileRewind = options.fileMutations
      ? undefined
      : new FileRewindJournal(new FileSystemFileMutations(this.sandbox), {
          session: () => this.session.id,
          ledger: () => this.store,
        });
    this.captures = this.fileRewind
      ? (paths, signal, write) => this.fileRewind!.capture(paths, signal, write)
      : undefined;
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
    // A turn's file changes are recorded under the message that started it, as on the
    // desktop. A subagent's runs belong to its own conversation, and a background job
    // that ends after its turn finds none open, so nothing is recorded for it.
    this.bus.subscribe((event) => {
      if (!this.fileRewind || event.tags.subagent) return;
      if (event.kind === 'run_start') {
        const user = this.store
          .tree(this.session.id)
          .findLast(
            (node) => node.message?.role === 'user' && !node.message.internal,
          );
        if (user) this.fileRewind.beginTurn(user.id);
      } else if (event.kind === 'run_end' || event.kind === 'run_error')
        this.fileRewind.endTurn();
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
    // The tools a loaded pack declared belong to the session that loaded it
    this.packTools = [];
    this.packToolNotes = new Map();
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
      knowledge: new KnowledgeService(
        this.options.home,
        this.options.knowledgeAccess,
      ),
      knowledgeShare: (args, signal) =>
        prepareKnowledgeShare({
          service: new KnowledgeService(
            this.options.home,
            this.options.knowledgeAccess,
          ),
          connection: this.knowledge,
          binding: () => this.options.settings.knowledge_sync.binding,
          snapshot: String(args.snapshot),
          object: String(args.object),
          ...(typeof args.team_path === 'string'
            ? { teamPath: args.team_path }
            : {}),
          signal,
        }),
      fileMutations: this.options.fileMutations,
      captures: this.captures,
      jobs: this.jobs,
      sendToJob: (context, jobId, message) =>
        this.sendToJob(context, jobId, message),
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
      localSkills: {
        home: this.options.home,
        settings: () => this.options.settings,
        secrets: () => this.runSecrets(),
        variables: () => this.runVariables(),
        ...(this.options.localSkillsRoot
          ? { root: this.options.localSkillsRoot }
          : {}),
        // Paths in a pack differ in more than case (its manifest refuses others), and a case-blind disk opens
        // `tools/Convert.mjs` as `tools/convert.mjs`
        // Only a script whose typed tool the caller has is sent to it
        typed: (pack, script, sessionId) => {
          const name = this.packTools.find(
            (item) =>
              item.pack === pack &&
              item.script.toLowerCase() === script.toLowerCase(),
          )?.tool.name;
          const tools =
            (sessionId && this.childHarnesses.get(sessionId)?.harness.tools) ||
            this.harness.tools;
          return name && tools.some((tool) => tool.name === name)
            ? name
            : undefined;
        },
      },
      screenshot:
        this.options.screenshot === false
          ? undefined
          : (this.options.screenshot ?? (canScreenshot() ? {} : undefined)),
      todos: (todos) => {
        this.todos = todos;
        this.bus.emit('todo_list', { payload: { todos } });
      },
      skill: async (name, signal, reference, context) => {
        // A skill that cannot be read is not loaded: nothing of it starts
        const body = loadSkillBody(
          name,
          this.skills,
          reference,
          this.sandbox.credentialFiles,
        );
        const tools = await this.activateSkillHooks(
          name,
          signal,
          context?.sessionId,
        );
        return tools ? `${body}\n\n${tools}` : body;
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
      task: (args, context) => this.runTask(args, context, vision),
      workflow: (args, context) => this.prepareWorkflow(args, context),
    });
    tools.push(this.lsp.tool());
    tools = this.classifyCoreTools(tools);
    tools.push(...(this.options.extraTools ?? []));
    // The editor tools are in the list when the person turned them on, not when
    // the listener happens to be open: a closed bridge says so in its answer, and
    // opening or closing it changes nothing else about the session.
    if (this.options.settings.editor_bridge)
      tools.push(...this.editorBridge.modelTools());
    // The local knowledge store is part of the local context: with it, every knowledge
    // tool is listed from the first request; an isolated embedder lists them after use.
    this.deferredKnowledgeTools =
      this.options.localContext === false
        ? tools.filter(deferredKnowledgeTool)
        : [];
    tools = tools.filter((tool) => !this.deferredKnowledgeTools.includes(tool));
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
      variables: () => this.runVariables(),
      secrets: () => this.runSecrets(),
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
      approve: this.options.approve
        ? async (call: ToolCall, signal: AbortSignal) =>
            this.noticeWaiting(call, () => this.options.approve!(call, signal))
        : undefined,
      hooks: this.ensureHooks(),
      hookScreenshot: this.options.hookScreenshot,
      backgroundTasks: () => this.backgroundTasks(),
      ...(this.nextSessionSource
        ? { sessionSource: this.nextSessionSource }
        : {}),
      priceUsage: (model, usage) =>
        priceCall(this.catalog.facts(model, this.options.settings), usage),
      beforeRun: async (signal) => {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
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
        this.promoteKnowledgeTools();
        this.promoteDeferredTools(prompt);
      },
      beforeStep: () => {
        this.knowledge.checkAuthorization();
        this.promoteKnowledgeTools();
        if (
          this.sessionMemory ||
          existsSync(join(this.options.home, 'knowledge', 'knowledge.sqlite'))
        )
          this.refreshSystemPrompt();
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
      settled: () => {
        this.releaseIfAway();
        this.waitForInput();
      },
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
  /**
   * `task`: one subagent, run to its report. The conversation starts it, or a subagent starts one of its own while
   * the depth limit allows. Every layer works for the conversation: hooks, processes and MCP servers hear its
   * session, its rules decide the calls, and each subagent is a session of its own under the one that started it.
   */
  private async runTask(
    args: Record<string, unknown>,
    context: ToolContext,
    vision: VisionConnection | undefined,
    launch?: WorkflowLaunch,
  ): Promise<string> {
    context.signal.throwIfAborted();
    if (this.ownershipError) throw this.ownershipError;
    if (this.closing || this.deleting) throw new Error('session is closing');
    // Who asks: the conversation, or a subagent that starts one of its own
    const spawner = this.childHarnesses.get(context.sessionId);
    const root = spawner?.parent ?? context.sessionId;
    const depth = (spawner?.depth ?? 0) + 1;
    const maxDepth = maxSubagentDepth();
    if (depth > maxDepth)
      throw new Error(
        `a subagent at the depth limit of ${maxDepth} cannot start another`,
      );
    const name = String(args.subagent_type || 'general-purpose');
    const description = String(args.description || '');
    // As the folders hold them now: one written this step is found, and one a replaced pack took away is not
    this.loadSubagentFiles();
    const custom = this.customSubagents().find(
      (agent) => agent.spec.name === name,
    );
    if (
      !custom &&
      !Object.hasOwn(BUILTIN_SUBAGENT_PROMPTS, name) &&
      !(launch && name === WORKFLOW_AGENT)
    ) {
      this.describeSubagents(this.harness.tools);
      throw new Error('unknown subagent type');
    }
    // A workflow's agents keep to the run's own limit, not to this one
    const limit = maxConcurrentSubagents();
    const running = [...this.runningSubagents.values()].filter(
      (owner) => owner === root,
    ).length;
    if (!launch && running >= limit)
      throw new Error(
        `Concurrent subagent limit reached: ${limit} subagents are running for this conversation. Do not retry this call: do the work yourself, or delegate it once a running subagent has finished.`,
      );
    const file = custom?.file;
    const caller = spawner?.harness ?? this.harness;
    // A subagent without a model of its own runs on the model of the one that started it; a workflow's script
    // can name one for the call, which comes first
    const ownModel = launch?.model ?? custom?.spec.model;
    const childModel = ownModel
      ? this.modelWithSearch(this.gatewayModel(this.options.settings, ownModel))
      : this.wrapModel(caller.model);
    const session = this.store.create(
      this.options.workspace,
      childModel.model,
      `${name}: ${description}`.slice(0, 160),
      undefined,
      context.sessionId,
    );
    // Its place counts until it ends, here or as a job
    if (!launch) this.runningSubagents.set(session.id, root);
    launch?.session(session.id);
    try {
      const parentState = this.store.contextState(context.sessionId);
      this.childJobOwners.set(session.id, {
        sessionId: root,
        parent: session.id,
        startedBy: 'model',
      });
      this.store.setContextState(context.sessionId, {
        ...parentState,
        subagentSessionIds: [
          ...new Set([...(parentState.subagentSessionIds ?? []), session.id]),
        ],
      });
      const childBus = new EventBus(session.id);
      let backgroundJob: Job | undefined;
      let backgroundLog: ((text: string) => void) | undefined;
      // The job a card waits under: its own, the one of the background subagent it works under, or its workflow's
      const jobOf = (): string | undefined =>
        launch?.jobId ?? backgroundJob?.id ?? spawner?.job();
      // A workflow agent with a schema returns its value with structured_output, within so many tries
      let structuredTries = 0;
      let structuredError = '';
      const structuredFailure = (why: string): AgentCallError =>
        new AgentCallError(
          `the agent's output did not fit its schema after ${structuredTries} ${structuredTries === 1 ? 'try' : 'tries'}: ${why}`,
        );
      const interact = async <T>(
        action: (origin: InteractionContext) => Promise<T>,
      ): Promise<T> => {
        const jobId = jobOf();
        // what the job said it was doing comes back once the answer is in
        const before = jobId ? this.jobs.get(jobId)?.detail : undefined;
        if (jobId) this.jobs.activity(jobId, 'waiting for you');
        try {
          return await action({ jobId, name, agent: session.id });
        } finally {
          if (jobId)
            this.jobs.activity(
              jobId,
              before && before !== 'waiting for you' ? before : 'working',
            );
        }
      };
      childBus.subscribe((event) => {
        launch?.observe(event);
        // A call that does not fit the schema is refused before it runs: each refusal is one try
        if (
          launch?.schema &&
          event.kind === 'tool_result' &&
          event.payload.name === STRUCTURED_OUTPUT &&
          event.payload.status === 'error' &&
          launch.value === undefined
        ) {
          structuredTries++;
          structuredError = String(event.payload.output ?? '');
          if (structuredTries >= launch.attempts && !launch.failure) {
            launch.failure = structuredFailure(structuredError);
            void child.cancel();
          }
        }
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
        // A subagent that works under a background job, its own or one above it, is that job's work
        const jobId = jobOf();
        this.bus.emit(event.kind, {
          payload: event.payload,
          usage: event.usage,
          tags: {
            subagent: session.id,
            name,
            ...(jobId ? { job_id: jobId } : {}),
            ...(launch
              ? {
                  job_id: launch.jobId,
                  workflow: launch.run,
                  label: launch.label,
                }
              : {}),
          },
          parent_run_id: context.sessionId,
        });
      });
      const builtinReadOnly = !custom && READ_ONLY_BUILTINS.has(name);
      const withholds = custom?.withholds ?? (() => false);
      const serverTools = custom?.serverTools ?? [];
      // The tools this subagent may have: now, and those a skill it loads adds later
      const allows = (tool: Tool): boolean =>
        tool.subagents !== false &&
        !NOT_FOR_SUBAGENTS.has(tool.name) &&
        (tool.name !== 'task' || depth < maxDepth) &&
        (!builtinReadOnly || EXPLORE_TOOLS.has(tool.name)) &&
        (!custom?.tools ||
          custom.tools.some((item) => item.name === tool.name) ||
          serverTools.some((item) => item.name === tool.name)) &&
        !withholds(tool.name);
      const pool = custom?.tools
        ? [
            ...custom.tools,
            ...serverTools.filter((tool) => !custom.tools!.includes(tool)),
          ]
        : this.allTools;
      const childTools = pool.filter(allows);
      const jobTools = buildTools(this.sandbox, {
        fileMutations: this.options.fileMutations,
        captures: this.captures,
        jobs: this.jobs,
        sendToJob: (context, jobId, message) =>
          this.sendToJob(context, jobId, message),
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
          sessionId: root,
          parent: backgroundJob?.id ?? session.id,
          startedBy: 'model',
        }),
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
            : tool.name === 'task'
              ? foregroundTask(tool)
              : ['execute', 'list_jobs', 'stop_job', 'wait_jobs'].includes(
                    tool.name,
                  )
                ? jobTools.find((jobTool) => jobTool.name === tool.name)!
                : tool,
        ),
      );
      // How a workflow agent with a schema hands back its value: the schema is the tool's own
      if (launch?.schema)
        ownedChildTools.push({
          name: STRUCTURED_OUTPUT,
          description:
            'Return your result to the script that started you: call this once, when your work is done, with the result as the arguments. A call that does not fit the schema is refused with the reason; call it again with corrected arguments. Text you write is not read.',
          parameters: launch.schema,
          effect: 'read',
          approval: false,
          variables: false,
          run: async (args) => {
            launch.value = structuredClone(args);
            // Nothing is left for it to do: its turn ends with this call
            child.endTurnAfterCalls();
            return 'Your result is recorded. Your work is done.';
          },
        });
      // Its permission mode, decided again for each call: the conversation's can change while it works
      const wanted = file?.permissionMode;
      const approval = () => subagentApproval(this.policy.mode(root), wanted);
      // A read-only conversation, or a read-only subagent that started this one, keeps it read-only
      const callerReadOnly = (): boolean =>
        spawner ? spawner.harness.readOnly : this.harness.planMode;
      // Its own hooks, for its calls and its stop: a project's definition waits for its folder to be trusted
      const agentHooks =
        file?.hooks?.length && !this.agentHooksHeld(file)
          ? file.hooks
          : undefined;
      const child: Harness = new Harness({
        commandExecution: {
          epoch: this.jobs.runName,
          forCall: (sessionId, callId) =>
            this.jobs.executionFor(sessionId, callId),
        },
        variables: () => this.runVariables(),
        secrets: () => this.runSecrets(),
        redact: this.redact,
        model: childModel,
        // Hooks, MCP servers and its processes hear the conversation's session, with this one as the agent's
        agent: { sessionId: root, type: name },
        // A depth of its own: the workflow call's or the definition's, unless the run's CIRCLE_REASONING_EFFORT
        // says otherwise (#549)
        ...((launch?.effort ?? custom?.spec.effort)
          ? {
              effort: defaultEffort(
                this.options.settings.auth.protocol,
                (launch?.effort ?? custom?.spec.effort)!,
              ),
            }
          : {}),
        ...(agentHooks ? { agentHooks } : {}),
        ...(wanted
          ? {
              approvalMode: () => approval().mode,
              dontAsk: () => approval().dontAsk,
            }
          : {}),
        ...(file?.maxTurns ? { maxTurns: file.maxTurns } : {}),
        tools: ownedChildTools,
        store: this.store,
        session,
        policy: this.policy,
        system:
          (custom?.spec.system_prompt ??
            (launch && name === WORKFLOW_AGENT
              ? workflowAgentPrompt()
              : builtinSubagentPrompt(name))) +
          (launch?.schema ? '\n\n' + STRUCTURED_OUTPUT_PROMPT : '') +
          '\n' +
          this.harness.system,
        bus: childBus,
        approve: this.options.approve
          ? (call, signal) =>
              this.noticeWaiting(call, () =>
                interact((origin) =>
                  this.options.approve!(call, signal, origin),
                ),
              )
          : undefined,
        hooks: this.ensureHooks(),
        hookScreenshot: this.options.hookScreenshot,
        sessionHooks: false,
        headless: this.options.headless,
        approvalSessionId: root,
        priceUsage: (model, usage) =>
          priceCall(this.catalog.facts(model, this.options.settings), usage),
        parentPlanMode: () =>
          callerReadOnly() || (wanted !== undefined && approval().readOnly),
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
          this.context
            .prepare(
              session.id,
              child.model,
              child.system,
              child.tools,
              signal,
              true,
            )
            .then((messages) => {
              // Read means this: the message is in the request that goes to the
              // model now. Its row exists from the moment it was queued, so the
              // store says nothing about whether the subagent has met it yet.
              const job = backgroundJob;
              const channel = job ? this.channels.get(job.id) : undefined;
              if (job && channel?.waiting) {
                channel.sent = channel.sent.filter(
                  (mark) =>
                    !messages.some((message) =>
                      String(message.content ?? '').includes(`about="${mark}"`),
                    ),
                );
                channel.waiting = channel.sent.length;
                this.jobs.pending(job.id, channel.waiting);
              }
              return messages;
            }),
      });
      child.planMode = builtinReadOnly;
      const runChild = async (signal: AbortSignal): Promise<string> => {
        const abort = (): void => {
          void child.cancel();
        };
        signal.addEventListener('abort', abort, { once: true });
        // While it runs, a skill it loads can add its pack's tools to it, and it can start subagents of its own
        this.childHarnesses.set(session.id, {
          harness: child,
          allows,
          type: name,
          parent: root,
          depth,
          job: jobOf,
        });
        const agent = { sessionId: root, id: session.id, type: name };
        try {
          signal.throwIfAborted();
          // SubagentStart hooks (#557): what they say back starts its conversation
          await this.subagentStartHooks(child, agent, description, signal);
          // The skills its definition names are in its conversation before its task, as if it had loaded them
          await this.preloadSkills(file?.skills ?? [], session.id, signal);
          let { answer } = await child.run(description);
          // SubagentStop hooks can send it back to work, a few times in a row at most, while it has turns left
          for (let again = 0; ; again++) {
            const next = await this.subagentStopHooks(
              child,
              agent,
              answer,
              again > 0,
              signal,
              agentHooks,
            );
            if (next === undefined || child.stoppedAtTurnLimit) break;
            if (again >= stopHookCap()) {
              child.hookContext(
                {
                  ...combineOutcomes('SubagentStop', [], undefined, {}),
                  notices: [{ kind: 'limit', name: 'SubagentStop' }],
                },
                'SubagentStop',
              );
              break;
            }
            ({ answer } = await child.run(next));
          }
          // A workflow agent with a schema hands its value back through structured_output: one that ends without
          // calling it is told again, within its tries
          while (launch?.schema && launch.value === undefined) {
            if (launch.failure) throw launch.failure;
            structuredTries++;
            if (child.stoppedAtTurnLimit || structuredTries >= launch.attempts)
              throw structuredFailure(
                structuredError || 'it ended without calling structured_output',
              );
            structuredError = 'it ended without calling structured_output';
            ({ answer } = await child.run(STRUCTURED_OUTPUT_REMINDER));
          }
          return child.stoppedAtTurnLimit
            ? `Partial result: this subagent used its ${file?.maxTurns} turns (maxTurns) before it finished.\n\n${answer.trim() || '(it wrote no report)'}`
            : answer;
        } finally {
          signal.removeEventListener('abort', abort);
          await this.jobs.stopOwned(backgroundJob?.id ?? session.id);
          this.childJobOwners.delete(session.id);
          this.childHarnesses.delete(session.id);
          this.runningSubagents.delete(session.id);
        }
      };
      // A subagent's own subagents run in the foreground: it waits for each report
      if (
        !spawner &&
        !launch &&
        (args.background === true || file?.background === true)
      ) {
        context.signal.throwIfAborted();
        const job = this.jobs.startAgent(
          `${name}: ${description}`,
          { sessionId: root, startedBy: 'model' },
          async (signal, log, job) => {
            backgroundJob = job;
            this.childJobOwners.set(session.id, {
              sessionId: root,
              parent: job.id,
              startedBy: 'model',
            });
            // Open only now: before this call there is no job id to answer to, and
            // after it the harness is there to take the message.
            this.channels.set(job.id, {
              harness: child,
              waiting: 0,
              sent: [],
            });
            backgroundLog = log;
            try {
              return await runChild(signal);
            } finally {
              // A message the subagent never reached stays in that session's
              // queue, where its own transcript shows it. Nothing here pretends a
              // delivery that did not happen, and no count survives the job.
              this.channels.delete(job.id);
              this.jobs.pending(job.id, 0);
            }
          },
          session.id,
        );
        return `In background: ${jobLine(job)}. The subagent report will arrive as a notice; do not poll or sleep.`;
      }
      return await runChild(context.signal);
    } catch (error) {
      this.runningSubagents.delete(session.id);
      this.childJobOwners.delete(session.id);
      throw error;
    }
  }
  /**
   * The skills a definition preloads, in its conversation before its task: each loaded as the `skill` tool loads it,
   * its hooks and its pack's tools included. One that is not installed is left out, and `/agents` says so.
   */
  private async preloadSkills(
    names: string[],
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    for (const name of names) {
      let body: string;
      try {
        body = loadSkillBody(
          name,
          this.skills,
          undefined,
          this.sandbox.credentialFiles,
        );
      } catch {
        continue;
      }
      const tools = await this.activateSkillHooks(name, signal, sessionId);
      signal.throwIfAborted();
      this.store.append(sessionId, [
        {
          id: randomUUID(),
          role: 'user',
          internal: 'skill',
          content:
            `[Circle system] Skill \`${name}\` is preloaded for this task. Follow it.\n\n${body}` +
            (tools ? `\n\n${tools}` : ''),
        },
      ]);
    }
  }
  /** The workflow runs this runtime started, by id: the engine and its job. */
  private workflowRuns = new Map<string, { run: WorkflowRun; job?: string }>();
  /** Where a project's workflow runs keep their scripts, journals, records and results. */
  get workflowRunsFolder(): string {
    return join(
      this.sandbox.offloadRoot ??
        projectDataDir(this.options.workspace, this.options.home),
      WORKFLOW_RUNS_FOLDER,
    );
  }
  /** Where installed packs are: the folders `skill_install` puts them in. */
  private packsRoot(): string {
    return (
      this.options.localSkillsRoot ??
      join(this.options.userHome ?? homedir(), '.agents', 'skills')
    );
  }
  /** The saved workflows, as their folders hold them now, and why a file was passed over. */
  savedWorkflows(): WorkflowSources {
    return this.options.localContext === false
      ? { workflows: [], problems: [] }
      : discoverWorkflows({
          workspace: this.options.workspace,
          home: this.options.home,
          packsRoot: this.packsRoot(),
        });
  }
  /** The runs the folder keeps for a conversation, read again when two seconds old: a list open reads often. */
  private keptRuns?: { sessionId: string; at: number; runs: WorkflowRunView[] };
  /** This conversation's workflow runs, newest first: those running here and those its folder keeps. */
  workflowRunViews(sessionId = this.session.id): WorkflowRunView[] {
    const live = [...this.workflowRuns.values()]
      .map((entry) => entry.run.view)
      .filter((view) => view.sessionId === sessionId);
    if (
      this.keptRuns?.sessionId !== sessionId ||
      Date.now() - this.keptRuns.at > 2000
    )
      this.keptRuns = {
        sessionId,
        at: Date.now(),
        runs: savedRuns(this.workflowRunsFolder, sessionId),
      };
    const kept = this.keptRuns.runs.filter(
      (record) => !live.some((view) => view.id === record.id),
    );
    return [...live, ...kept].sort((a, b) => b.started - a.started);
  }
  /** Stops a run and every agent it started; its notice says it was stopped. */
  async stopWorkflow(id: string, reason = 'user'): Promise<boolean> {
    const job = this.workflowRuns.get(id)?.job;
    if (!job || this.jobs.get(job)?.status !== 'running') return false;
    await this.jobs.stop(job, reason);
    return true;
  }
  /** Stops one agent of a run: the script gets null for it, and a relaunch runs it again. */
  stopWorkflowAgent(id: string, index: number): boolean {
    return this.workflowRuns.get(id)?.run.stopAgent(index) ?? false;
  }
  /** Why an agent type cannot be a workflow agent's, or nothing. */
  private workflowAgentType(name: string): string | undefined {
    if (
      name === WORKFLOW_AGENT ||
      Object.hasOwn(BUILTIN_SUBAGENT_PROMPTS, name)
    )
      return undefined;
    this.loadSubagentFiles();
    return this.customSubagents().some((agent) => agent.spec.name === name)
      ? undefined
      : `agentType ${name} is not a subagent this session has; /agents lists them`;
  }
  /**
   * `workflow`, before anyone is asked: the script the call names, read and checked, and its meta for the card.
   * What was read here is what starts once the call is allowed.
   */
  private async prepareWorkflow(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<PreparedRun> {
    if (this.childHarnesses.has(context.sessionId))
      throw new Error('a subagent cannot start a workflow');
    const text = (key: string): string | undefined =>
      typeof args[key] === 'string' && (args[key] as string).trim()
        ? (args[key] as string).trim()
        : undefined;
    const name = text('name');
    const path = text('script_path');
    const inline =
      typeof args.script === 'string' && args.script.trim()
        ? args.script
        : undefined;
    const resume = text('resume_from_run_id');
    if ([name, path, inline].filter((value) => value !== undefined).length > 1)
      throw new Error('give one of name, script and script_path');
    let previous:
      | {
          id: string;
          events: ReturnType<typeof readJournal>;
          agents: WorkflowRunView['agents'];
        }
      | undefined;
    if (resume) {
      const record = RUN_ID.test(resume)
        ? readRunRecord(join(this.workflowRunsFolder, resume))
        : undefined;
      if (!record || record.sessionId !== context.sessionId)
        throw new Error(
          `nothing to resume: this conversation has no workflow run ${resume}`,
        );
      if (this.workflowRuns.get(resume)?.run.view.status === 'running')
        throw new Error(
          `run ${resume} is still running, or its agents have not exited yet: stop it, wait for its notice, then relaunch it`,
        );
      const events = readJournal(
        join(this.workflowRunsFolder, resume, 'journal.jsonl'),
      );
      if (!events.length)
        throw new Error(
          `nothing to resume: run ${resume} saved no agent results; start the workflow over as a new run`,
        );
      previous = { id: resume, events, agents: record.agents };
    }
    let source: string;
    let file: string;
    let saved: string | undefined;
    if (name) {
      const sources = this.savedWorkflows();
      const found = sources.workflows.find(
        (workflow) => workflow.name === name,
      );
      if (!found)
        throw new Error(
          `no saved workflow is named ${name}` +
            (sources.workflows.length
              ? `; saved: ${sources.workflows.map((workflow) => workflow.name).join(', ')}`
              : ''),
        );
      source = readFileSync(found.path, 'utf8');
      file = saved = found.path;
    } else if (inline !== undefined) {
      source = inline;
      file = 'script.js';
    } else if (path) {
      // Read as read_file reads it: with the desktop's backend, a file outside the workspace only with a grant
      const read = await readFileBytes(
        this.sandbox,
        this.options.fileMutations
          ? new FileMutationTools(this.sandbox, this.options.fileMutations)
          : undefined,
        path,
        context,
        MAX_WORKFLOW_SCRIPT_BYTES,
      );
      source = read.bytes.toString('utf8');
      file = path;
    } else if (previous) {
      source = readFileSync(
        join(this.workflowRunsFolder, previous.id, 'script.js'),
        'utf8',
      );
      file = `/${WORKFLOW_RUNS_FOLDER}/${previous.id}/script.js`;
    } else throw new Error('give name, script or script_path');
    const prepared = prepareWorkflowScript(source, file);
    const start = async (
      _args: Record<string, unknown>,
      approved: ToolContext,
    ): Promise<string> =>
      this.startWorkflow(prepared, {
        sessionId: approved.sessionId,
        ...(args.args !== undefined ? { args: args.args } : {}),
        ...(path ? { path } : {}),
        ...(previous ? { previous } : {}),
      });
    return Object.assign(start, {
      shown: {
        meta: {
          name: prepared.meta.name,
          description: prepared.meta.description,
          phases: prepared.meta.phases.map((phase) => phase.title),
          ...(saved ? { file: saved } : {}),
        },
      },
    });
  }
  /** Starts a checked script as a run in the background, as a job of the conversation, and says how it went. */
  private startWorkflow(
    prepared: PreparedScript,
    options: {
      sessionId: string;
      args?: unknown;
      path?: string;
      previous?: {
        id: string;
        events: ReturnType<typeof readJournal>;
        agents: WorkflowRunView['agents'];
      };
    },
  ): string {
    const id = `w${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const folder = join(this.workflowRunsFolder, id);
    mkdirSync(folder, { recursive: true });
    const scriptFile = join(folder, 'script.js');
    writeFileSync(scriptFile, prepared.source);
    // Where the model edits it: the file it ran from, or the run's own copy
    const script = options.path ?? `/${WORKFLOW_RUNS_FOLDER}/${id}/script.js`;
    const entry: { run?: WorkflowRun; job?: string } = {};
    let write: ((line: string) => void) | undefined;
    let summary = '';
    const run = new WorkflowRun({
      id,
      sessionId: options.sessionId,
      prepared,
      ...(options.args !== undefined ? { args: options.args } : {}),
      folder,
      script,
      scriptFile,
      ...(options.previous ? { previous: options.previous } : {}),
      runner: (request, hooks) =>
        this.runWorkflowAgent(request, hooks, {
          job: () => entry.job ?? '',
          run: id,
          sessionId: options.sessionId,
          phaseModel: prepared.meta.phases.find(
            (phase) => phase.title === request.phase,
          )?.model,
        }),
      checkAgentType: (name) => this.workflowAgentType(name),
      maxConcurrent: maxWorkflowAgents(),
      stallMs: agentStallMs(),
      timer: this.options.workflowStallTimer ?? realStallTimer,
      ...(this.options.workflowSliceMs
        ? { sliceMs: this.options.workflowSliceMs }
        : {}),
      progress: (line) => write?.(line),
      changed: (view) => {
        const next = workflowSummary(view);
        if (entry.job && next !== summary) {
          summary = next;
          this.jobs.activity(entry.job, next);
        }
      },
    });
    entry.run = run;
    this.workflowRuns.set(id, entry as { run: WorkflowRun; job?: string });
    const job = this.jobs.startAgent(
      `workflow ${prepared.meta.name}`,
      { sessionId: options.sessionId, startedBy: 'model' },
      async (signal, log) => {
        // A line for its log; the strip keeps showing where the run is
        write = (line) => {
          log(line);
          if (entry.job && summary) this.jobs.activity(entry.job, summary);
        };
        return await run.run(signal);
      },
      undefined,
      {
        workflow: {
          run: id,
          name: prepared.meta.name,
          result: join(folder, 'result.txt'),
        },
        failure: 'script error',
      },
    );
    entry.job = job.id;
    run.view.job = job.id;
    const phases = prepared.meta.phases.map((phase) => phase.title);
    return [
      `Workflow ${prepared.meta.name} started as run ${id}.` +
        (phases.length ? ` Phases: ${phases.join(', ')}.` : '') +
        (options.previous
          ? ` It relaunches run ${options.previous.id}: agents called as they were then return their saved results.`
          : ''),
      `Script: ${script}. To relaunch it after an edit, call workflow with script_path: ${script} and resume_from_run_id: ${id}.`,
      `In background: ${jobLine(job)}. The result arrives as a notice when the run ends; do not poll or sleep.`,
    ].join('\n');
  }
  /** One attempt of one workflow agent, through the path `task` takes. */
  private async runWorkflowAgent(
    request: AgentRequest,
    hooks: AttemptHooks,
    run: {
      job: () => string;
      run: string;
      sessionId: string;
      phaseModel?: string;
    },
  ): Promise<unknown> {
    const model = request.model ?? run.phaseModel;
    const launch: WorkflowLaunch = {
      jobId: run.job(),
      run: run.run,
      label: request.label,
      ...(model ? { model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.schema ? { schema: request.schema } : {}),
      attempts: structuredOutputAttempts(),
      observe: (event) => {
        if (event.kind === 'llm_start') hooks.activity('start');
        else if (event.kind === 'llm_token') hooks.activity('output');
        else if (event.kind === 'llm_end') {
          hooks.activity('end');
          hooks.tokens(
            Number(event.usage?.input_tokens ?? 0),
            Number(event.usage?.output_tokens ?? 0),
          );
        } else if (event.kind === 'run_end' || event.kind === 'run_error')
          hooks.activity('end');
      },
      session: (id) => hooks.session(id),
    };
    try {
      const answer = await this.runTask(
        {
          description: request.prompt,
          subagent_type: request.agentType ?? WORKFLOW_AGENT,
        },
        { signal: hooks.signal, sessionId: run.sessionId },
        this.visionForRun(),
        launch,
      );
      return request.schema ? launch.value : answer;
    } catch (error) {
      if (launch.failure) throw launch.failure;
      throw error;
    }
  }
  private classifyCoreTools(tools: Tool[]): Tool[] {
    const control = new Set([
      'task',
      'workflow',
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
      saveMcpServer: (name, entry) => this.saveMcpServer(name, entry),
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
    // What the installed packs define, as their folders hold it now: a pack replaced since takes its old definitions
    // with it. A folder without a pack.json is a skill of yours, not a pack, and defines none.
    const agents: (SubagentFileInfo & { pack: string })[] = [];
    const problems: string[] = [];
    if (this.options.localContext !== false) {
      // Where skills are found: the packs under the same home
      const root =
        this.options.localSkillsRoot ??
        join(this.options.userHome ?? homedir(), '.agents', 'skills');
      let packs: string[] = [];
      try {
        packs = readdirSync(root).sort();
      } catch {
        /* No packs installed. */
      }
      for (const pack of packs) {
        const folder = join(root, pack, 'agents');
        if (!existsSync(join(root, pack, 'pack.json')) || !existsSync(folder))
          continue;
        const read = readSubagentFolder(folder, `Pack ${pack}`, true);
        agents.push(
          ...read.agents.map((agent) => ({
            ...agent,
            pack,
            spec: { ...agent.spec, name: `${pack}:${agent.spec.name}` },
          })),
        );
        problems.push(...read.problems);
      }
    }
    this.packAgents = agents;
    this.packAgentProblems = problems;
  }
  /**
   * The tools a definition lists, and the entries that name no tool. An entry ending in `*` takes every tool whose
   * name starts with what comes before it, and names nothing missing when none does.
   */
  private listedTools(entries: string[]): { tools: Tool[]; missing: string[] } {
    const tools: Tool[] = [];
    const missing: string[] = [];
    for (const entry of entries) {
      const found = this.toolsNamed(entry);
      if (!found) missing.push(entry);
      else
        for (const tool of found) if (!tools.includes(tool)) tools.push(tool);
    }
    return { tools, missing };
  }
  /**
   * The tools one `tools` or `disallowedTools` entry names, or undefined when it names none that exists: a tool by its
   * name, the tools whose names start with what comes before a `*`, and an MCP server's tools as `mcp__<server>`,
   * `mcp__<server>__*` and `mcp__*`, or one of them as `mcp__<server>__<tool>`. A server is found by its name, so
   * these hold however its tools are named.
   */
  private toolsNamed(entry: string): Tool[] | undefined {
    const named = (names: string[]) =>
      this.allTools.filter((tool) => names.includes(tool.name));
    if (entry === 'mcp__*')
      return named(this.mcp.status.flatMap((server) => server.tools));
    if (entry.startsWith('mcp__')) {
      const rest = entry.slice(5);
      // The longest server name the entry starts with: a name may hold `__`
      const server = this.mcp.status
        .filter(
          (item) => rest === item.name || rest.startsWith(`${item.name}__`),
        )
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (server) {
        const tool = rest.slice(server.name.length + 2);
        if (!tool || tool === '*') return named(server.tools);
        const found = named([mcpToolName(server.name, tool)]);
        if (found.length) return found;
      }
    } else if (entry.endsWith('*'))
      return this.allTools.filter((tool) =>
        tool.name.startsWith(entry.slice(0, -1)),
      );
    const exact = this.allTools.filter((tool) => tool.name === entry);
    return exact.length ? exact : undefined;
  }
  /**
   * One definition as `task` runs it, or why it is not offered: a tool it names or withholds that does not exist, or
   * an MCP server this session does not have.
   */
  private fileSubagent(
    agent: SubagentFileInfo,
    shown: string,
  ): CustomSubagent | string {
    const listed = agent.tools ? this.listedTools(agent.tools) : undefined;
    if (listed?.missing.length)
      return `${shown} names tools that do not exist: ${listed.missing.join(', ')} · not offered`;
    // An entry that withholds nothing is a guard that is not there: it keeps the definition out, as one in `tools` does
    const withheld = agent.disallowedTools
      ? this.listedTools(agent.disallowedTools)
      : undefined;
    if (withheld?.missing.length)
      return `${shown} withholds tools that do not exist: ${withheld.missing.join(', ')} · not offered`;
    const servers = agent.mcpServers ?? [];
    const unknown = servers.filter(
      (name) => !this.mcp.status.some((server) => server.name === name),
    );
    if (unknown.length)
      return `${shown} names MCP servers this session does not have: ${unknown.join(', ')} · not offered`;
    const serverTools = this.mcp.status
      .filter((server) => servers.includes(server.name))
      .flatMap((server) =>
        server.tools.flatMap(
          (name) => this.allTools.find((tool) => tool.name === name) ?? [],
        ),
      );
    const names = new Set(withheld?.tools.map((tool) => tool.name));
    // A pattern also takes a tool that comes later, such as a pack's
    const prefixes = (agent.disallowedTools ?? [])
      .filter((entry) => entry.endsWith('*') && !entry.startsWith('mcp__'))
      .map((entry) => entry.slice(0, -1));
    return {
      spec: agent.spec,
      source: agent.source_label,
      path: agent.path,
      file: agent,
      ...(listed ? { tools: listed.tools } : {}),
      ...(serverTools.length ? { serverTools } : {}),
      ...(withheld
        ? {
            withholds: (name: string) =>
              names.has(name) ||
              prefixes.some((prefix) => name.startsWith(prefix)),
          }
        : {}),
    };
  }
  /**
   * The subagents a person or an extension defined. Folders first, so an extension of the
   * same name wins, as it already does over a built-in. A file naming a tool that does not
   * exist is passed over and `problems` says so, rather than running with a broken set.
   */
  private customSubagents(problems: string[] = []): CustomSubagent[] {
    const byName = new Map<string, CustomSubagent>();
    for (const agent of this.fileAgents) {
      const read = this.fileSubagent(agent, agent.spec.name);
      if (typeof read === 'string') problems.push(read);
      else byName.set(agent.spec.name, read);
    }
    for (const agent of this.extensions.subagents(this.allTools))
      byName.set(agent.spec.name, {
        spec: agent.spec,
        tools: agent.tools,
        source: 'Extension',
      });
    // A pack's definitions come last: a name a folder, an extension or Circle gives already stays theirs
    for (const agent of this.packAgents) {
      const name = agent.spec.name;
      const taken =
        byName.get(name)?.source ??
        (Object.hasOwn(BUILTIN_SUBAGENT_PROMPTS, name) ? 'Circle' : undefined);
      if (taken) {
        problems.push(
          `${name} from the pack ${agent.pack} has a name ${taken} gives a subagent already · not offered`,
        );
        continue;
      }
      const read = this.fileSubagent(
        agent,
        `${name} from the pack ${agent.pack}`,
      );
      if (typeof read === 'string') problems.push(read);
      else byName.set(name, read);
    }
    return [...byName.values()];
  }
  /** Why a definition's own hooks do not run: hooks are off, or its project folder is not trusted yet. */
  private agentHooksHeld(file: SubagentFileInfo): string | undefined {
    if (this.ensureHooks().loaded.disabled) return 'hooks are off';
    if (
      file.source_label.startsWith('Project') &&
      !isFolderTrusted(this.options.settings, this.options.workspace)
    )
      return 'this folder is not trusted';
    return undefined;
  }
  /**
   * Everything `task` may choose, for `/agents`: the three that ship with Circle, then the
   * folders and extensions, with the reason any definition was passed over. The folders are
   * read again here, as `task` will see them.
   */
  inspectSubagents(): {
    agents: SubagentListing[];
    problems: string[];
  } {
    this.loadSubagentFiles();
    const problems = [...this.fileAgentProblems, ...this.packAgentProblems];
    const byName = new Map<string, SubagentListing>(
      Object.entries(BUILTIN_SUBAGENT_DESCRIPTIONS).map(
        ([name, description]) => [
          name,
          { name, description, source: 'Circle' },
        ],
      ),
    );
    for (const agent of this.customSubagents(problems)) {
      const file = agent.file;
      const skills = file?.skills ?? [];
      const missing = skills.filter(
        (name) =>
          !this.skills.some((skill) => skill.name === name.toLowerCase()),
      );
      byName.set(agent.spec.name, {
        name: agent.spec.name,
        description: agent.spec.description,
        source: agent.source,
        ...(agent.spec.model ? { model: agent.spec.model } : {}),
        ...(agent.spec.effort ? { effort: agent.spec.effort } : {}),
        ...(agent.tools ? { tools: agent.tools.map((tool) => tool.name) } : {}),
        ...(agent.path ? { path: agent.path } : {}),
        ...(file?.disallowedTools
          ? { disallowedTools: file.disallowedTools }
          : {}),
        ...(file?.permissionMode
          ? { permissionMode: file.permissionMode }
          : {}),
        ...(file?.maxTurns ? { maxTurns: file.maxTurns } : {}),
        ...(skills.length ? { skills } : {}),
        ...(missing.length ? { missingSkills: missing } : {}),
        ...(file?.mcpServers ? { mcpServers: file.mcpServers } : {}),
        ...(file?.hooks?.length
          ? {
              hooks: [...new Set(file.hooks.map((hook) => hook.event))],
              ...(this.agentHooksHeld(file)
                ? { hooksHeld: this.agentHooksHeld(file) }
                : {}),
            }
          : {}),
        ...(file?.background ? { background: true } : {}),
        ...(file?.memory || file?.isolation || file?.color
          ? {
              unsupported: [
                ...(file.memory ? [`memory ${file.memory}`] : []),
                ...(file.isolation ? [`isolation ${file.isolation}`] : []),
                ...(file.color ? [`color ${file.color}`] : []),
              ],
            }
          : {}),
        ...(file?.ignored?.length ? { ignored: file.ignored } : {}),
        ...(file?.notApplied?.length ? { notApplied: file.notApplied } : {}),
      });
    }
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
    const build = (sessionPreferences: string) =>
      buildSystemPrompt(
        this.options.workspace,
        model,
        this.options.settings.auth.protocol,
        this.runOptions,
        this.options.home,
        {
          sessionPreferences,
          skills: this.skills,
          onContextFiles: (files) => {
            this.promptInstructions = files.map((file) => ({ ...file }));
          },
          extensionTools: this.extensions.tools(),
          userHome: this.options.userHome,
          localContext: this.options.localContext,
          variables: this.runVariables(),
          secrets: Object.keys(this.runSecrets()).sort(),
          attribution: this.options.settings.attribution,
          headless: this.options.headless,
          mcpInstructions: this.mcp.instructions(),
          githubSetup: Boolean(this.options.githubConnection),
          outputFolder: this.commandOutputFolder(),
        },
      );
    let cap = SESSION_MEMORY_BYTES;
    let preferences = this.sessionMemory
      ? formatSessionMemory(this.sessionMemory, cap)
      : '';
    const base = build(''),
      actual = this.baseModel;
    if (preferences && actual) {
      const frame = (system: string) => ({
        system,
        messages: this.harness?.messages ?? [],
        tools: this.harness?.tools ?? this.coreTools,
      });
      if (!requestBudget(actual, frame(build(preferences))).fits) {
        let low = 0,
          high = cap;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2),
            text = formatSessionMemory(this.sessionMemory!, mid);
          if (requestBudget(actual, frame(build(text))).fits) low = mid;
          else high = mid - 1;
        }
        cap = low;
        preferences = formatSessionMemory(this.sessionMemory!, cap);
      }
    }
    this.memoryPrompt = preferences;
    return preferences ? build(preferences) : base;
  }

  /**
   * The secrets a call may name as `%NAME%`: those saved, and the tokens of the MCP server entries that name a
   * placeholder for theirs (mcp_placeholders.ts), unless the person keeps a value under that name.
   */
  runSecrets(): Record<string, string> {
    return { ...this.runValues().secrets };
  }
  /** The plain variables a call may name: the person's, and the endpoints of the MCP entries that name a placeholder for theirs. */
  runVariables(): Record<string, string> {
    return { ...this.runValues().variables };
  }
  private values?: {
    key: string;
    until: number;
    secrets: Record<string, string>;
    variables: Record<string, string>;
  };
  /**
   * Both, read once and kept while nothing they come from has changed: the saved secrets, the kept sign-ins, the MCP
   * entries and the variables, and until the first token given expires. A redaction runs for every tool result and
   * every chunk of a command's output; reading the files each time would read them several times a chunk.
   */
  private runValues(): {
    secrets: Record<string, string>;
    variables: Record<string, string>;
  } {
    const home = this.options.home;
    const stamp = (path: string) => {
      try {
        const file = statSync(path);
        return `${file.mtimeMs}:${file.size}`;
      } catch {
        return '-';
      }
    };
    const variables = this.options.settings.variables ?? {};
    const key = [
      stamp(secretsPath(home)),
      stamp(mcpAuthPath(home)),
      JSON.stringify(this.options.settings.mcpServers),
      JSON.stringify(variables),
    ].join('\n');
    if (this.values?.key === key && Date.now() < this.values.until)
      return this.values;
    const secrets = loadSecrets(home);
    const given = mcpPlaceholders(home, this.options.settings, {
      variables,
      secrets,
    });
    this.values = {
      key,
      until: given.until,
      secrets: { ...given.secrets, ...secrets },
      variables: { ...given.variables, ...variables },
    };
    return this.values;
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
  /** Move deferred knowledge tools onto the harness once a knowledge tool was called. */
  private promoteKnowledgeTools(): void {
    if (
      !this.deferredKnowledgeTools.length ||
      !knowledgeToolsWanted(this.harness.messages)
    )
      return;
    const missing = this.deferredKnowledgeTools.filter(
      (tool) => !this.coreTools.some((have) => have.name === tool.name),
    );
    if (!missing.length) return;
    this.coreTools.push(...missing);
    this.harness.tools = this.withIntegrationTools(
      this.coreTools.filter((tool) => tool.name !== 'wait_jobs'),
    );
    this.describeSubagents(this.harness.tools);
  }
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
    this.describeWorkflows(tools);
    const task = tools.find((tool) => tool.name === 'task');
    if (!task) return;
    const subagents = new Map<string, string>(
      Object.entries(BUILTIN_SUBAGENT_DESCRIPTIONS),
    );
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
  /** The workflow tool's words, with the saved workflows it can run by name. */
  private describeWorkflows(tools: Tool[]): void {
    const tool = tools.find((item) => item.name === 'workflow');
    if (!tool) return;
    const saved = this.savedWorkflows().workflows;
    tool.description =
      readFileSync(
        join(import.meta.dirname, 'prompts/tools/workflow.md'),
        'utf8',
      ).trim() +
      (saved.length
        ? '\n\nSaved workflows:\n' +
          saved
            .map(
              (workflow) =>
                `- ${workflow.name}: ${workflow.meta.description}` +
                (workflow.meta.whenToUse
                  ? ` Use when: ${workflow.meta.whenToUse}`
                  : ''),
            )
            .join('\n')
        : '');
  }
  private withIntegrationTools(tools: Tool[], limits = true): Tool[] {
    const names = new Set<string>();
    const integrations = [
      ...tools,
      ...this.mcp.tools,
      // Reading what the servers publish, while one does: a name a server's own tool has stays the server's
      ...this.mcp.resourceTools.filter(
        (tool) => !this.mcp.tools.some((have) => have.name === tool.name),
      ),
      ...this.extensions.tools(),
    ];
    // A pack's tool whose name another tool took is left out, not a clash
    const taken = new Set(integrations.map((tool) => tool.name));
    return [
      ...integrations,
      ...this.packTools
        .map((item) => item.tool)
        .filter((tool) => !taken.has(tool.name)),
    ].filter((tool) => {
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
    });
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
    if (this.options.headless && !this.options.integrations) {
      await this.prepareSessionMemory(
        signal ?? this.integrationLifetime.signal,
      );
      return;
    }
    const active = signal
      ? AbortSignal.any([signal, this.integrationLifetime.signal])
      : this.integrationLifetime.signal;
    active.throwIfAborted();
    if (!this.integrationsReady) {
      this.integrationsReady = (async () => {
        const base = this.coreTools;
        const servers = this.mcpServers();
        await this.mcp.load(
          servers.entries,
          new Set(base.map((tool) => tool.name)),
          active,
          { waiting: servers.waiting, trusted: servers.trusted },
        );
        this.askForProjectServers(servers.pending);
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
        if (this.options.localContext !== false)
          await this.knowledge.configure();
      })().catch((error) => {
        this.integrationsReady = undefined;
        throw error;
      });
    }
    await this.integrationsReady;
    await this.prepareSessionMemory(active);
  }
  private async prepareSessionMemory(signal: AbortSignal): Promise<void> {
    if (
      this.options.localContext === false ||
      this.memorySession === this.session.id
    )
      return;
    if (this.memoryLoading) {
      await this.memoryLoading;
      if (this.memorySession === this.session.id) return;
    }
    const session = this.session.id;
    const work = (async () => {
      const read =
        this.options.headless && !this.options.integrations
          ? undefined
          : this.knowledge.reader();
      const snapshot = await loadSessionMemory(this.options.home, read, signal);
      signal.throwIfAborted();
      if (this.session.id !== session || this.closing) return;
      this.sessionMemory = snapshot;
      this.memorySession = session;
      this.refreshSystemPrompt();
      if (snapshot.warnings.length || snapshot.conflicts)
        this.bus.emit('info', {
          payload: {
            message: [
              ...snapshot.warnings,
              ...(snapshot.conflicts
                ? [
                    `${snapshot.conflicts} personal memory conflicts were not loaded`,
                  ]
                : []),
            ].join('; '),
            session_memory: true,
          },
        });
    })();
    this.memoryLoading = work;
    try {
      await work;
    } finally {
      if (this.memoryLoading === work) this.memoryLoading = undefined;
    }
  }
  async refreshSessionMemory(): Promise<void> {
    if (this.busy) throw Error('refresh memory after the current turn');
    this.sessionMemory = undefined;
    this.memorySession = undefined;
    await this.prepareSessionMemory(this.integrationLifetime.signal);
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
    if (this.closing || this.toolsCheck) return;
    // A macrotask later: several changes in a row become one rebuild, and a turn that just
    // ended has let go of the harness.
    this.toolsCheck = setTimeout(() => {
      this.toolsCheck = undefined;
      if (
        this.closing ||
        !this.toolsStale ||
        !this.integrationsReady ||
        this.busy
      )
        return;
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
    hooks: { hook: ConfiguredHook; active: boolean; spent: boolean }[];
    untrusted: boolean;
    disabled: boolean;
    errors: HookLoadError[];
  } {
    const runner = this.ensureHooks();
    return {
      hooks: runner.listing(),
      untrusted: runner.loaded.untrusted,
      disabled: runner.loaded.disabled,
      errors: [...runner.loaded.errors],
    };
  }
  /** How the next session's harness started, for SessionStart: after /new, `clear`. */
  private nextSessionSource: 'clear' | undefined;
  private idleTimer?: NodeJS.Timeout;
  /** Notification hooks, for their side effects; what they say is not used, and nothing waits for them. */
  private notificationHooks(
    type: 'permission_prompt' | 'idle_prompt',
    title: string,
    message: string,
  ): void {
    const runner = this.hookRunner;
    if (!runner?.has('Notification')) return;
    void runner
      .run({
        event: 'Notification',
        sessionId: this.session.id,
        cwd: this.options.workspace,
        matchValue: type,
        fields: { notification_type: type, title, message },
        secrets: this.runSecrets(),
      })
      .catch(() => {});
  }
  /** An approval card that waits a while tells the Notification hooks, once. */
  private async noticeWaiting<T>(
    call: { name: string },
    wait: () => Promise<T>,
  ): Promise<T> {
    const timer = setTimeout(
      () =>
        this.notificationHooks(
          'permission_prompt',
          'Permission needed',
          `Circle needs your permission to use ${call.name}`,
        ),
      this.options.notificationDelays?.permission ?? 6_000,
    );
    timer.unref?.();
    try {
      return await wait();
    } finally {
      clearTimeout(timer);
    }
  }
  /** A turn ended where someone can answer: a minute without a new message tells the Notification hooks. */
  private waitForInput(): void {
    if (this.options.headless || this.closing) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.notificationHooks(
        'idle_prompt',
        'Waiting for input',
        'Circle is waiting for your input',
      );
    }, this.options.notificationDelays?.idle ?? 60_000);
    this.idleTimer.unref?.();
  }
  /** SessionEnd hooks of the conversation that ends, if it started: a short budget, and what they say is not used. */
  private async sessionEndHooks(
    reason: 'clear' | 'resume' | 'other',
  ): Promise<void> {
    const runner = this.hookRunner;
    if (!runner?.has('SessionEnd') || !this.harness?.hooksStarted) return;
    try {
      await runner.run({
        event: 'SessionEnd',
        sessionId: this.session.id,
        cwd: this.options.workspace,
        matchValue: reason,
        fields: { reason },
        secrets: this.runSecrets(),
      });
    } catch {
      /* A conversation ends whatever its hooks do. */
    }
  }
  /**
   * The conversation's PreCompact hooks, before it is compacted: a block keeps it as it is, and what they print goes
   * to the summary as instructions. A subagent's compaction runs none.
   */
  private async preCompactHooks(
    sessionId: string,
    trigger: 'manual' | 'auto',
    hint: string,
    signal: AbortSignal,
  ): Promise<{ blocked?: string; instructions: string }> {
    const runner = this.hookRunner;
    if (sessionId !== this.session.id || !runner?.has('PreCompact'))
      return { instructions: '' };
    const batch = await runner.run({
      event: 'PreCompact',
      sessionId,
      cwd: this.options.workspace,
      matchValue: trigger,
      fields: {
        trigger,
        custom_instructions: trigger === 'manual' && hint ? hint : null,
      },
      secrets: this.runSecrets(),
      signal,
    });
    const blocked = batch.blocked ? batch.reason || 'hook blocked' : undefined;
    this.harness.hookContext(
      {
        ...batch,
        context: '',
        notices: [
          ...batch.notices.filter((notice) => notice.kind !== 'output'),
          ...(blocked !== undefined
            ? [
                {
                  kind: 'blocked' as const,
                  tool: 'compaction',
                  reason: blocked,
                },
              ]
            : []),
        ],
      },
      'PreCompact',
    );
    return {
      ...(blocked !== undefined ? { blocked } : {}),
      instructions: batch.context,
    };
  }
  /**
   * After a compaction: the conversation's PostCompact hooks hear the summary, and SessionStart hooks run again so
   * what they said is in the conversation again. A subagent's SubagentStart hooks run again for it.
   */
  private async postCompactHooks(
    sessionId: string,
    trigger: 'manual' | 'auto',
    summary: string,
  ): Promise<void> {
    const runner = this.hookRunner;
    if (!runner) return;
    const child = this.childHarnesses.get(sessionId);
    if (child) {
      await this.subagentStartHooks(
        child.harness,
        { sessionId: child.parent, id: sessionId, type: child.type },
        '',
        new AbortController().signal,
      ).catch(() => {});
      return;
    }
    if (sessionId !== this.session.id) return;
    if (runner.has('PostCompact')) {
      const batch = await runner.run({
        event: 'PostCompact',
        sessionId,
        cwd: this.options.workspace,
        matchValue: trigger,
        fields: { trigger, compact_summary: summary },
        secrets: this.runSecrets(),
      });
      this.harness.hookContext({ ...batch, context: '' }, 'PostCompact');
    }
    await this.harness.sessionStartHooks('compact');
  }
  /** The background work still running in this conversation, as Stop hooks get it. */
  private backgroundTasks(): Record<string, unknown>[] {
    return this.jobs
      .list(this.session.id)
      .filter((job) => job.status === 'running')
      .map((job) => ({
        id: job.id,
        type: job.workflow
          ? 'workflow'
          : job.kind === 'agent'
            ? 'subagent'
            : 'shell',
        status: job.status,
        description: job.title.slice(0, 1000),
        // A workflow is named, not run as a command
        ...(job.command && !job.workflow
          ? { command: job.command.slice(0, 1000) }
          : {}),
        ...(job.workflow ? { name: job.workflow.name } : {}),
      }));
  }
  /** Skills whose hooks are armed for the current session. */
  private armedSkills = new Set<string>();
  private ensureHooks(): HookRunner {
    if (!this.hookRunner) {
      const trusted = isFolderTrusted(
        this.options.settings,
        this.options.workspace,
      );
      // Hooks files of the format before this one move into settings first, once
      const notes = migrateHookFiles({
        home: this.options.home,
        workspace: this.options.workspace,
        trusted,
        userHome: this.options.userHome,
      });
      this.hookRunner = new HookRunner(
        loadHooks({
          workspace: this.options.workspace,
          home: this.options.home,
          trusted,
          userHome: this.options.userHome,
          ...(this.options.localSkillsRoot
            ? { packsRoot: this.options.localSkillsRoot }
            : {}),
        }),
        { workspace: this.options.workspace, home: this.options.home },
      );
      this.hookRunner.loaded.notes.push(...notes);
      for (const name of this.armedSkills) this.hookRunner.activateSkill(name);
    }
    return this.hookRunner;
  }
  /**
   * A skill was loaded in this session, from /skill or the skill tool: its hooks start, and the tools its pack
   * declares join the list from the next request, also for the subagent that loaded it. Installing the skill does
   * nothing. Returns what the model is told about those tools, or nothing.
   */
  async activateSkillHooks(
    name: string,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<string> {
    const note = await this.armSkill(name, signal);
    // A subagent that loads it gets the pack's tools it may have, from its next request
    const child = sessionId ? this.childHarnesses.get(sessionId) : undefined;
    return child ? this.offerPackTools(name, child, note) : note;
  }
  /** The subagents at work, by their session: the harness and the tools each may have. */
  private childHarnesses = new Map<
    string,
    {
      harness: Harness;
      allows: (tool: Tool) => boolean;
      /** Its type and the conversation it works for, for the hooks that hear of it. */
      type: string;
      parent: string;
      /** 1 for one the conversation started, 2 for one that one started, and so on. */
      depth: number;
      /** The background job it works under, its own or one above it: its cards wait under that job. */
      job: () => string | undefined;
    }
  >();
  /** The subagents running, by their session, each with the conversation it counts against. */
  private runningSubagents = new Map<string, string>();
  /** Adds the tools of a loaded skill's pack to a subagent, and says which it got and which it may not have. */
  private offerPackTools(
    name: string,
    child: { harness: Harness; allows: (tool: Tool) => boolean },
    note: string,
  ): string {
    const skill = this.skills.find(
      (item) => item.name.toLowerCase() === name.trim().toLowerCase(),
    );
    const pack = skill ? basename(dirname(skill.path)) : undefined;
    const declared = this.packTools.filter((item) => item.pack === pack);
    if (!declared.length) return note;
    const allowed = declared.filter((item) => child.allows(item.tool));
    const have = new Set(child.harness.tools.map((tool) => tool.name));
    child.harness.tools = [
      ...child.harness.tools,
      ...allowed
        .filter((item) => !have.has(item.tool.name))
        .map((item) => item.tool),
    ];
    const withheld = declared.filter((item) => !child.allows(item.tool));
    return [
      allowed.length
        ? `Tools the pack ${pack} declares, offered to you from the next request: ${allowed.map((item) => `${item.tool.name} (${item.script})`).join(', ')}. Each checks its input before the script starts; call it rather than skill_run for that script.`
        : '',
      withheld.length
        ? `The pack ${pack} declares tools this subagent does not have: ${withheld.map((item) => item.tool.name).join(', ')}.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  /** Arms a skill for the session once: its pack's tools and its hooks. */
  private async armSkill(name: string, signal?: AbortSignal): Promise<string> {
    const key = name.trim().toLowerCase();
    if (!key) return '';
    // Loaded again: the model is told again which tools it has, in case that part of the conversation is gone
    if (this.armedSkills.has(key)) return this.packToolNotes.get(key) ?? '';
    this.armedSkills.add(key);
    const tools = await this.armPackTools(key);
    if (tools) this.packToolNotes.set(key, tools);
    const runner = this.hookRunner;
    if (!runner) return tools;
    const armed = runner.activateSkill(key);
    if (this.harness && armed.length) this.harness.skillHooksArmed(armed);
    return tools;
  }
  /**
   * The declared tools of the packs whose skill this session loaded. They come after every other tool: a name a
   * built-in tool, an MCP server or an extension has, now or once it connects, stays theirs.
   */
  private packTools: { pack: string; script: string; tool: Tool }[] = [];
  /** What the model was told of them, by skill, to tell it again when the skill is loaded again. */
  private packToolNotes = new Map<string, string>();
  /**
   * The skill is an installed pack's (its folder is right under the packs' root, as `skill_install` puts it): the
   * scripts the pack declares in `tools.json` become typed tools (#544). A pack whose files do not verify, or
   * whose declaration does not hold, adds none, and the model is told why.
   */
  private async armPackTools(key: string): Promise<string> {
    const skill = this.skills.find((item) => item.name.toLowerCase() === key);
    if (!skill || !this.harness) return '';
    let root: string;
    try {
      root = realpathSync(this.options.localSkillsRoot ?? SKILLS_ROOT);
    } catch {
      return '';
    }
    const folder = dirname(skill.path);
    if (dirname(folder) !== root) return '';
    const pack = basename(folder);
    let declared;
    try {
      declared = await readPackTools(root, pack);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return `The pack ${pack} declares tools, and none is offered: ${why}`;
    }
    if (!declared.length) return '';
    const taken = new Set(
      [
        ...this.allTools,
        ...this.harness.tools,
        ...(this.options.deferredTools ?? []),
      ].map((tool) => tool.name),
    );
    const added: string[] = [];
    const skipped: string[] = [];
    for (const declaration of declared) {
      const tool = packTool({
        root,
        pack,
        declaration,
        variables: () => this.runVariables(),
        secrets: () => this.runSecrets(),
        workspace: this.options.workspace,
        dataRoot: join(this.options.home, SKILL_DATA_FOLDER),
        jobs: this.jobs,
        jobOwner: (context) =>
          this.childJobOwners.get(context.sessionId) ?? {
            sessionId: context.sessionId,
            startedBy: 'model',
          },
      });
      if (taken.has(tool.name)) {
        skipped.push(tool.name);
        continue;
      }
      taken.add(tool.name);
      this.packTools.push({ pack, script: declaration.script, tool });
      added.push(`${tool.name} (${declaration.script})`);
    }
    if (added.length) {
      this.harness.tools = this.withIntegrationTools(
        this.coreTools.filter((tool) => tool.name !== 'wait_jobs'),
      );
      this.describeSubagents(this.harness.tools);
    }
    return [
      added.length
        ? `Tools the pack ${pack} declares, offered from the next request: ${added.join(', ')}. Each checks its input before the script starts; call it rather than skill_run for that script.`
        : '',
      skipped.length
        ? `Not offered, because a tool already has the name: ${skipped.join(', ')}.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  /**
   * The conversation's SubagentStart hooks, before a subagent's first request: matched by the subagent's type, each
   * gets the conversation's session, the subagent's own as `agent_id`, its type and its task. What they say starts
   * the subagent's conversation, before its task.
   */
  private async subagentStartHooks(
    child: Harness,
    agent: { sessionId: string; id: string; type: string },
    description: string,
    signal: AbortSignal,
  ): Promise<void> {
    const runner = this.hookRunner;
    if (!runner?.has('SubagentStart')) return;
    // The subagent's own mode, as its calls are decided in
    const mode = child.hookMode();
    const batch = await runner.run({
      event: 'SubagentStart',
      sessionId: agent.sessionId,
      agent: { id: agent.id, type: agent.type },
      cwd: this.options.workspace,
      ...(mode ? { permissionMode: mode } : {}),
      matchValue: agent.type,
      fields: { description },
      secrets: this.runSecrets(),
      signal,
    });
    signal.throwIfAborted();
    child.hookContext(batch, 'SubagentStart');
  }
  /**
   * The conversation's SubagentStop hooks, when a subagent has answered: a block, or words for it, send it back to
   * work with them as its next instruction. Undefined when it may stop.
   */
  private async subagentStopHooks(
    child: Harness,
    agent: { sessionId: string; id: string; type: string },
    answer: string,
    active: boolean,
    signal: AbortSignal,
    /** The subagent's own hooks: its Stop hooks run here as SubagentStop. */
    extra?: HookDefinition[],
  ): Promise<string | undefined> {
    const runner = this.hookRunner;
    if (!runner?.has('SubagentStop', extra)) return undefined;
    // The subagent's own mode, as its calls are decided in
    const mode = child.hookMode();
    const batch = await runner.run({
      event: 'SubagentStop',
      sessionId: agent.sessionId,
      agent: { id: agent.id, type: agent.type },
      cwd: this.options.workspace,
      ...(mode ? { permissionMode: mode } : {}),
      matchValue: agent.type,
      fields: { stop_hook_active: active, last_assistant_message: answer },
      secrets: this.runSecrets(),
      ...(extra ? { extra } : {}),
      signal,
    });
    signal.throwIfAborted();
    child.hookContext({ ...batch, context: '' }, 'SubagentStop');
    if (batch.stop || (!batch.blocked && !batch.context)) return undefined;
    return batch.blocked
      ? `A hook blocked the end of this task: ${batch.reason || 'hook blocked stop'}${batch.context ? `\n${batch.context}` : ''}\nFix the problem and finish the task.`
      : `Stop hook feedback:\n${batch.context}`;
  }
  /** Read hooks again. /reload uses this so a changed file applies to the next call. */
  reloadHooks(): void {
    this.hookRunner?.close();
    this.hookRunner = undefined;
    if (this.harness) this.harness.options.hooks = this.ensureHooks();
  }
  /**
   * Connects one MCP server again, from the settings as they are now, and lists its tools again; the other servers
   * and the programs started for them stay as they are (#559). Between turns, as a reload is.
   */
  /**
   * Saves an MCP server entry in settings.json, replacing the one of the same name, and connects that server alone, for
   * an extension (#548). The entry keeps the id it had, so the desktop's list keeps its row. Refused, with nothing
   * saved, while a turn runs.
   */
  async saveMcpServer(
    name: string,
    entry: Record<string, unknown>,
  ): Promise<import('./extensions.js').McpServerState> {
    if (this.ownershipError) throw this.ownershipError;
    if (this.closing || this.deleting) throw new Error('session is closing');
    if (this.busy)
      throw new Error(
        'a turn is running: nothing was saved; try again after it',
      );
    saveSettingsChange(this.options.home, (settings) => {
      settings.mcpServers = { ...settings.mcpServers, [name]: entry };
    });
    await this.reloadMcpServer(name);
    const row = this.mcp.status.find((item) => item.name === name);
    return {
      name,
      state: row?.authorize
        ? 'signing-in'
        : row?.error
          ? 'failed'
          : 'connected',
      tools: row?.tools.length ?? 0,
      ...(row?.error && !row.authorize ? { error: row.error } : {}),
      ...(row?.authorize ? { signIn: row.authorize } : {}),
      ...(row?.authorize && row.code ? { code: row.code } : {}),
    };
  }
  /**
   * The servers this run reads: yours, yours for this project, and the project's `.mcp.json` in a trusted folder,
   * whose servers wait for your approval in a session that can ask. `waiting` are the rows of those not connected.
   */
  private mcpServers(settings = this.options.settings): {
    entries: McpEntry[];
    pending: McpEntry[];
    waiting: McpStatus[];
    trusted: boolean;
  } {
    const trusted = isFolderTrusted(settings, this.options.workspace);
    const found = mcpServersForRun({
      home: this.options.home,
      workspace: this.options.workspace,
      settings,
      trusted,
      interactive: this.mcpInteractive,
    });
    const row = (entry: McpEntry, approval: 'pending' | 'declined') => ({
      name: entry.name,
      connection: connectionText({
        command:
          typeof entry.config.command === 'string'
            ? entry.config.command
            : undefined,
        args: Array.isArray(entry.config.args)
          ? entry.config.args.map(String)
          : undefined,
        url:
          typeof entry.config.url === 'string' ? entry.config.url : undefined,
      }),
      tools: [],
      error: '',
      scope: 'project' as const,
      approval,
    });
    // A name a server of yours connects under is not shown again as waiting
    const used = new Set(found.entries.map((entry) => entry.name));
    return {
      entries: found.entries,
      pending: found.pending.filter((entry) => !used.has(entry.name)),
      waiting: [
        ...found.pending
          .filter((entry) => !used.has(entry.name))
          .map((entry) => row(entry, 'pending')),
        ...found.declined
          .filter((entry) => !used.has(entry.name))
          .map((entry) => row(entry, 'declined')),
      ],
      trusted,
    };
  }
  /** Whether a server of the project's `.mcp.json` asks for the person's approval before it connects. */
  private get mcpInteractive(): boolean {
    return Boolean(this.options.question) && !this.options.headless;
  }
  private askingForServers?: Promise<void>;
  /**
   * Asks, in the question panel, which servers of the project's `.mcp.json` this project may use, and connects those
   * approved. The answer is kept in settings.json for this project; closing the panel decides nothing.
   */
  private askForProjectServers(pending: McpEntry[], again = false): void {
    if (!pending.length || !this.options.question) return;
    if (this.askingForServers && !again) return;
    const signal = this.integrationLifetime.signal;
    const asked = (async () => {
      const lines = pending.map(
        (entry) =>
          `· ${entry.name}: ${connectionText({
            command:
              typeof entry.config.command === 'string'
                ? entry.config.command
                : undefined,
            args: Array.isArray(entry.config.args)
              ? entry.config.args.map(String)
              : undefined,
            url:
              typeof entry.config.url === 'string'
                ? entry.config.url
                : undefined,
          })}`,
      );
      const reply = await this.options.question!(
        {
          questions: [
            {
              question: `This project's .mcp.json adds MCP servers. A server you approve is started or reached with your rights, and its tools are offered to the model:\n${lines.join('\n')}\nWhich may this project use?`,
              header: '.mcp.json',
              options: pending.map((entry) => ({
                label: entry.name,
                description: `use ${entry.name} in this project`,
              })),
              multiple: true,
              custom: false,
            },
          ],
        },
        signal,
      );
      let answers: unknown;
      try {
        answers = JSON.parse(reply);
      } catch {
        return;
      }
      const values = Array.isArray(answers)
        ? answers
        : isRecord(answers) && Array.isArray(answers.answers)
          ? answers.answers
          : undefined;
      // Closed without an answer: nothing is decided, and /mcp reconnect asks again
      if (!values) return;
      const first = values[0];
      const chosen = new Set(
        (Array.isArray(first) ? first : first === undefined ? [] : [first]).map(
          String,
        ),
      );
      const approved = pending
        .filter((entry) => chosen.has(entry.name))
        .map((entry) => entry.name);
      const declined = pending
        .filter((entry) => !chosen.has(entry.name))
        .map((entry) => entry.name);
      saveSettingsChange(this.options.home, (settings) =>
        recordMcpjsonChoice(
          settings,
          this.options.workspace,
          approved,
          declined,
        ),
      );
      if (signal.aborted || this.closing) return;
      const settings = this.options.settings;
      recordMcpjsonChoice(settings, this.options.workspace, approved, declined);
      for (const name of [...approved, ...declined]) {
        const servers = this.mcpServers(settings);
        await this.mcp.reloadServer(name, servers.entries, {
          waiting: servers.waiting,
          trusted: servers.trusted,
        });
      }
      this.toolsStale = true;
      this.scheduleToolRefresh();
    })()
      .catch(() => {})
      .finally(() => {
        if (this.askingForServers === asked) this.askingForServers = undefined;
      });
    this.askingForServers = asked;
  }
  async reloadMcpServer(name: string): Promise<void> {
    if (this.ownershipError) throw this.ownershipError;
    if (this.closing || this.deleting) throw new Error('session is closing');
    if (this.busy) throw new Error('reload after the current turn');
    // Only the servers are read again: the rest of the settings is /reload's, with what depends on it
    const settings = settingsForRun(
      this.options.home,
      this.options.workspace,
      this.options.modelOverride,
    ).settings;
    await this.integrationsReady;
    const servers = this.mcpServers(settings);
    // A server of the project's .mcp.json that waits, or was declined, is asked about again
    const waiting = servers.waiting.find((row) => row.name === name);
    if (waiting) {
      const entry = mcpServersForRun({
        home: this.options.home,
        workspace: this.options.workspace,
        settings,
        trusted: servers.trusted,
        interactive: true,
      }).pending.find((item) => item.name === name);
      if (entry && this.mcpInteractive) {
        this.askForProjectServers([entry], true);
        return;
      }
    }
    await this.mcp.reloadServer(name, servers.entries, {
      waiting: servers.waiting,
      trusted: servers.trusted,
    });
    this.options.settings.mcpServers = settings.mcpServers;
    this.options.settings.projects = settings.projects;
    this.harness.tools = this.withIntegrationTools(
      this.coreTools.filter((tool) => tool.name !== 'wait_jobs'),
    );
    this.describeSubagents(this.harness.tools);
    this.refreshSystemPrompt();
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
    this.sessionMemory = undefined;
    this.memorySession = undefined;
    await this.knowledge.close();
    await this.initialize();
  }
  /**
   * Where the model's commands put output it reads back, when its file reads are limited to
   * the workspace and Circle's own folders (the desktop's file backend): this run's folder in
   * the data folder, made here. Elsewhere read_file reads /tmp and there is none.
   */
  commandOutputFolder(): string | undefined {
    if (!this.options.fileMutations) return undefined;
    try {
      mkdirSync(this.jobs.scratchFolder, { recursive: true, mode: 0o700 });
      return this.jobs.scratchFolder;
    } catch {
      return undefined;
    }
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
    const addCompactionReceipts = (id: string) => {
      for (const operation of this.store.compactions.operations(
        id,
        this.store.ancestorIds(id),
      ))
        for (const call of this.store.compactions.attempts(
          operation.snapshot.operationId,
        )) {
          if (call.usage) addUsage(usage, call.usage);
          compactions.add(call.cost);
        }
    };
    addCompactionReceipts(this.session.id);
    // Every layer of subagents: each lists those it started
    const subagents: string[] = [];
    const descend = (ids: string[] = []): void => {
      for (const id of ids)
        if (!subagents.includes(id) && this.store.get(id)) {
          subagents.push(id);
          descend(this.store.contextState(id).subagentSessionIds);
        }
    };
    descend(state.subagentSessionIds);
    for (const id of subagents) {
      addCompactionReceipts(id);
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
        {
          system: this.harness.system,
          tools: this.harness.tools,
          hookTrigger: 'auto',
        },
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
    let completed = false;
    try {
      const result = await this.activeCompaction;
      completed = true;
      return result;
    } finally {
      this.activeCompaction = undefined;
      this.compactionController = undefined;
      this.releaseIfAway();
      if (
        completed &&
        !this.closing &&
        !this.viewOnly &&
        this.harness.pendingMessageCount
      )
        void this.harness.run('').catch(() => {
          /* Harness emits the turn outcome. */
        });
    }
  }
  get compaction(): import('./compaction.js').CompactionSnapshot | undefined {
    return this.context.compactor.snapshot(this.session.id);
  }
  compactionHistory(): import('./compaction.js').CompactionSnapshot[] {
    return this.context.compactor.records(this.session.id);
  }
  private contextMeterCache?: { key: string; input: number };
  /** A receipt predating compaction cannot describe its replacement context. */
  contextMeter(): { input?: number; window?: number; estimated: boolean } {
    const model = this.harness.model;
    const facts =
      model.modelFacts ??
      this.catalog.facts(
        model.model,
        this.options.settings,
        model.contextWindow,
      );
    const limits = resolveBudget(model);
    const window = facts.windowKnown ? limits.window : undefined;
    const last = this.harness.messages.findLast(
      (m) => m.role === 'assistant' && m.usage,
    );
    const state = this.store.contextState(this.session.id);
    const operation = state.compactionOperationId
      ? this.store.compactions
          .operations(this.session.id)
          .find((o) => o.snapshot.operationId === state.compactionOperationId)
          ?.snapshot
      : undefined;
    const checkpoint =
      last &&
      this.store.tree(this.session.id).findLast((c) => c.message === last);
    const oldReceipt =
      !!state.summary &&
      (!operation ||
        !checkpoint ||
        this.store
          .ancestorIds(this.session.id, operation.branchHead)
          .has(checkpoint.id));
    const differentModel =
      !!last?.request_model && last.request_model !== model.model;
    const differentConnection =
      !!last?.request_budget &&
      last.request_budget.identity !== limits.identity;
    if (last?.usage && !oldReceipt && !differentModel && !differentConnection)
      return { input: last.usage.input_tokens, window, estimated: false };
    if (!state.summary && !differentModel && !differentConnection)
      return { window, estimated: false };
    const key = contentHash({
      head: this.store.get(this.session.id)?.head,
      state,
      limits,
      factor: model.inputEstimateFactor,
      system: this.harness.system,
      tools: this.harness.tools.map(
        ({ run: _run, approvalFacts: _facts, ...tool }) => tool,
      ),
    });
    if (this.contextMeterCache?.key !== key)
      this.contextMeterCache = {
        key,
        input: requestBudget(model, {
          system: this.harness.system,
          tools: this.harness.tools,
          messages: this.context.project(this.session.id),
        }).input,
      };
    return { input: this.contextMeterCache.input, window, estimated: true };
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
  async cancel(
    options: { keepQueue?: boolean; compactionOperationId?: string } = {},
  ): Promise<void> {
    if (options.compactionOperationId) {
      const snapshot = this.compaction;
      if (
        snapshot?.operationId !== options.compactionOperationId ||
        snapshot.status !== 'running'
      )
        return;
    }
    this.context.compactor.cancel(
      this.session.id,
      options.compactionOperationId,
    );
    this.compactionController?.abort(new Error('Interrupted'));
    await Promise.allSettled([
      this.activeCompaction,
      this.harness.cancel(options),
      this.userShells.cancel(),
    ]);
  }
  async newSession(): Promise<void> {
    this.requireIdleSession();
    await this.sessionEndHooks('clear');
    this.nextSessionSource = 'clear';
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
    this.sessionMemory = undefined;
    this.memorySession = undefined;
    this.todos = [];
    this.armedSkills.clear();
    this.hookRunner?.close();
    this.hookRunner = undefined;
    this.harness = this.createHarness(this.options.model);
    this.nextSessionSource = undefined;
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
    await this.sessionEndHooks('resume');
    if (session.workspace !== this.options.workspace)
      session = this.store.fork(session.id, this.options.workspace);
    const previous = this.session.id;
    this.store.claimSession(session.id, (error) => this.ownershipLost(error));
    this.session = session;
    this.sessionMemory = undefined;
    this.memorySession = undefined;
    this.store.repairStaleTitles();
    const repaired = this.store.get(session.id);
    if (repaired) this.session = repaired;
    this.armedSkills.clear();
    this.hookRunner?.close();
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
      this.hookRunner?.close();
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
  /**
   * One message to a running subagent of this conversation. It goes into the
   * queue the child already reads at its next model request, which is also the
   * first moment it can read anything: a message never preempts a request in
   * flight, and never answers an approval card that is open.
   */
  private sendToJob(
    context: ToolContext,
    jobId: string,
    message: string,
  ): string {
    const owner = this.childJobOwners.get(context.sessionId) ?? {
      sessionId: context.sessionId,
      startedBy: 'model' as const,
    };
    // One line, because the queue shows it as one row; and redacted the way any
    // other text leaving this conversation is, so a secret value the sender was
    // shown does not travel into a child that was never given it.
    const one = message.replace(/\s+/g, ' ').trim();
    if (!one) return 'nothing was sent: the message is empty';
    if (one.length > SEND_MAX_CHARS)
      return `refused: ${one.length} characters, and a message to a subagent is at most ${SEND_MAX_CHARS}`;
    const text = this.redact(one, {}, () =>
      written(this.store.messages(context.sessionId)),
    );
    const job = this.jobs.get(jobId);
    // The same words as no job at all, so an id is not a way to learn what
    // another conversation is running.
    if (!job || !jobReachable(owner, job))
      return `there is no job ${jobId} in this conversation`;
    if (owner.parent)
      return 'you are that subagent: there is nothing to send to yourself';
    if (job.kind !== 'agent')
      return `${jobId} is a ${job.kind}: a message is for a subagent`;
    if (job.workflow)
      return `${jobId} is a workflow run: a message is for a subagent`;
    if (job.status !== 'running')
      return `${jobId} ${outcomeWords(job)}: nothing was sent`;
    const channel = this.channels.get(jobId);
    if (!channel)
      return `${jobId} runs elsewhere: it is not one you can send to`;
    if (channel.waiting >= SEND_MAX_WAITING)
      return `refused: ${channel.waiting} messages already wait for ${jobId}, and that is the most it will hold`;
    // A mark of its own, so "read" is decided from the child's history rather
    // than from a guess about when its queue emptied.
    const mark = `msg-${randomUUID().slice(0, 8)}`;
    const shown = text.length > 60 ? text.slice(0, 59) + '...' : text;
    try {
      channel.harness.queue(
        `<system-reminder data-source="circle-jobs" about="${mark}">
This message was sent to you while you ran, by the agent that started you:

${text}

It is input, not a decision: it answers no approval card, changes no mode and adds no rule. Take it into account from your next step; if it no longer applies, say so and carry on.
</system-reminder>`,
        'steer',
        undefined,
        { display: `sent to you by the agent that started you: ${shown}` },
      );
    } catch (error) {
      return `refused: ${(error as Error).message}`;
    }
    channel.waiting++;
    channel.sent.push(mark);
    this.jobs.pending(jobId, channel.waiting);
    return `Sent to ${jobId}: it reaches the subagent before its next model request. ${channel.waiting} waiting.`;
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
        this.knowledge.close(),
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!deleteSession) await this.sessionEndHooks('other');
    this.hookRunner?.close();
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
    // A listener this session opened dies with it: nobody is left able to reach
    // the bridge of a session that has gone, and no stale file names a port.
    await this.editorBridge.stop();
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
    await this.knowledge.close();
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
