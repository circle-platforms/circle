import { FileRewindJournal } from '../../../src/file_rewind.js';
import { ExternalFileGrants } from './workspace/external-file-grants';
import { homedir } from 'node:os';
import {
  githubStatusNotice,
  storedGitHubStatusNotice,
} from '../../../src/runtime_notice.js';
import { commandExecutionReceipt } from '../../../src/command_process.js';
import { canonicalPath } from '../../../src/paths.js';
import type { ResolveInputsRequest } from '../../../src/input_outbox.js';
import { spawnPty } from './workspace/native-pty.js';
import { createTerminalCommandLauncher } from './workspace/command-terminal.js';
import {
  resolveCommandTerminal,
  commandTerminalAction,
  type CommandTerminalSource,
} from './workspace/command-handoff.js';
import { NativeGitHubConnection } from './workspace/github-connection.js';
import { githubWorkspaceBackend } from './workspace/github-backend.js';
import type { GitHubConnectionBackend } from '../../../src/github_connection.js';
import {
  connectionModels,
  connectionSummary,
} from '../../../src/connection_models.js';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, join, relative, isAbsolute, sep } from 'node:path';
import { AgentRuntime, type InteractionContext } from '../../../src/runtime.js';
import { defaultRunOptions } from '../../../src/run_options.js';
import type { Extension, ExtensionCommand } from '../../../src/extensions.js';
import { SessionRuntimeManager } from '../../../src/session_manager.js';
import {
  sessionOccupied,
  SessionOccupiedError,
} from '../../../src/session_lock.js';
import { CheckpointStore } from '../../../src/checkpoint_store.js';
import {
  isTaskWorkspace,
  newTaskName,
  tasksRoot,
  taskWorkspace,
} from '../../../src/paths.js';
import type {
  ChatModel,
  ToolCall,
  Message as CoreMessage,
  MediaAttachment,
} from '../../../src/types.js';
import type { ApprovalDecision } from '../../../src/harness.js';
import type { ModelCompletionFailureCode } from '../../../src/model_completion.js';
import { completionFailure } from '../../../src/model_completion.js';
import { ModelCompletionFailure } from '../../../src/model_completion.js';
import {
  loadSettings,
  settingsForRun,
  saveSettingsChange,
  withConnectionLock,
  saveCredentials,
  clearCredentials,
  withConnection,
  isFolderTrusted,
  trustFolder,
  untrustFolder,
  isReady,
  keepsSavedKey,
  writePrivateJson,
  loadCredentials,
  type CircleSettings,
  VARIABLE_NAME,
} from '../../../src/settings.js';
import {
  discoverCustomCommands,
  substituteArguments,
} from '../../../src/commands.js';
import { BUILTIN_SKILL_SOURCE, loadSkillBody } from '../../../src/skills.js';
import { attachmentFromBase64, MAX_MEDIA_BYTES } from '../../../src/media.js';
import { readPrompt } from '../../../src/system_prompt.js';
import {
  toMarkdown,
  toHtml,
  toSessionBundle,
} from '../../../src/session_export.js';
import {
  browserTools,
  runtimeBrowserOptions,
  type BrowserPort,
} from '../../../src/browser/tools.js';
import type {
  CertificateApproval,
  CoordinateApproval,
  DownloadApproval,
  UploadApproval,
} from '../../../src/browser/protocol.js';
import { sizeText } from '../../../src/browser/files.js';
import {
  terminalTools,
  runtimeTerminalOptions,
  type TerminalPort,
} from '../../../src/terminal/tools.js';
import {
  isLocalTerminal,
  type TerminalHostKeyApproval,
} from '../../../src/terminal/protocol.js';
import { LocalTerminals, type LocalTerminalControl } from './local-terminals';
import type { LocalTerminalRow } from './contracts';
import {
  loadSecrets,
  removeSecret,
  saveSecret,
  secretNames,
} from '../../../src/secrets.js';
import { normalizeBaseUrl, resolveEndpoint } from '../../../src/probe.js';
import { availableUpdate } from '../../../src/update.js';
import { BUILTIN_SLASH } from '../../../src/tui/slash_commands.js';
import { ModelCatalog } from '../../../src/model_catalog.js';
import { VERSION } from '../../../src/version.js';
import {
  dismissWhatsNew,
  pendingWhatsNew,
} from '../../../src/whats_new_state.js';
import type { WhatsNewNotice } from '../../../src/whats_new.js';
import { isSessionMode } from '../../../src/approvals.js';
import { currentBranch } from '../../../src/git_info.js';
import { cacheRateLabel, formatCosts } from '../../../src/pricing.js';
import { TurnStatus } from '../../../src/tui/turn_status.js';
import { currentNetworkStatus } from '../../../src/net.js';
import { SessionMetadata } from './session-metadata';
import { WorkspaceServices } from './workspace/workspace-services';
import { OperationLedger } from './workspace/operation-ledger';
import {
  TaskService,
  readTaskLimits,
  readTaskSettingsRecovery,
  type TaskSettingsWorkspace,
  writeTaskLimits,
} from './workspace/task-service';
import {
  readArchivedTaskAttempts,
  taskToolAgentIds,
  taskNeedsReconciliation,
  assertReadonlyTaskRequest,
} from './workspace/task-agent-projection';
import { createTaskVerifier } from './workspace/task-verification';
import {
  CollaborationResources,
  bindToolResource,
} from './workspace/collaboration';
import { TASK_RESOURCES } from './workspace/task-store';
import { createCollaborationTools } from './workspace/collaboration-tools';
import type { TaskRecord } from './workspace/task-store';
import type { FileMutations } from '../../../src/file_mutations.js';
import { wrapModelCompletion } from '../../../src/model_wrapper.js';
import type { RuntimeCredentialStore } from './runtime-private-channel';
import {
  validateWorkspaceRequest,
  type WorkspaceServiceEvent,
  type WorkspaceServiceRequest,
} from './workspace-protocol';
import { formatMcpArguments, parseMcpArguments } from './mcp-arguments';
import { PlanCompletionTracker } from '../../../src/plan_state.js';
import { nextAgentActivity } from '../../../src/session_activity.js';
import {
  formatElapsed,
  gapElapsed,
  type TurnUsage,
} from '../../../src/tui/status_rows.js';
import {
  approvalPreview,
  fileChange,
} from '../../../src/tui/approval_preview.js';
import type { CardLine } from '../../../src/ink/components/dialog_card.js';
class DisconnectedModel implements ChatModel {
  model = 'not connected';
  async complete(): Promise<never> {
    throw Error('connect an API URL, key and model first');
  }
}
import {
  submitAnswer,
  cancelRequest,
  type SecretRequest,
} from '../../../src/secret_prompt.js';
import { elapsed, outputTail } from '../../../src/jobs.js';
import type { CircleEvent } from '../../../src/events.js';
import type {
  WorkbenchSnapshot,
  Session,
  Message,
  Interaction,
  Effort,
  DiffView,
  AgentRecord,
} from '../../workbench/src/model/types';
import {
  validateRuntimeCommand,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeUpdate,
  type RuntimeTokenDelta,
} from './runtime-protocol';

const identity = (path: string) =>
  createHash('sha256').update(path).digest('hex').slice(0, 24);
const text = (value: unknown, label: string, max = 1_000_000) => {
  if (typeof value !== 'string' || value.length > max)
    throw Error(`invalid ${label}`);
  return value;
};
const flag = (value: unknown) => {
  if (typeof value !== 'boolean') throw Error('boolean required');
  return value;
};
// True when child is parent itself or a folder inside it. relative() answers with an
// absolute path when the two roots differ, as on separate Windows drives.
const folderContains = (parent: string, child: string): boolean => {
  if (parent === child) return true;
  const relation = relative(parent, child);
  return (
    relation !== '' &&
    !isAbsolute(relation) &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`)
  );
};
// The app has room for longer diffs than the terminal's card.
const DIFF_ROWS = 400;
// The tools that change files; a recorded browser script is one the model wrote
const FILE_TOOLS = [
  'write_file',
  'edit_file',
  'apply_patch',
  'delete',
  'browser_record',
];
const TASK_STATUS_EVENTS = new Set([
  'task.queued',
  'task.preparing',
  'task.running',
  'task.waiting',
  'task.cancelling',
  'task.succeeded',
  'task.failed',
  'task.blocked',
  'task.cancelled',
  'task.interrupted',
  'task.needs_review',
  'task.session',
  'task.runtime-state',
  'task.reviewer',
]);
const diffView = (lines: CardLine[]): DiffView | undefined =>
  lines.length
    ? {
        summary: lines[0]!.text,
        rows: lines
          .slice(1)
          .map((line) =>
            line.tone === 'added' || line.tone === 'removed'
              ? { text: line.text, tone: line.tone }
              : { text: line.text },
          ),
      }
    : undefined;
// The paths a file tool call changes: a patch names its own.
function changedPaths(name: string, args: Record<string, unknown>): string[] {
  if (name === 'apply_patch')
    return [
      ...String(args.patchText ?? '').matchAll(
        /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+)$/gm,
      ),
    ].map((match) => match[1]!.trim());
  const path = String(args.file_path ?? args.path ?? '');
  return path ? [path] : [];
}
// A file's text, or undefined when it is missing, too large or not text.
function readText(path: string): string | undefined {
  try {
    if (!existsSync(path) || statSync(path).size > 256 * 1024) return undefined;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      readFileSync(path),
    );
  } catch {
    return undefined;
  }
}
interface Pending {
  row: Interaction;
  signal: AbortSignal;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  secret?: SecretRequest;
}
interface Streaming {
  id: string;
  text: string;
  thinking: string;
}
export interface ControllerOptions {
  home: string;
  emitWorkspaceEvent?: (event: WorkspaceServiceEvent) => void;
  emitTokenDelta?: (delta: RuntimeTokenDelta) => void;
  credentialStore?: RuntimeCredentialStore;
  workspaceTools?: {
    runtimeExecutable: string;
    ghPath: string;
    /** Bundled static supervisor; no source-directory or PATH fallback. */
    commandSupervisorPath?: string;
  };
  /** The application's data folder, which holds home beside the updates and Chromium's
   * own files: the default workspace may not be in it. Home when not given. */
  dataFolder?: string;
  workspace?: string;
  userHome?: string;
  model?: ChatModel;
  catalog?: (home: string) => ModelCatalog;
  emit: (update: RuntimeUpdate) => void;
  /** A link an extension asked for: the window opens it in its browser panel; with no
   * window the main process opens it in the system browser. */
  openUrl?: (url: string) => void;
  /** The conversation browsers in the main process; without it there are no browser tools. */
  browser?: BrowserPort;
  /** The conversation device terminals in the main process. */
  terminal?: TerminalPort;
  /**
   * What Circle is doing with a conversation's own terminal tabs changed: the window's
   * terminal state carries it (TerminalState.local).
   */
  emitTerminalTabs?: (conversation: string, rows: LocalTerminalRow[]) => void;
  beforeDelete?: (sessionId: string) => Promise<void>;
}

/** The IPC adapter delegates execution and persistence to the existing Circle core. */
export class RuntimeController {
  readonly home: string;
  private metadata: SessionMetadata;
  private planCompletions = new Map<string, PlanCompletionTracker>();
  private activities = new Map<string, string>();
  private notices = new Map<
    string,
    {
      id: string;
      after: string | null;
      text: string;
      at: string;
      planCompleted?: number;
    }[]
  >();
  private runtimes = new SessionRuntimeManager((workspace, sessionId) =>
    this.createRuntime(workspace, sessionId),
  );
  // The person's own terminal tabs, as the model's terminal tools reach them, and what
  // the window was last told of each conversation's
  private readonly terminalTabs = new LocalTerminals({
    host: (conversation) => this.terminalTabHost(conversation),
    changed: (conversation) => this.terminalTabsChanged(conversation),
    mode: (conversation) =>
      (
        this.runtimes.get(conversation) ??
        [...this.taskRuntimes.values()].find(
          (runtime) => runtime.session.id === conversation,
        )
      )?.mode,
    waiting: (conversation) =>
      new Set(this.terminalTabApprovals().get(conversation) ?? []),
  });
  private terminalTabRows = new Map<string, string>();
  private terminalTabWaits = new Map<string, string>();
  private workspaceSessions = new Map<string, string>();
  private readonly store: CheckpointStore;
  // The last link an extension asked to open; the window opens each id once.
  private openRequest?: { id: string; url: string; sessionId: string };
  private active!: AgentRuntime;
  // Inspecting another process's history never acquires its execution lease.
  private viewedSessionId?: string;
  private pendingTrustReloads = new Set<AgentRuntime>();
  private previous: string | null = null;
  private sequence = 0;
  private tokenEpoch = randomUUID();
  private tokenSequence = 0;
  private pending = new Map<string, Pending>();
  private history: Interaction[] = [];
  private streams = new Map<string, Streaming>();
  private activeRuns = new Set<string>();
  // Turns that failed, per session: shown in the conversation after the message they
  // followed, as the terminal shows its red line. They live as long as the app runs.
  private failures = new Map<
    string,
    {
      id: string;
      after: string | null;
      text: string;
      at: string;
      completionFailure?: ModelCompletionFailureCode;
    }[]
  >();
  private toolStates = new Map<
    string,
    { status: 'running' | 'waiting' | 'error' | 'success'; output?: string }
  >();
  // Per `${session}:${call}`: the diff a file tool showed before it ran.
  private diffs = new Map<string, DiffView>();
  // Per session and resolved path: the file before this session's first change to it
  // (undefined: it did not exist), and how it differs now.
  private changes = new Map<
    string,
    Map<string, { original: string | undefined; diff?: DiffView; at: string }>
  >();
  // Each session's finished turns, by their last message: time and tokens, in memory only
  private turnUsage = new Map<string, Record<string, TurnUsage>>();
  private turns = new Map<
    string,
    { status: TurnStatus; started: number; waited: number; since?: number }
  >();
  private error?: string;
  private closing = false;
  private closePromise?: Promise<void>;
  private mutation = Promise.resolve();
  private workspaceServices = new Map<string, WorkspaceServices>();
  private taskServices = new Map<string, TaskService>();
  private archivedTaskAttempts = new Map<string, readonly TaskRecord[]>();
  private taskProjectionErrors = new Map<
    string,
    {
      message: string;
      workspace: string;
      worktrees: string;
    }
  >();
  private taskProjectionPending = false;
  private readonly taskResources: CollaborationResources;
  private readonly taskSettingsPath: string;
  private readonly taskSettingsRecoveryPath: string;
  private taskSettingsError?: string;
  private taskQueuesPausedForSettings = false;
  private taskQueuesStarted = new Map<string, TaskSettingsWorkspace>();
  private taskVerifiers = new Map<
    string,
    ReturnType<typeof createTaskVerifier>
  >();
  private taskWorkspaces = new Map<string, string>();
  private workspaceRoots = new Map<
    string,
    { canonical: string; dev: number; ino: number }
  >();
  private taskRuntimes = new Map<string, AgentRuntime>();
  private workspaceEventPending = new Set<Promise<unknown>>();
  private workspaceStreamFailures = new Map<string, string>();
  private workspaceEpoch = randomUUID();
  private workspaceSeq = 0;
  private stoppedJobs = new Set<string>();
  private operationLedger?: Promise<OperationLedger>;
  private accepted = new Map<
    string,
    { signature: string; reply: Promise<RuntimeReply> }
  >();
  private tasks = new Set<Promise<unknown>>();
  private cancelling = new Set<string>();
  private discoveredModels: string[] = [];
  // What the connection form's last probe found, so that saving that endpoint lists its
  // models. Never the key.
  private probed?: { baseUrl: string; protocol: string; models: string[] };
  // Whether a key is saved, read once and again after configure or logout.
  private keySaved?: boolean;
  // A workspace's git branch, read at most every two seconds: snapshots follow tokens.
  private branches = new Map<string, { branch: string; at: number }>();
  // Folders chosen on home before a message is sent. Remembering one does not
  // write a session. The first message creates that session.
  private opened = new Set<string>();
  private branch(path: string): string {
    const cached = this.branches.get(path);
    if (cached && Date.now() - cached.at < 2000) return cached.branch;
    const branch = currentBranch(path);
    this.branches.set(path, { branch, at: Date.now() });
    return branch;
  }
  // The effective default workspace and, when that is not the built-in scratch
  // folder, the scratch folder's path if it still holds files: the settings page
  // names it so the user can delete it by hand. Read at most every two seconds
  // like branch(): snapshots follow tokens.
  private defaultFolder?: { folder: string; stale?: string; at: number };
  /** Upgrade notes still waiting. Cleared when the home page dismisses them. */
  private whatsNew?: WhatsNewNotice;
  constructor(readonly options: ControllerOptions) {
    this.home = options.home;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.taskSettingsPath = join(
      options.dataFolder ?? this.home,
      'workspace-services',
      'task-settings.json',
    );
    this.taskSettingsRecoveryPath = join(
      options.dataFolder ?? this.home,
      'workspace-services',
      'task-settings-recovery.json',
    );
    // Ordinary parents use this pool before any task service exists.
    let initialLimits = { agents: 1, builds: 1, ui: 1, browsers: 1 };
    try {
      initialLimits = readTaskLimits(this.taskSettingsPath);
      const recovery = readTaskSettingsRecovery(this.taskSettingsRecoveryPath);
      if (recovery) {
        this.taskQueuesPausedForSettings = true;
        this.taskQueuesStarted = new Map(
          recovery.map((row) => [row.canonical, row]),
        );
      }
    } catch (error) {
      // Keep history and original settings reachable, but never run with a
      // silently increased cap when the saved limits cannot be read.
      initialLimits = { agents: 1, builds: 1, ui: 1, browsers: 1 };
      this.taskSettingsError = (error as Error).message;
      this.taskQueuesPausedForSettings = true;
    }
    this.taskResources = new CollaborationResources(initialLimits);
    this.metadata = new SessionMetadata(this.home);
    this.store = new CheckpointStore(this.home);
    this.store.repairStaleTitles();
    for (const session of this.store.list(undefined, true)) {
      try {
        this.bindWorkspace(session.workspace);
      } catch {
        /* Deleted histories require explicitly reopening an existing folder. */
      }
    }
    this.whatsNew = pendingWhatsNew(this.home);
    const saved = this.savedLocation();
    const settings = loadSettings(this.home);
    const workspace =
      options.workspace ??
      saved?.workspace ??
      this.configuredWorkspace(settings) ??
      join(this.home, 'workspace');
    mkdirSync(workspace, { recursive: true });
    // The empty, app-owned scratch workspace is safe to initialize without user files.
    if (workspace === join(this.home, 'workspace'))
      saveSettingsChange(this.home, (saved) => {
        Object.assign(saved, trustFolder(saved, workspace));
      });
    try {
      this.active = this.runtime(workspace, saved?.sessionId);
    } catch (error) {
      if (!(error instanceof SessionOccupiedError)) {
        this.store.close();
        throw error;
      }
      // Another terminal may have resumed the last desktop session meanwhile.
      this.active = this.runtime(workspace);
    }
  }
  /** Load trusted startup integrations without starting a model turn. The worker
   * publishes its first frame before this work, so a slow MCP connection cannot
   * make a running core look disconnected. Commands remain serialized with it. */
  initialize(): Promise<void> {
    const runtime = this.active;
    const ready = this.mutation.then(async () => {
      if (this.closing) return;
      try {
        if (
          !isFolderTrusted(loadSettings(this.home), runtime.options.workspace)
        )
          return;
        await runtime.initialize();
      } catch (error) {
        if (!this.closing)
          this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.publish();
      }
    });
    this.mutation = ready;
    return ready;
  }
  private scratchPath(): string {
    return join(this.home, 'workspace');
  }
  // Whether a folder is the built-in scratch one, in either spelling: a stored
  // path is realpath'd, while home may not be (a temp folder behind a symlink).
  private isScratch(target: string): boolean {
    const scratch = this.scratchPath();
    if (target === scratch) return true;
    try {
      return target === realpathSync.native(scratch);
    } catch {
      return false;
    }
  }
  // The default workspace may not expose the app's own data: not the data folder,
  // not a folder inside it, not a folder containing it. The scratch folder is the
  // one exception: choosing it again resets the default. The data folder itself is
  // compared by its real path: home may sit behind a link, while a chosen path
  // always arrives realpath'd, and the two spellings would otherwise slip past.
  private acceptableDefaultFolder(target: string): boolean {
    if (this.isScratch(target)) return true;
    let data = this.options.dataFolder ?? this.home;
    try {
      data = realpathSync.native(data);
    } catch {
      /* Keep the spelling we were given. */
    }
    return !folderContains(data, target) && !folderContains(target, data);
  }
  // The configured default workspace, or undefined when the built-in scratch folder
  // is the default: no folder is configured, or the configured one is missing, is
  // not a directory, or is one the app must not run in. Callers fall back silently.
  private configuredWorkspace(settings: CircleSettings): string | undefined {
    if (!settings.workspace_folder) return undefined;
    try {
      const target = realpathSync.native(settings.workspace_folder);
      if (!statSync(target).isDirectory() || this.isScratch(target))
        return undefined;
      return this.acceptableDefaultFolder(target) ? target : undefined;
    } catch {
      return undefined;
    }
  }
  // Where a task that belongs to no project gets a folder of its own. The built-in one
  // sits inside the data folder, as the scratch folder does; a folder the person points at
  // may not expose the app's own data, for the same reason the default workspace may not.
  private tasksPath(): string {
    return tasksRoot(this.home);
  }
  private tasksRootFor(settings: CircleSettings): string {
    const built = this.tasksPath();
    if (!settings.task_folder) return built;
    try {
      const target = realpathSync.native(settings.task_folder);
      if (!statSync(target).isDirectory()) return built;
      return target === built || this.acceptableDefaultFolder(target)
        ? target
        : built;
    } catch {
      return built;
    }
  }
  // Whether a workspace is where the app falls back to rather than a project the person
  // opened: the default workspace, the folder no-project conversations shared before,
  // or one of the task folders before it.
  private isDefaultWorkspace(
    current: string,
    settings: CircleSettings,
  ): boolean {
    const fallback = this.defaultWorkspace(settings).folder;
    // The fallback folder may not exist yet, and home may sit behind a link: compare
    // both spellings, and never fail a command over a path that is simply missing.
    let same = current === fallback;
    if (!same) {
      try {
        same = current === realpathSync.native(fallback);
      } catch {
        /* Nothing to compare against yet. */
      }
    }
    return (
      same ||
      this.isUnscoped(current) ||
      isTaskWorkspace(current, this.tasksRootFor(settings))
    );
  }
  /**
   * A task that belongs to no project gets a folder of its own under the task folder,
   * trusted as Circle's own scratch folder is, so its files and its history sit apart
   * and it can be deleted whole.
   */
  private taskFolder(): string {
    const settings = loadSettings(this.home);
    const folder = taskWorkspace(newTaskName(), this.tasksRootFor(settings));
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const resolved = realpathSync.native(folder);
    if (!isFolderTrusted(settings, resolved))
      saveSettingsChange(this.home, (saved) => {
        Object.assign(saved, trustFolder(saved, resolved));
      });
    return resolved;
  }
  /**
   * The runtime for a new session started where no project is. Nothing happens when
   * the person is working in a project: a new session there stays in it. The runtime
   * made for a fresh task folder opens on a conversation of its own, which is the new
   * session.
   */
  private async projectlessTask(
    runtime: AgentRuntime,
    previous: string,
  ): Promise<AgentRuntime | undefined> {
    const current = runtime.options.workspace;
    if (!this.isDefaultWorkspace(current, loadSettings(this.home)))
      return undefined;
    const owner = this.runtimes.create(this.taskFolder());
    // The extensions the person had running come along, as for any new session.
    await this.carryExtensions(owner, previous);
    this.selectRuntime(owner);
    return owner;
  }
  private defaultWorkspace(settings: CircleSettings): {
    folder: string;
    stale?: string;
  } {
    if (this.defaultFolder && Date.now() - this.defaultFolder.at < 2000)
      return this.defaultFolder;
    const configured = this.configuredWorkspace(settings);
    const scratch = this.scratchPath();
    let stale: string | undefined;
    if (configured) {
      try {
        if (readdirSync(scratch).length > 0) stale = scratch;
      } catch {
        /* The scratch folder is already gone: nothing to clean up. */
      }
    }
    this.defaultFolder = {
      folder: configured ?? scratch,
      stale,
      at: Date.now(),
    };
    return this.defaultFolder;
  }
  private savedLocation():
    { workspace: string; sessionId: string } | undefined {
    try {
      const data = JSON.parse(
        readFileSync(join(this.home, 'desktop-session.json'), 'utf8'),
      );
      if (
        typeof data.workspace === 'string' &&
        existsSync(data.workspace) &&
        typeof data.sessionId === 'string'
      )
        return data;
    } catch {
      /* First launch has no active session. */
    }
    return undefined;
  }
  private runtime(workspace: string, sessionId?: string): AgentRuntime {
    workspace = realpathSync.native(workspace);
    const remembered = sessionId ?? this.workspaceSessions.get(workspace);
    const owner = remembered ? this.runtimes.get(remembered) : undefined;
    if (owner && this.runtimes.lifecycle(owner.session.id) === 'open')
      return owner;
    const runtime = this.runtimes.open(workspace, sessionId);
    this.workspaceSessions.set(workspace, runtime.session.id);
    return runtime;
  }
  private selectRuntime(runtime: AgentRuntime): void {
    this.externalSelectionEpoch++;
    const leaving = this.active;
    if (leaving && leaving !== runtime) leaving.yieldLease();
    if (!runtime.resumeLease()) {
      this.previous = this.selectedSessionId;
      this.viewedSessionId = runtime.session.id;
      return;
    }
    this.previous = this.selectedSessionId;
    this.active = runtime;
    this.viewedSessionId = undefined;
    this.workspaceSessions.set(runtime.options.workspace, runtime.session.id);
  }
  private get selectedSessionId(): string {
    return this.viewedSessionId ?? this.active.session.id;
  }
  private get selectedWorkspace(): string {
    return this.viewedSessionId
      ? (this.store.get(this.viewedSessionId)?.workspace ??
          this.active.options.workspace)
      : this.active.options.workspace;
  }
  private async reloadTrustedRuntime(runtime: AgentRuntime): Promise<void> {
    if (
      !this.pendingTrustReloads.has(runtime) ||
      runtime.busy ||
      runtime.isClosing ||
      this.closing
    )
      return;
    this.pendingTrustReloads.delete(runtime);
    try {
      await runtime.reloadIntegrations();
    } catch (error) {
      if (!runtime.isClosing) this.pendingTrustReloads.add(runtime);
      throw error;
    }
  }
  /** The saved thinking depth, on every open runtime except one that was just set. */
  private applySharedEffort(saved: string, skip?: AgentRuntime): void {
    const level = saved || 'default';
    for (const owner of this.runtimes.values()) {
      if (owner === skip || owner.isClosing) continue;
      owner.applyThinkingChoice(level);
    }
  }
  private synchronizeSharedSettings(settings: CircleSettings): void {
    if (settings.extensions.github?.enabled !== true) {
      this.githubLeases.clear();
      this.githubProviderLifetime.abort();
      for (const owner of this.runtimes.values()) {
        owner.options.settings.extensions.github = {
          ...owner.options.settings.extensions.github,
          enabled: false,
        };
        void owner.setBundledExtensionEnabled('github', false).catch(() => {});
      }
      for (const owner of this.taskRuntimes.values()) {
        owner.options.settings.extensions.github = {
          ...owner.options.settings.extensions.github,
          enabled: false,
        };
        void owner.setBundledExtensionEnabled('github', false).catch(() => {});
      }
    }
    if (settings.extensions.github?.enabled === true) {
      for (const owner of [
        ...this.runtimes.values(),
        ...this.taskRuntimes.values(),
      ]) {
        owner.options.settings.extensions.github = {
          ...owner.options.settings.extensions.github,
          enabled: true,
        };
        void owner.setBundledExtensionEnabled('github', true).catch(() => {});
      }
    }
    for (const owner of this.runtimes.values()) {
      if (
        !owner.options.localContext &&
        isFolderTrusted(settings, owner.options.workspace) &&
        !owner.isClosing
      ) {
        owner.options.localContext = true;
        this.pendingTrustReloads.add(owner);
      }
      if (
        owner.options.localContext &&
        !isFolderTrusted(settings, owner.options.workspace) &&
        !owner.isClosing
      ) {
        // The click that took a folder away takes its code out of the run too.
        owner.options.localContext = false;
        this.pendingTrustReloads.add(owner);
      }
      Object.assign(owner.options.settings, {
        theme: settings.theme,
        hide_thinking: settings.hide_thinking,
        double_escape: settings.double_escape,
        update_check: settings.update_check,
        enabled_models: [...settings.enabled_models],
        credential_files: [...settings.credential_files],
        variables: { ...settings.variables },
        trusted_folders: [...settings.trusted_folders],
      });
    }
  }
  private async releaseSessionResources(
    sessionId: string,
    workspace: string,
  ): Promise<void> {
    const owned = new Map<string, string>();
    owned.set(sessionId, workspace);
    for (const service of this.taskServices.values())
      for (const child of service.ownedRuntimeSessions(sessionId))
        owned.set(child.sessionId, child.worktree ?? workspace);
    const results = await Promise.allSettled(
      [...this.taskServices.values()].map((service) =>
        service.cancelSession(sessionId),
      ),
    );
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(errors, 'session task cleanup failed');
    for (const [id, root] of owned) {
      // Circle lets go of the conversation's terminal tabs before their shells close
      this.terminalTabs.release(id);
      this.terminalTabRows.delete(id);
      this.terminalTabWaits.delete(id);
      await this.workspaceServices
        .get(this.workspaceRoots.get(root)?.canonical ?? root)
        ?.releaseSession(id);
      if (id !== sessionId) await this.options.beforeDelete?.(id);
    }
  }

  private async nativeSessionActive(
    sessionId: string,
    workspace: string,
  ): Promise<boolean> {
    return (
      [...this.taskServices.values()].some((service) =>
        service.hasActiveSession(sessionId),
      ) ||
      (await this.workspaceServices
        .get(workspace)
        ?.hasActiveSession(sessionId)) === true
    );
  }
  private nativeSessionActiveNow(
    sessionId: string,
    workspace: string,
  ): boolean {
    return (
      [...this.taskServices.values()].some((service) =>
        service.hasActiveSession(sessionId),
      ) ||
      this.workspaceServices
        .get(this.workspaceRoots.get(workspace)?.canonical ?? workspace)
        ?.hasActiveSessionNow(sessionId) === true
    );
  }
  private workspaceEvent(
    workspace: string,
    event: WorkspaceServiceEvent,
  ): void {
    if (this.workspaceStreamFailures.has(workspace)) return;
    const failure = (error: unknown) => this.workspaceFailure(workspace, error);
    try {
      const services = this.closing
        ? this.workspaceServices.get(workspace)
        : this.services(workspace);
      if (!services) return;
      const pending = services.publishSource(event);
      this.workspaceEventPending.add(pending);
      void pending
        .catch(failure)
        .finally(() => this.workspaceEventPending.delete(pending));
    } catch (error) {
      failure(error);
    }
  }

  private workspaceFailure(workspace: string, error: unknown): void {
    if ((error as { code?: string })?.code === 'WORKSPACE_SERVICES_CLOSED')
      return;
    if (this.workspaceStreamFailures.has(workspace)) return;
    const message = `workspace event persistence failed: ${String(error)}`;
    this.workspaceStreamFailures.set(workspace, message);
    this.error = message;
    const origin = this.taskWorkspaces.get(workspace) ?? workspace;
    void this.taskServices
      .get(origin)
      ?.close()
      .catch(() => {});
    for (const runtime of [
      ...this.runtimes.values(),
      ...this.taskRuntimes.values(),
    ])
      if (
        (this.taskWorkspaces.get(runtime.options.workspace) ??
          runtime.options.workspace) === origin
      )
        void runtime.cancel({ keepQueue: false }).catch(() => {});
    if (!this.closing) this.publish();
  }
  private bindWorkspace(workspace: string): void {
    const canonical = realpathSync.native(workspace);
    const directory = statSync(canonical);
    if (!directory.isDirectory()) throw Error('workspace must be a directory');
    const previous = this.workspaceRoots.get(workspace);
    if (
      previous &&
      (previous.canonical !== canonical ||
        previous.dev !== directory.dev ||
        previous.ino !== directory.ino)
    )
      throw Error('workspace root changed; reopen and authorize the folder');
    const canonicalBinding = this.workspaceRoots.get(canonical);
    if (
      canonicalBinding &&
      (canonicalBinding.dev !== directory.dev ||
        canonicalBinding.ino !== directory.ino)
    )
      throw Error('workspace root changed; reopen and authorize the folder');
    const binding = { canonical, dev: directory.dev, ino: directory.ino };
    if (!previous) this.workspaceRoots.set(workspace, binding);
    if (!canonicalBinding) this.workspaceRoots.set(canonical, binding);
  }
  private workspaceRoot(workspace: string): string {
    const bound = this.workspaceRoots.get(workspace);
    if (!bound)
      throw Error('workspace authorization is missing; reopen the folder');
    const canonical = realpathSync.native(workspace);
    const directory = statSync(canonical);
    if (
      canonical !== bound.canonical ||
      directory.dev !== bound.dev ||
      directory.ino !== bound.ino
    )
      throw Error('workspace root changed; reopen and authorize the folder');
    return bound.canonical;
  }
  private trustedWorkspace(workspace: string): string {
    const canonical = this.workspaceRoot(workspace);
    const origin = this.taskWorkspaces.get(canonical) ?? canonical;
    if (origin !== canonical) this.trustedWorkspace(origin);
    if (!isFolderTrusted(loadSettings(this.home), origin))
      throw Error('trust this workspace first');
    return canonical;
  }
  private validWorkspaceRoot(workspace: string): boolean {
    try {
      this.workspaceRoot(workspace);
      return true;
    } catch {
      return false;
    }
  }
  private githubProfile?: NativeGitHubConnection;
  private githubLeases = new Map<string, number>();
  private githubProviderLifetime = new AbortController();
  private githubAvailable(id: string): boolean {
    if (loadSettings(this.home).extensions.github?.enabled !== true) {
      this.githubLeases.clear();
      this.githubProviderLifetime.abort();
      return false;
    }
    return (this.githubLeases.get(id) ?? 0) > 0;
  }
  private githubInvocation(id: string) {
    const lifetime = this.githubProviderLifetime;
    return {
      signal: lifetime.signal,
      assertActive: () => {
        lifetime.signal.throwIfAborted();
        if (
          lifetime !== this.githubProviderLifetime ||
          !this.githubAvailable(id)
        )
          throw Error('GitHub extension is disabled');
      },
    };
  }
  private githubConnection(): NativeGitHubConnection | undefined {
    if (!this.options.workspaceTools?.ghPath) return undefined;
    return (this.githubProfile ??= new NativeGitHubConnection({
      dataDir: join(this.options.dataFolder ?? this.home, 'github-connection'),
      ghPath: this.options.workspaceTools.ghPath,
      nodePath: this.options.workspaceTools.runtimeExecutable,
      spawn: (file, args, options) => spawnPty(file, args, options),
      credentialStore: this.options.credentialStore
        ? {
            get: () => this.options.credentialStore!.get('github.com'),
            put: (token) =>
              this.options.credentialStore!.put('github.com', token),
            delete: () => this.options.credentialStore!.delete('github.com'),
          }
        : undefined,
    }));
  }
  private githubBackend(
    workspace: string,
    owner: () => string,
  ): GitHubConnectionBackend | undefined {
    const connection = this.githubConnection();
    if (!connection) return undefined;
    return githubWorkspaceBackend({
      connection,
      assertEnabled: () => {
        if (!this.githubAvailable(owner()))
          throw Error('GitHub extension is disabled');
      },
      providerSignal: () => this.githubProviderLifetime.signal,
      delivery: () => this.services(workspace).deliveryAdapter(),
      runWrite: async (method, params, callId, action) => {
        const sessionId = owner();
        const root = this.trustedWorkspace(workspace);
        return (await this.ledger()).run(
          {
            id: createHash('sha256')
              .update(JSON.stringify(['github', sessionId, callId]))
              .digest('hex'),
            sessionId,
            service: 'github',
            method,
            paramsHash: createHash('sha256')
              .update(JSON.stringify({ workspace: root, params }))
              .digest('hex'),
          },
          action,
        );
      },
      acquireLease: () => {
        const id = owner();
        if (loadSettings(this.home).extensions.github?.enabled !== true)
          throw Error('GitHub extension is disabled');
        if (this.githubProviderLifetime.signal.aborted)
          this.githubProviderLifetime = new AbortController();
        const lifetime = this.githubProviderLifetime;
        this.githubLeases.set(id, (this.githubLeases.get(id) ?? 0) + 1);
        return () => {
          if (
            lifetime !== this.githubProviderLifetime ||
            lifetime.signal.aborted
          )
            return;
          const next = (this.githubLeases.get(id) ?? 0) - 1;
          if (next > 0) this.githubLeases.set(id, next);
          else this.githubLeases.delete(id);
        };
      },
    });
  }
  private services(workspace: string): WorkspaceServices {
    const root = this.trustedWorkspace(workspace);
    let services = this.workspaceServices.get(root);
    if (!services) {
      const resourceStates = new Map<string, boolean>();
      const tools = this.options.workspaceTools ?? {
        runtimeExecutable: process.execPath,
        ghPath: 'gh',
      };
      services = new WorkspaceServices({
        workspaceRoot: root,
        dataDir: join(
          this.options.dataFolder ?? this.home,
          'workspace-services',
        ),
        ...tools,
        githubConnection: this.githubConnection(),
        enforceGitHubConnection: true,
        githubEnabled: (id) => this.githubAvailable(id),
        githubInvocation: (id) => this.githubInvocation(id),
        credentialStore: this.options.credentialStore
          ? {
              get: () => this.options.credentialStore!.get('github.com'),
              put: (token) =>
                this.options.credentialStore!.put('github.com', token),
              delete: () => this.options.credentialStore!.delete('github.com'),
            }
          : undefined,
        workspaceId: identity(root),
        credentialFiles: settingsForRun(this.home, root).settings
          .credential_files,
        emit: (event) => {
          this.options.emitWorkspaceEvent?.(event);
          // Output stays on its own stream. Publish session availability only
          // when resource ownership changes, including a shell exiting by itself.
          const active = this.nativeSessionActiveNow(event.sessionId, root);
          if ((resourceStates.get(event.sessionId) ?? false) !== active) {
            resourceStates.set(event.sessionId, active);
            this.publish();
          }
        },
        onPersistenceError: (error) => this.workspaceFailure(root, error),
      });
      this.workspaceServices.set(root, services);
      this.terminalTabs.watch(services.terminals);
    }
    services.setCredentialFiles(
      settingsForRun(this.home, root).settings.credential_files,
    );
    return services;
  }
  /** The terminal service of a conversation's folder, if one was opened; never opens one. */
  private terminalTabHost(conversation: string) {
    const row = this.store.get(conversation);
    const root = row && this.workspaceRoots.get(row.workspace)?.canonical;
    return root ? this.workspaceServices.get(root)?.terminals : undefined;
  }
  /** The window is told what Circle does with a conversation's tabs, when that changed. */
  private terminalTabsChanged(conversation: string): void {
    if (this.closing) return;
    const rows = this.terminalTabs.rows(conversation);
    const shown = JSON.stringify(rows);
    if (this.terminalTabRows.get(conversation) === shown) return;
    this.terminalTabRows.set(conversation, shown);
    this.options.emitTerminalTabs?.(conversation, rows);
  }
  /** The tabs each conversation's open approvals are for, as `local:<id>`. */
  private terminalTabApprovals(): Map<string, string[]> {
    const waits = new Map<string, string[]>();
    for (const { row } of this.pending.values()) {
      const terminal =
        row.kind === 'approval' ? row.input?.terminal : undefined;
      if (isLocalTerminal(terminal))
        waits.set(row.sessionId, [
          ...(waits.get(row.sessionId) ?? []),
          terminal,
        ]);
    }
    return waits;
  }
  /** An approval for a tab opened or closed: its state is `waiting`, or no longer. */
  private refreshTerminalTabWaits(): void {
    const waits = this.terminalTabApprovals();
    for (const conversation of new Set([
      ...waits.keys(),
      ...this.terminalTabWaits.keys(),
    ])) {
      const now = JSON.stringify((waits.get(conversation) ?? []).sort());
      if ((this.terminalTabWaits.get(conversation) ?? '[]') === now) continue;
      if (now === '[]') this.terminalTabWaits.delete(conversation);
      else this.terminalTabWaits.set(conversation, now);
      this.terminalTabsChanged(conversation);
    }
  }
  /**
   * The person takes one of their terminal tabs (`take`), hands it back (`return`) or
   * stops what Circle does on it (`stop`), from the window. The answer is the
   * conversation's tabs as they are now.
   */
  async terminalTabControl(
    conversation: string,
    session: string,
    action: LocalTerminalControl,
  ): Promise<LocalTerminalRow[]> {
    if (!this.store.get(conversation)) throw Error('session not found');
    const rows = await this.terminalTabs.control(conversation, session, action);
    this.terminalTabRows.set(conversation, JSON.stringify(rows));
    return rows;
  }
  private externalFiles?: ExternalFileGrants;
  private externalGrantOwners = new Map<string, AgentRuntime>();
  private externalSelectionEpoch = 0;
  private externalBlocked = new Set<string>();
  /** Why a session's last deletion failed. It stays in deletion, with its history, until
   * deleting it again succeeds (#195). */
  private deletionFailures = new Map<string, string>();
  private externalRegistry(): ExternalFileGrants {
    const registry = (this.externalFiles ??= new ExternalFileGrants({
      protectedRoots: [
        this.home,
        this.options.dataFolder ?? this.home,
        join(homedir(), '.circle'),
        join(homedir(), 'Library', 'Application Support', 'Circle'),
        join(homedir(), 'Library', 'Application Support', 'Circle Beta'),
      ],
    }));
    // Project credential patterns can change while an approval is pending.
    // Apply the conservative union before every capability read/commit check.
    registry.setCredentialFiles([
      ...new Set(
        [...this.runtimes.values()].flatMap(
          (owner) =>
            settingsForRun(this.home, owner.options.workspace).settings
              .credential_files,
        ),
      ),
    ]);
    return registry;
  }
  private externalOwner(
    sessionId: string,
    access: 'read' | 'write',
    selected = false,
  ): AgentRuntime {
    const owner = this.runtimes.get(sessionId);
    if (
      this.closing ||
      this.externalBlocked.has(sessionId) ||
      !owner ||
      owner.session.id !== sessionId ||
      owner.isClosing ||
      this.runtimes.lifecycle(sessionId) !== 'open' ||
      owner.viewOnly ||
      this.metadata.archivedAt(sessionId) ||
      (selected &&
        (this.selectedSessionId !== sessionId || this.viewedSessionId))
    )
      throw Error(
        'external file session is stale, read-only, archived or closed',
      );
    if (access === 'write' && owner.harness.planMode)
      throw Error('external file writes are unavailable in plan mode');
    this.trustedWorkspace(owner.options.workspace);
    return owner;
  }
  /** Native parent capability path only; never a public RuntimeCommand. */
  async grantExternalFile(
    sessionId: string,
    path: string,
    access: 'read' | 'readwrite',
  ) {
    const permission = access === 'readwrite' ? 'write' : 'read';
    const owner = this.externalOwner(sessionId, permission, true);
    if (!['read', 'readwrite'].includes(access))
      throw Error('invalid external file access');
    owner.sandbox.checkCredentialPath(path);
    if (owner.sandbox.isInside(path))
      throw Error('choose a file outside this workspace');
    const epoch = this.externalSelectionEpoch;
    const grant = await this.externalRegistry().mint(sessionId, path, access);
    try {
      if (
        epoch !== this.externalSelectionEpoch ||
        this.externalOwner(sessionId, permission, true) !== owner
      )
        throw Error('session changed while selecting the external file');
      this.externalGrantOwners.set(sessionId, owner);
      return grant;
    } catch (error) {
      if (
        this.externalRegistry()
          .list(sessionId)
          .some((entry) => entry.id === grant.id)
      )
        await this.externalRegistry().revoke(sessionId, grant.id);
      throw error;
    }
  }
  async revokeExternalFileGrant(
    sessionId: string,
    id: string,
  ): Promise<{ revoked: boolean }> {
    // Revocation is authority removal and stays available after navigation or deletion.
    const exists =
      this.externalFiles?.list(sessionId).some((grant) => grant.id === id) ??
      false;
    if (exists) await this.externalFiles!.revoke(sessionId, id);
    return { revoked: exists };
  }
  private authorizeExternal(
    owner: AgentRuntime,
    path: string,
    access: 'read' | 'write',
  ) {
    const sessionId = owner.session.id;
    if (
      this.externalOwner(sessionId, access) !== owner ||
      this.externalGrantOwners.get(sessionId) !== owner
    )
      throw Error('external file requires a grant for this runtime owner');
    owner.sandbox.checkCredentialPath(path);
    if (!this.externalRegistry().allows(sessionId, path, access))
      throw Error(
        'external file requires an explicit current grant for this session',
      );
  }
  private fileRewinds = new WeakMap<AgentRuntime, FileRewindJournal>();
  private fileMutations(
    workspace: string,
    runtime: () => AgentRuntime,
  ): FileMutations {
    const external = (path: string) => !runtime().sandbox.isInside(path);
    const domain = (changes: { path: string }[]) => {
      const kinds = new Set(changes.map((change) => external(change.path)));
      if (kinds.size > 1)
        throw Error(
          'mixed workspace and external file changes are unsupported; no files changed',
        );
      return kinds.has(true);
    };
    return {
      authorize: (path, sessionId, access) => {
        const owner = runtime();
        if (owner.session.id !== sessionId)
          throw Error('external file grant belongs to another session');
        this.authorizeExternal(owner, path, access);
      },
      restoreAtomic: async (changes, signal) => {
        if (domain(changes)) {
          const owner = runtime();
          for (const change of changes)
            this.authorizeExternal(owner, change.path, 'write');
          return this.externalRegistry().restoreAtomic(
            owner.session.id,
            changes,
            signal,
          );
        }
        const documents = this.services(workspace).documents;
        await documents.restoreAtomic(
          changes.map((change) => ({
            ...change,
            path: relative(documents.root, canonicalPath(change.path))
              .split(sep)
              .join('/'),
          })),
          { signal },
        );
      },
      read: async (path, signal) => {
        if (external(path)) {
          const owner = runtime();
          this.authorizeExternal(owner, path, 'read');
          return this.externalRegistry().read(owner.session.id, path, signal);
        }
        const documents = this.services(workspace).documents;
        const document = await documents.snapshot(
          relative(documents.root, canonicalPath(path)).split(sep).join('/'),
          { signal },
        );
        return {
          path,
          content: document?.content ?? null,
          revision: document?.revision ?? null,
          mode: document?.mode,
        };
      },
      apply: async (changes, signal) => {
        if (domain(changes)) {
          const owner = runtime();
          for (const change of changes)
            this.authorizeExternal(owner, change.path, 'write');
          return this.externalRegistry().apply(
            owner.session.id,
            changes,
            signal,
          );
        }
        const documents = this.services(workspace).documents;
        const result = await documents.applyChanges(
          changes.map((change) => ({
            ...change,
            path: relative(documents.root, canonicalPath(change.path))
              .split(sep)
              .join('/'),
          })),
          { signal },
        );
        if (result.status !== 'applied')
          throw Object.assign(
            Error(
              `committed paths: ${result.committedPaths.length ? result.committedPaths.join(', ') : '(none)'}; failures: ${result.failures.map((f) => `${f.path}: ${f.message}`).join('; ')}`,
            ),
            { committedPaths: result.committedPaths },
          );
      },
    };
  }
  private taskVerifier(
    workspace: string,
    baseline: string,
  ): ReturnType<typeof createTaskVerifier> {
    const root = this.trustedWorkspace(workspace);
    const key = `${root}\0${baseline}`;
    let verifier = this.taskVerifiers.get(key);
    if (!verifier) {
      verifier = createTaskVerifier({
        workspace: root,
        baseline,
        dataDir: join(
          this.options.dataFolder ?? this.home,
          'verification',
          identity(root),
          baseline,
        ),
        runtimeExecutable:
          this.options.workspaceTools?.runtimeExecutable ?? process.execPath,
        withBuildResource: (run, _signal, context) =>
          context.withResource('build', run),
        createReviewer: (task, context) =>
          this.createRuntime(context.worktree, undefined, task, 'reviewer'),
      });
      this.taskVerifiers.set(key, verifier);
    }
    return verifier;
  }
  private assertTaskSettings(): void {
    if (this.taskSettingsError) throw Error(this.taskSettingsError);
  }
  private taskStartRequired(workspace: string): boolean {
    const root = this.taskWorkspaces.get(workspace) ?? workspace;
    if (!this.taskQueuesPausedForSettings) return false;
    const binding = this.workspaceRoots.get(root);
    const started = binding && this.taskQueuesStarted.get(binding.canonical);
    return (
      !started || started.dev !== binding!.dev || started.ino !== binding!.ino
    );
  }
  private persistTaskRecovery(workspace?: string): void {
    const started = this.taskSettingsError
      ? new Map<string, TaskSettingsWorkspace>()
      : new Map(this.taskQueuesStarted);
    if (workspace) {
      this.assertTaskSettings();
      const granted = this.trustedWorkspace(workspace);
      const root = this.trustedWorkspace(
        this.taskWorkspaces.get(granted) ?? granted,
      );
      const binding = this.workspaceRoots.get(root)!;
      started.set(root, { ...binding });
    }
    mkdirSync(
      join(this.options.dataFolder ?? this.home, 'workspace-services'),
      {
        recursive: true,
        mode: 0o700,
      },
    );
    writePrivateJson(this.taskSettingsRecoveryPath, {
      version: 1,
      startedWorkspaces: [...started.values()],
    });
    this.taskQueuesPausedForSettings = true;
    this.taskQueuesStarted = started;
  }
  private collaboration(
    workspace: string,
    ownerSessionId: string,
  ): TaskService {
    this.assertTaskSettings();
    const granted = this.trustedWorkspace(workspace);
    const root = this.taskWorkspaces.get(granted) ?? granted;
    let service = this.taskServices.get(root);
    if (!service) {
      service = new TaskService({
        workspace: root,
        resources: this.taskResources,
        settingsPath: this.taskSettingsPath,
        autoStart: !this.taskStartRequired(root),
        dataDir: join(
          this.options.dataFolder ?? this.home,
          'collaboration',
          identity(root),
        ),
        createRuntime: (task, context) => {
          this.taskWorkspaces.set(realpathSync.native(context.worktree), root);
          this.taskVerifier(root, task.spec.baseline);
          return this.createRuntime(context.worktree, undefined, task);
        },
        verify: (task, context) =>
          this.taskVerifier(root, task.spec.baseline)(task, context),
        onRuntimeCreated: (task, runtime) => {
          this.taskRuntimes.set(task.spec.id, runtime);
          this.activeRuns.add(runtime.session.id);
        },
        onRuntimeClosed: (task, runtime) => {
          this.taskRuntimes.delete(task.spec.id);
          this.activeRuns.delete(runtime.session.id);
          if (this.active === runtime) {
            this.viewedSessionId = runtime.session.id;
            const parent = task.spec.sessionId
              ? this.runtimes.get(task.spec.sessionId)
              : undefined;
            this.active = parent ?? [...this.runtimes.values()][0] ?? runtime;
          }
        },
        emit: (event) => {
          const task = event.taskId
            ? service?.getTask(event.taskId)
            : undefined;
          this.workspaceEvent(root, {
            workspaceId: identity(root),
            sessionId: task?.spec.sessionId ?? ownerSessionId,
            service: 'tasks',
            resourceId: event.taskId ?? 'collaboration',
            epoch: event.epoch,
            seq: event.seq,
            at: new Date(event.createdAt).toISOString(),
            data: { ...event },
          });
          if (TASK_STATUS_EVENTS.has(event.type)) this.queueTaskProjection();
        },
      });
      this.taskServices.set(root, service);
    }
    return service;
  }
  private queueTaskProjection(): void {
    if (this.closing || this.taskProjectionPending) return;
    this.taskProjectionPending = true;
    queueMicrotask(() => {
      this.taskProjectionPending = false;
      if (!this.closing) this.publish();
    });
  }
  private taskAgentAttempts(ownerSessionId: string): {
    records: readonly TaskRecord[];
    archived: boolean;
  } {
    const owner = this.store.get(ownerSessionId);
    if (!owner) return { records: [], archived: true };
    const root = this.taskWorkspaces.get(owner.workspace) ?? owner.workspace;
    const live = this.taskServices.get(root);
    if (live) {
      this.taskProjectionErrors.delete(`${root}:${ownerSessionId}`);
      return { records: live.taskAttempts(ownerSessionId), archived: false };
    }
    const key = `${root}:${ownerSessionId}`;
    if (this.archivedTaskAttempts.has(key))
      return { records: this.archivedTaskAttempts.get(key)!, archived: true };
    try {
      const records = readArchivedTaskAttempts({
        dataDir: join(
          this.options.dataFolder ?? this.home,
          'collaboration',
          identity(root),
        ),
        workspace: root,
        ownerSessionId,
      });
      this.archivedTaskAttempts.set(key, records);
      this.taskProjectionErrors.delete(key);
      return { records, archived: true };
    } catch (error) {
      this.taskProjectionErrors.set(key, {
        message: `could not read agent task history: ${(error as Error).message}`,
        workspace: root,
        worktrees: join(
          this.options.dataFolder ?? this.home,
          'collaboration',
          identity(root),
          'worktrees',
        ),
      });
      return { records: [], archived: true };
    }
  }
  private nativeTaskAgents(runtime: AgentRuntime): AgentRecord[] {
    const agents = new Map<string, AgentRecord>();
    for (const owner of this.store.list(undefined, true)) {
      const { records, archived } = this.taskAgentAttempts(owner.id);
      for (const task of records) {
        const sources = [
          {
            sessionId: task.runtimeSessionId,
            workspace: task.worktree,
            role: 'worker' as const,
            access: task.spec.access,
            state: task.runtimeState ?? task.state,
          },
          ...(task.reviewers ?? []).map((reviewer) => ({
            sessionId: reviewer.sessionId,
            workspace: reviewer.workspace,
            role: 'reviewer' as const,
            access: 'readonly' as const,
            state: reviewer.state,
          })),
        ];
        for (const source of sources) {
          if (!source.sessionId || !source.workspace) continue;
          const child = this.store.get(source.sessionId);
          if (!child || child.workspace !== canonicalPath(source.workspace))
            continue;
          // Native tasks intentionally retain their own top-level session row. The
          // durable task ledger supplies parent identity without altering approvals.
          const recovery =
            archived && taskNeedsReconciliation({ state: source.state });
          this.taskWorkspaces.set(child.workspace, task.spec.workspace);
          agents.set(child.id, {
            id: child.id,
            sessionId: owner.id,
            name:
              child.title ||
              task.spec.prompt.split(/\r\n|\r|\n/u)[0] ||
              'agent',
            description: task.spec.prompt,
            activity: this.activities.get(child.id),
            status:
              recovery ||
              ['waiting', 'blocked', 'needs_review'].includes(source.state)
                ? 'waiting'
                : ['queued', 'preparing', 'running', 'cancelling'].includes(
                      source.state,
                    )
                  ? 'running'
                  : 'completed',
            model: child.model,
            tokens: 0,
            messages: this.projectMessages(runtime, child.id),
            workspaceId: identity(child.workspace),
            resourceSessionId: child.id,
            readOnly: source.access === 'readonly',
            task: {
              id: task.spec.id,
              role: source.role,
              attempt: task.attempt,
              state: task.state,
              access: source.access,
              baseline: task.spec.baseline,
              runtimeState: source.state,
              ...(recovery
                ? { recovery: 'needs_reconciliation' as const }
                : {}),
            },
          });
        }
      }
    }
    return [...agents.values()];
  }
  private sourceTask(sessionId: string): TaskRecord | undefined {
    const child = this.store.get(sessionId);
    if (!child) return undefined;
    for (const owner of this.store.list(undefined, true)) {
      const { records } = this.taskAgentAttempts(owner.id);
      const task = records.find(
        (task) =>
          (task.runtimeSessionId === sessionId &&
            task.worktree &&
            canonicalPath(task.worktree) === child.workspace) ||
          (task.reviewers ?? []).some(
            (reviewer) =>
              reviewer.sessionId === sessionId &&
              canonicalPath(reviewer.workspace) === child.workspace,
          ),
      );
      if (task) {
        this.taskWorkspaces.set(child.workspace, task.spec.workspace);
        return task.runtimeSessionId === sessionId
          ? task
          : { ...task, spec: { ...task.spec, access: 'readonly' } };
      }
    }
    // A corrupt ledger cannot identify an old child's access mode. Fail closed
    // for its managed worktrees, not for ordinary parents or other workspaces.
    // Both read-only and write tasks currently receive trees in this directory.
    for (const failure of this.taskProjectionErrors.values())
      if (
        folderContains(canonicalPath(failure.worktrees), child.workspace) ||
        (child.workspace !== failure.workspace &&
          this.taskWorkspaces.get(child.workspace) === failure.workspace)
      )
        throw Error(
          'agent source permission could not be verified; inspect task history error',
        );
    return undefined;
  }
  private ledger(): Promise<OperationLedger> {
    return (this.operationLedger ??= OperationLedger.open({
      directory: join(
        this.options.dataFolder ?? this.home,
        'workspace-operations',
      ),
      redactError: (error) => {
        const code = (error as { code?: string })?.code;
        if (code === 'DOCUMENT_CONFLICT')
          return 'file changed on disk; reload and compare your draft before saving';
        return 'operation failed; inspect effects before retrying';
      },
    }));
  }
  private async workspaceOperation(
    command: RuntimeCommand,
    workspace: string,
    request: WorkspaceServiceRequest,
    action: () => Promise<unknown>,
  ): Promise<unknown> {
    const reads: Record<string, string[]> = {
      documents: ['read', 'refresh', 'resolveSource'],
      terminal: ['list', 'replay', 'resolveCommand'],
      git: ['status', 'snapshot', 'changes', 'diff', 'branches'],
      tasks: ['list', 'events', 'artifacts', 'readArtifact'],
      delivery: ['status', 'checks', 'logs'],
      pulls: ['overview', 'failedLog'],
    };
    const read =
      request.service === 'events' ||
      (request.service === 'terminal' &&
        request.method === 'command' &&
        ['list', 'replay'].includes(String(request.params?.action))) ||
      reads[request.service]?.includes(request.method) ||
      (request.service === 'tasks' &&
        request.method === 'settings' &&
        request.params?.limits === undefined) ||
      (request.service === 'delivery' &&
        request.method === 'login' &&
        request.params?.action === 'poll');
    if (read) return action();
    const paramsHash = createHash('sha256')
      .update(
        JSON.stringify({
          workspace,
          grant: this.workspaceRoots.get(workspace),
          params: request.params ?? {},
        }),
      )
      .digest('hex');
    return (await this.ledger()).run(
      {
        id: command.id,
        sessionId: command.sessionId!,
        service: request.service,
        method: request.method,
        paramsHash,
      },
      action,
    );
  }
  /** Existing runtimes only: resolving a card must never open a runtime or spawn. */
  private commandTerminalSource(
    viewSessionId: string,
    sourceSessionId: string,
    emergency: boolean,
  ): CommandTerminalSource | undefined {
    const view = this.store.get(viewSessionId);
    const source = this.store.get(sourceSessionId);
    const runtime =
      this.runtimes.get(sourceSessionId) ??
      [...this.taskRuntimes.values()].find(
        (runtime) => runtime.session.id === sourceSessionId,
      );
    if (
      !view ||
      !source ||
      (runtime && runtime.options.workspace !== source.workspace)
    )
      return;
    const root = this.workspaceRoots.get(source.workspace)?.canonical;
    if (!root) return;
    let allowLive = sourceSessionId === viewSessionId;
    if (sourceSessionId !== viewSessionId) {
      // Notification ownership is deliberately irrelevant. Only the actual
      // TaskService ledger may grant a parent access to an execution session.
      const owned = [...this.taskServices.values()].some((service) =>
        service
          .ownedRuntimeSessions(viewSessionId)
          .some(
            (child) =>
              child.sessionId === sourceSessionId &&
              child.worktree !== undefined &&
              this.workspaceRoots.get(canonicalPath(child.worktree))
                ?.canonical === root,
          ),
      );
      if (!owned && !emergency) this.sourceTask(viewSessionId);
      const archivedOwned =
        !owned &&
        !emergency &&
        this.taskAgentAttempts(viewSessionId).records.some((task) =>
          [
            { sessionId: task.runtimeSessionId, worktree: task.worktree },
            ...(task.reviewers ?? []).map((reviewer) => ({
              sessionId: reviewer.sessionId,
              worktree: reviewer.workspace,
            })),
          ].some(
            (child) =>
              child.sessionId === sourceSessionId &&
              child.worktree !== undefined &&
              this.workspaceRoots.get(canonicalPath(child.worktree))
                ?.canonical === root,
          ),
        );
      if (!owned && !archivedOwned) return;
      // Archived provenance grants reading only. A manually reopened old child
      // must not acquire input/stop authority from its previous parent ledger.
      allowLive =
        owned &&
        [...this.taskRuntimes.values()].some((child) => child === runtime);
    }
    if (!emergency) {
      if (
        this.metadata.archivedAt(viewSessionId) ||
        this.metadata.archivedAt(sourceSessionId)
      )
        throw Error('restore this session before continuing');
      for (const [id, workspace] of [
        [viewSessionId, view.workspace],
        [sourceSessionId, source.workspace],
      ]) {
        try {
          this.trustedWorkspace(workspace);
        } catch {
          // Restore only a proved ledger origin; this never resumes the child.
          this.sourceTask(id);
          this.trustedWorkspace(workspace);
        }
      }
    }
    const receipts = () =>
      this.store.tree(sourceSessionId).flatMap(({ message }) => {
        const tool = message.role === 'tool' && message.tool_call_id;
        const human = message.role === 'user' && message.shell?.id;
        if (!tool && !human) return [];
        return (message.commandExecutions ?? []).flatMap((receipt) => {
          if (
            receipt.executionSessionId !== sourceSessionId ||
            (tool
              ? receipt.toolCallId !== tool || receipt.userShellId !== undefined
              : receipt.userShellId !== human ||
                receipt.toolCallId !== undefined)
          )
            return [];
          const safe = commandExecutionReceipt({ ...receipt, outputPath: '' });
          return safe ? [safe] : [];
        });
      });
    // Loading an existing terminal journal never opens a runtime or executes a command.
    const services =
      this.workspaceServices.get(root) ??
      (!emergency && receipts().length
        ? this.services(source.workspace)
        : undefined);
    return {
      jobs: allowLive ? runtime?.jobs : undefined,
      receipts,
      ...(services
        ? { terminals: services.terminals, workspaceId: services.id }
        : {}),
    };
  }

  private async workspaceCommand(command: RuntimeCommand): Promise<unknown> {
    this.metadata.refresh();
    const id = text(command.sessionId, 'session', 200);
    const row = this.store.get(id);
    if (!row) throw Error('session not found');
    if (this.runtimes.lifecycle(id) !== 'open')
      throw Error('session is deleting or deleted');
    const request = validateWorkspaceRequest(command.payload);
    if (
      request.service === 'documents' &&
      this.sourceTask(id)?.spec.access === 'readonly'
    )
      assertReadonlyTaskRequest(request.service, request.method);
    if (
      request.service === 'inputs' &&
      (request.method === 'list' || request.params?.action !== 'resume')
    ) {
      const owner =
        this.runtimes.get(id) ??
        [...this.taskRuntimes.values()].find(
          (runtime) => runtime.session.id === id,
        );
      if (!owner) this.store.inputs.recover(id, randomUUID());
      if (request.method === 'list')
        return (
          owner?.harness.recoverableInputs ?? this.store.inputs.recoverable(id)
        );
      const result = owner
        ? owner.harness.resolveInputs(
            request.params as unknown as ResolveInputsRequest,
          )
        : this.store.inputs.resolve(
            id,
            randomUUID(),
            request.params as unknown as ResolveInputsRequest,
          );
      this.publish();
      return result;
    }
    if (
      request.service === 'terminal' &&
      ['resolveCommand', 'command'].includes(request.method)
    ) {
      const emergency =
        request.method === 'command' &&
        (request.params?.action === 'close' ||
          (request.params?.action === 'signal' &&
            ['SIGTERM', 'SIGKILL'].includes(
              String(
                (request.params?.params as Record<string, unknown> | undefined)
                  ?.signal,
              ),
            )));
      const access = {
        sourceFor: (view: string, source: string) =>
          this.commandTerminalSource(view, source, emergency),
      };
      return this.workspaceOperation(command, row.workspace, request, () =>
        request.method === 'resolveCommand'
          ? resolveCommandTerminal(access, id, request.params)
          : commandTerminalAction(access, id, request.params),
      );
    }
    const emergency =
      (request.service === 'terminal' &&
        ['signal', 'close'].includes(request.method)) ||
      (request.service === 'delivery' &&
        request.method === 'login' &&
        request.params?.action === 'cancel');
    if (emergency) {
      const existing = this.workspaceServices.get(row.workspace);
      if (!existing)
        throw Error('no native resources are owned by this session');
      return this.workspaceOperation(command, row.workspace, request, () =>
        existing.call(id, request.service, request.method, request.params),
      );
    }
    if (request.service === 'tasks' && request.method === 'cancel') {
      const origin = this.taskWorkspaces.get(row.workspace) ?? row.workspace;
      const existing = this.taskServices.get(origin);
      if (existing)
        return this.workspaceOperation(command, row.workspace, request, () =>
          existing.call(id, request.method, request.params),
        );
    }
    const workspace = this.trustedWorkspace(row.workspace);
    if (request.service === 'operations') {
      const ledger = await this.ledger();
      if (request.method === 'list')
        return ledger.list({ ...request.params, sessionId: id });
      const operationId = text(request.params?.id, 'operation', 200);
      let before: number | undefined;
      let found = false;
      do {
        const page = ledger.list({ sessionId: id, limit: 500, before });
        found = page.some((operation) => operation.id === operationId);
        if (found || page.length < 500) break;
        before = page[page.length - 1].cursor;
      } while (true);
      if (!found) throw Error('operation is not owned by this session');
      return ledger.acknowledgeUnknown(operationId, {
        note: text(request.params?.note, 'review note', 4096),
      });
    }
    if (request.service === 'events')
      return this.services(workspace).replay(
        request.params?.after as { offset: number; seq: number } | undefined,
        request.params?.limit as number | undefined,
      );
    if (this.metadata.archivedAt(id))
      throw Error('restore this session before continuing');
    if (request.service === 'inputs') {
      const owner =
        this.runtimes.get(id) ??
        [...this.taskRuntimes.values()].find(
          (runtime) => runtime.session.id === id,
        ) ??
        this.runtimes.open(workspace, id);
      const result = owner.harness.resolveInputs(
        request.params as unknown as ResolveInputsRequest,
      );
      if (result.applied && result.action === 'resume' && !owner.busy)
        this.track(owner.harness.run(), owner);
      this.publish();
      return result;
    }
    if (request.service === 'tasks')
      return this.workspaceOperation(command, workspace, request, async () => {
        if (
          request.method === 'settings' &&
          (this.taskSettingsError || this.taskStartRequired(workspace))
        ) {
          if (request.params?.limits === undefined)
            return {
              ...this.taskResources.getLimits(),
              ...(this.taskSettingsError
                ? { error: this.taskSettingsError }
                : {}),
              ...(this.taskStartRequired(workspace)
                ? { requiresStart: true }
                : {}),
            };
          const next = await writeTaskLimits(
            this.taskSettingsPath,
            request.params.limits,
            () => this.taskResources.getLimits(),
            (next) => {
              this.taskResources.setLimits(next);
              this.taskSettingsError = undefined;
            },
            () => this.persistTaskRecovery(),
          );
          this.publish();
          return next;
        }
        const service = this.collaboration(workspace, id);
        if (request.method === 'start' && this.taskStartRequired(workspace)) {
          // Persist the explicit intent before allowing queued work to start.
          this.persistTaskRecovery(workspace);
          this.publish();
        }
        return service.call(id, request.method, request.params);
      });
    // What the person types in a tab Circle is operating takes it over, before it lands
    if (request.service === 'terminal' && request.method === 'write')
      this.terminalTabs.typed(
        id,
        String(request.params?.id ?? request.params?.terminalId ?? ''),
        String(request.params?.data ?? ''),
      );
    return this.workspaceOperation(command, workspace, request, () =>
      this.services(workspace).call(
        id,
        request.service,
        request.method,
        request.params,
      ),
    );
  }
  private createRuntime(
    workspace: string,
    sessionId?: string,
    task?: TaskRecord,
    role: 'worker' | 'reviewer' = 'worker',
  ): AgentRuntime {
    this.bindWorkspace(workspace);
    const settings = settingsForRun(this.home, workspace).settings;
    const taskPrefix = role === 'reviewer' ? 'review: ' : '';
    const taskSuffix = task && task.attempt > 1 ? ` · #${task.attempt}` : '';
    const taskTitle = task
      ? taskPrefix +
        Array.from(
          task.spec.prompt
            .trim()
            .split(/\r\n|\r|\n/u)[0]!
            .replace(/\s+/gu, ' '),
        )
          .slice(
            0,
            Math.min(
              task.attempt > 1 ? 90 : 100,
              100 - Array.from(taskPrefix + taskSuffix).length,
            ),
          )
          .join('') +
        taskSuffix
      : undefined;
    let runtime: AgentRuntime;
    const fileRewind = new FileRewindJournal(
      this.fileMutations(workspace, () => runtime),
    );
    const create = (session?: string) =>
      new AgentRuntime({
        workspace,
        // The recovered-input panel offers a closed runtime's queue back.
        preserveQueuedInputs: true,
        fileMutations: fileRewind.files,
        classifyTool: bindToolResource,
        executeTool: (tool, args, context, run) =>
          this.taskResources.executeTool(
            tool,
            args,
            context,
            run,
            task?.spec.allowedResources ?? TASK_RESOURCES,
          ),
        commandLauncher: this.options.workspaceTools?.commandSupervisorPath
          ? (request) =>
              createTerminalCommandLauncher({
                terminals: this.services(workspace).terminals,
                runtimeExecutable:
                  this.options.workspaceTools!.runtimeExecutable,
                supervisorPath:
                  this.options.workspaceTools!.commandSupervisorPath!,
                // Windows commands run in a ConPTY whose processes a Job object owns.
                windowsJobObject: process.platform === 'win32',
                executionEpoch: runtime.jobs.runName,
                stopExecution: (actualSessionId, executionId, reason) =>
                  runtime.jobs.stopExecution(
                    actualSessionId,
                    executionId,
                    reason,
                  ),
              })(request)
          : undefined,
        wrapModel: (model) =>
          wrapModelCompletion(model, (request, invoke) => {
            this.assertTaskSettings();
            return this.taskResources.withResource(
              'agent',
              () => {
                this.assertTaskSettings();
                return invoke(request);
              },
              request.signal,
            );
          }),
        home: this.home,
        // A sentence shows as a new session until its summary title arrives.
        holdTitle: true,
        beforeDelete: async () => {
          await this.releaseSessionResources(runtime.session.id, workspace);
          await this.options.beforeDelete?.(runtime.session.id);
        },
        userHome: this.options.userHome,
        localContext: !!task || isFolderTrusted(settings, workspace),
        settings,
        model:
          this.options.model ??
          (isReady(settings) ? undefined : new DisconnectedModel()),
        catalog: this.options.catalog?.(this.home),
        session,
        // Initialize only new persisted sessions. Restoring one or a later human
        // rename must never be overwritten by the internal Task <id> prompt.
        run: taskTitle
          ? { ...defaultRunOptions(), session_name: taskTitle }
          : undefined,
        extraTools: [
          ...(!task
            ? createCollaborationTools({
                sessionId: () => runtime.session.id,
                service: () =>
                  this.collaboration(
                    runtime.options.workspace,
                    runtime.session.id,
                  ),
              })
            : []),
          ...(this.options.browser
            ? browserTools(this.options.browser, {
                confirm: (_sessionId, approval, signal, callId) =>
                  approval.kind === 'upload'
                    ? this.confirmUpload(runtime, approval, signal, callId)
                    : approval.kind === 'download'
                      ? this.confirmDownload(runtime, approval, signal, callId)
                      : approval.kind === 'coordinate'
                        ? this.confirmCoordinate(
                            runtime,
                            approval,
                            signal,
                            callId,
                          )
                        : this.confirmCertificate(
                            runtime,
                            approval,
                            signal,
                            callId,
                          ),
                // Paths as the file tools take them (a credential file never goes), the
                // conversation to record and the values a replayed script takes
                ...runtimeBrowserOptions(() => runtime),
              }).map((tool) => bindToolResource(tool, 'browser'))
            : []),
          ...(this.options.terminal
            ? terminalTools(this.terminalTabs.port(this.options.terminal), {
                confirm: (_sessionId, approval, signal, callId) =>
                  this.confirmHostKey(runtime, approval, signal, callId),
                // The person's own terminal tabs, beside the device consoles
                tabs: this.terminalTabs,
                ...runtimeTerminalOptions(() => runtime),
              })
            : []),
        ],
        approve: (call, signal, origin) =>
          this.approve(
            runtime,
            call,
            signal,
            task
              ? { ...origin, name: task.spec.id, agent: runtime.session.id }
              : origin,
          ),
        question: (args, signal, origin) =>
          this.question(
            runtime,
            args,
            signal,
            task
              ? { ...origin, name: task.spec.id, agent: runtime.session.id }
              : origin,
          ),
        secret: (request, signal, origin) =>
          this.secret(
            runtime,
            request,
            signal,
            task
              ? { ...origin, name: task.spec.id, agent: runtime.session.id }
              : origin,
          ),
        githubConnection: this.githubBackend(
          workspace,
          () => runtime.session.id,
        ),
        onExtensionStatus: () => this.publish(),
        openUrl: async (url) => {
          this.openRequest = {
            id: randomUUID(),
            url,
            sessionId: runtime.session.id,
          };
          this.publish();
          this.options.openUrl?.(url);
        },
      });
    // A missing/deleted session is not a reason to discard other sessions.
    try {
      runtime = create(sessionId);
    } catch (error) {
      if (sessionId && String(error).includes('unknown session'))
        runtime = create();
      else throw error;
    }
    this.fileRewinds.set(runtime, fileRewind);
    runtime.bus.subscribe((event) => {
      if (task) {
        this.event(
          runtime,
          event,
          this.selectedSessionId === runtime.session.id,
        );
        const eventRoot =
          this.taskWorkspaces.get(realpathSync.native(workspace)) ?? workspace;
        this.workspaceEvent(eventRoot, {
          workspaceId: identity(eventRoot),
          sessionId: task.spec.sessionId ?? runtime.session.id,
          service: 'tasks',
          resourceId: task.spec.id,
          epoch: this.workspaceEpoch,
          seq: ++this.workspaceSeq,
          at: new Date().toISOString(),
          data: {
            kind: 'runtime-event',
            taskId: task.spec.id,
            attempt: task.attempt,
            event: JSON.parse(
              JSON.stringify(event, (_key, value) =>
                typeof value === 'string' ? runtime.redact(value) : value,
              ),
            ),
          },
        });
      } else this.event(runtime, event);
    });
    const tracker = new PlanCompletionTracker();
    tracker.reset(runtime.todos);
    this.planCompletions.set(runtime.session.id, tracker);
    if (runtime.options.settings.extensions.github?.enabled === true)
      void runtime.setBundledExtensionEnabled('github', true).catch(() => {});
    return runtime;
  }
  private persistLocation() {
    writePrivateJson(join(this.home, 'desktop-session.json'), {
      workspace: this.selectedWorkspace,
      sessionId: this.selectedSessionId,
    });
  }
  private projectMessages(
    runtime: AgentRuntime,
    id: string,
    nodes = this.store.tree(id),
  ): Message[] {
    const labels = this.store.labels(id);
    const turns = this.turnUsage.get(id) ?? {};
    const result: Message[] = [];
    const calls = new Map<string, Message>();
    // A stored reply has tokens but not the turn clock. Measure it from the prompt,
    // or from the previous reply, so an older footer shows a duration too.
    let markedAt: number | undefined;
    for (const node of nodes) {
      const raw = node.message;
      if (!raw || raw.role === 'system') continue;
      // A crash leaves this marker and no reply. A stopped reply does not:
      // its own `interrupted` flag is the mark, below.
      if (raw.internal === 'interrupted') {
        result.push({
          id: node.id,
          parentId: node.parent,
          role: 'notice',
          text: '✖ Interrupted',
          interrupted: true,
          at: new Date(node.created).toISOString(),
        });
        continue;
      }
      if (raw.internal === 'hook_notice') {
        result.push({
          id: node.id,
          parentId: node.parent,
          role: 'notice',
          text: raw.display ?? raw.content,
          ...(raw.hook ? { hookNotice: raw.hook } : {}),
          at: new Date(node.created).toISOString(),
        });
        continue;
      }
      if (raw.internal) continue;
      if (raw.role === 'tool') {
        const call = calls.get(raw.tool_call_id ?? '');
        if (call?.tool) {
          // In place: a finished call keeps its position among its turn's calls.
          result[result.indexOf(call)] = {
            ...call,
            id: node.id,
            parentId: node.parent,
            attachments: raw.attachments?.map((a, index) => ({
              id: `${node.id}-attachment-${index}`,
              name: a.filename,
              kind: a.kind,
              content: a.data,
              mime: a.mime_type,
            })),
            tool: {
              ...call.tool,
              output: raw.content,
              status: raw.status ?? 'success',
              agentIds: taskToolAgentIds(
                call.tool.name,
                call.tool.input,
                raw.content,
                this.taskAgentAttempts(id).records,
              ),
            },
          };
        } else
          result.push({
            id: node.id,
            parentId: node.parent,
            role: 'tool',
            text: raw.content,
            at: new Date(node.created).toISOString(),
          });
        continue;
      }
      const runtimeNotice =
        raw.role === 'assistant'
          ? storedGitHubStatusNotice(raw.content, raw.runtimeNotice)
          : undefined;
      const base: Message = {
        id: node.id,
        parentId: node.parent,
        role: runtimeNotice ? 'notice' : raw.role,
        ...(runtimeNotice ? { runtimeNotice } : {}),
        text: raw.display ?? raw.content,
        thinking: raw.thinking,
        ...(typeof raw.thinking_seconds === 'number'
          ? { thinkingSeconds: raw.thinking_seconds }
          : {}),
        label: labels[raw.id],
        at: new Date(node.created).toISOString(),
        ...(raw.shell
          ? {
              shell: {
                id: raw.shell.id,
                sourceSessionId: id,
                command: raw.shell.command,
                output: raw.shell.output,
                exitCode: raw.shell.exit_code,
                status:
                  raw.shell.exit_code === 0
                    ? ('done' as const)
                    : ('error' as const),
                interactive: (raw.commandExecutions ?? []).some(
                  (execution) =>
                    execution.executionSessionId === id &&
                    execution.userShellId === raw.shell!.id &&
                    execution.toolCallId === undefined &&
                    !!execution.terminal,
                ),
              },
            }
          : {}),
        attachments: raw.attachments?.map((a, index) => ({
          id: `${node.id}-attachment-${index}`,
          name: a.filename,
          kind: a.kind,
          content: a.data,
          mime: a.mime_type,
        })),
        ...(raw.role === 'assistant' && raw.interrupted
          ? { interrupted: true }
          : {}),
        // The last message of a finished turn shows the whole turn: its time and tokens.
        // Any other reply with usage shows the time since the prompt or the previous reply.
        usage: turns[raw.id]
          ? {
              input: turns[raw.id]!.input,
              output: turns[raw.id]!.output,
              cost: turns[raw.id]!.cost ?? null,
              // A stop prices an estimate. The mark follows the amount (`$0.0182~`).
              ...(raw.interrupted ? { estimated: true } : {}),
              elapsed: formatElapsed(turns[raw.id]!.seconds),
            }
          : raw.usage
            ? {
                input: raw.usage.input_tokens,
                output: raw.usage.output_tokens,
                // The workbench shows dollars; another currency is not converted
                cost:
                  raw.cost?.currency === 'USD'
                    ? (raw.cost.amount ?? null)
                    : null,
                ...(raw.interrupted ? { estimated: true } : {}),
                elapsed: gapElapsed(markedAt, node.created),
              }
            : undefined,
      };
      const shown =
        raw.role !== 'assistant' ||
        Boolean(base.text || base.thinking || base.attachments?.length);
      if (raw.role === 'user' || (shown && base.usage))
        markedAt = new Date(node.created).getTime();
      if (shown) result.push(base);
      for (const call of raw.tool_calls ?? []) {
        const state = this.toolStates.get(`${id}:${call.id}`);
        const row: Message = {
          id: `${node.id}:${call.id}`,
          parentId: node.id,
          role: 'tool',
          text: '',
          at: base.at,
          tool: {
            id: call.id,
            name: call.name,
            input: call.args,
            output: state?.output ?? '',
            status: state?.status ?? 'unknown',
            filePath:
              String(call.args.file_path ?? call.args.path ?? '') || undefined,
            diff: this.diffs.get(`${id}:${call.id}`),
            agentIds: taskToolAgentIds(
              call.name,
              call.args,
              state?.output ?? '',
              this.taskAgentAttempts(id).records,
            ),
          },
        };
        calls.set(call.id, row);
        result.push(row);
      }
      const completion =
        raw.role === 'assistant' &&
        (raw.completion || raw.truncated) &&
        completionFailure(raw);
      if (completion)
        result.push({
          id: `completion-${node.id}`,
          parentId: node.id,
          role: 'notice',
          text: `✖ ${completion.message}`,
          completionFailure: completion.code,
          at: base.at,
        });
    }
    const actual =
      this.runtimes.get(id) ??
      [...this.taskRuntimes.values()].find(
        (runtime) => runtime.session.id === id,
      );
    const shellAnchors = new Map<string | null, string>();
    for (const view of actual?.userShells.views ?? []) {
      if (
        view.sessionId !== id ||
        (view.persistedMessageId &&
          nodes.some((node) => node.message?.id === view.persistedMessageId))
      )
        continue;
      const anchor =
        nodes.find((node) => node.message?.id === view.anchor)?.id ?? null;
      const shell: Message = {
        id: 'user-shell-' + view.id,
        parentId: anchor,
        role: 'user',
        text: (view.quiet ? '!!' : '!') + view.command,
        at: new Date(
          view.startedAt ?? view.execution?.started ?? 0,
        ).toISOString(),
        shell: {
          id: view.id,
          sourceSessionId: id,
          command: view.command,
          output: view.output,
          status: view.status,
          exitCode: view.exitCode,
          quiet: view.quiet,
          interactive: !!view.execution?.terminal,
        },
      };
      const previous = shellAnchors.get(anchor);
      const after = previous ?? anchor;
      const at = result.findLastIndex(
        (message) =>
          message.id === after ||
          (message.role === 'tool' && message.parentId === after),
      );
      const index = after === null ? 0 : at < 0 ? result.length : at + 1;
      result.splice(index, 0, shell);
      shellAnchors.set(anchor, shell.id);
    }
    const parents = new Map(nodes.map((node) => [node.id, node.parent]));
    const insertedAfter = new Map<string | null, string>();
    const storedStop = result.some(
      (row) => row.role === 'notice' && row.text === '✖ Interrupted',
    );
    for (const failure of [
      ...(this.failures.get(id) ?? []),
      ...(this.notices.get(id) ?? []),
    ].filter((failure) => failure.text !== '✖ Interrupted' || !storedStop)) {
      // After the message it followed and that message's tool rows
      const afterIndex = (anchor: string | null) =>
        result.findLastIndex(
          (row) =>
            row.id === anchor ||
            (row.role === 'tool' && row.parentId === anchor) ||
            row.id.startsWith(`${anchor}:`),
        );
      let anchor = failure.after;
      let at = afterIndex(anchor);
      // Empty/signature-only assistant and internal messages have no renderer row.
      // Walk their actual ancestry so an old failure cannot drift below later turns.
      while (at < 0 && anchor !== null && parents.has(anchor)) {
        anchor = parents.get(anchor) ?? null;
        at = afterIndex(anchor);
      }
      const previous = insertedAfter.get(anchor);
      const previousAt = previous
        ? result.findIndex((row) => row.id === previous)
        : -1;
      const index =
        previousAt >= 0
          ? previousAt + 1
          : anchor === null
            ? 0
            : at < 0
              ? result.length
              : at + 1;
      result.splice(index, 0, {
        id: failure.id,
        parentId: failure.after,
        role: 'notice',
        text: failure.text,
        at: failure.at,
        ...('completionFailure' in failure && failure.completionFailure
          ? { completionFailure: failure.completionFailure }
          : {}),
        ...('planCompleted' in failure &&
        typeof failure.planCompleted === 'number'
          ? { planCompleted: failure.planCompleted }
          : {}),
      });
      insertedAfter.set(anchor, failure.id);
    }
    const stream = this.streams.get(id);
    if (stream && (stream.text || stream.thinking))
      result.push({
        id: stream.id,
        parentId: this.store.get(id)?.head ?? null,
        role: 'assistant',
        text: stream.text,
        thinking: stream.thinking,
        at: 'streaming',
      });
    return result;
  }
  // A session opened later only catalogues extensions until initialize(). Hub
  // sign-in lives in the home (config and token), so a page still reads the
  // view and status a session that already loaded the extension published.
  private presentExtension(
    runtime: AgentRuntime,
    extension: Extension,
  ): Extension {
    if (!extension.enabled || extension.error) return extension;
    const needsView = extension.view === undefined;
    const needsCommand = extension.commands.length === 0 && !extension.status;
    if (!needsView && !needsCommand) return extension;
    for (const owner of this.runtimes.values()) {
      if (owner === runtime || owner.isClosing) continue;
      if (
        extension.source === 'project' &&
        owner.options.workspace !== runtime.options.workspace
      )
        continue;
      const peer = owner.extensions.extensions.find(
        (item) => item.name === extension.name && item.enabled && !item.error,
      );
      if (!peer) continue;
      const peerHas =
        peer.view !== undefined || peer.commands.length > 0 || !!peer.status;
      if (!peerHas) continue;
      return {
        ...extension,
        view: extension.view ?? peer.view,
        status: extension.status ?? peer.status,
        commands: extension.commands.length
          ? extension.commands
          : peer.commands,
        tools: extension.tools.length ? extension.tools : peer.tools,
      };
    }
    return extension;
  }
  private extensionCommand(
    runtime: AgentRuntime,
    name: string,
  ): { owner: AgentRuntime; command: ExtensionCommand } | undefined {
    const local = runtime.extensions.commands().get(name);
    if (local) return { owner: runtime, command: local };
    for (const owner of this.runtimes.values()) {
      if (owner === runtime || owner.isClosing) continue;
      const command = owner.extensions.commands().get(name);
      if (!command) continue;
      const ext = owner.extensions.extensions.find((item) =>
        item.commands.some((row) => row.name === name),
      );
      if (
        ext?.source === 'project' &&
        owner.options.workspace !== runtime.options.workspace
      )
        continue;
      return { owner, command };
    }
    return undefined;
  }
  private extensionReady(runtime: AgentRuntime): boolean {
    return runtime.extensions.extensions.some(
      (ext) =>
        ext.enabled &&
        !ext.error &&
        (ext.view !== undefined || ext.commands.length > 0 || !!ext.status),
    );
  }
  // Leaving an empty session drops the only host that loaded extensions.
  // Load them on the session that remains, from the same home, before that.
  private async carryExtensions(
    next: AgentRuntime,
    previousId: string,
  ): Promise<void> {
    if (!previousId || previousId === next.session.id || next.isClosing) return;
    const previous = this.runtimes.get(previousId);
    if (!previous || previous.isClosing || !this.extensionReady(previous))
      return;
    if (this.extensionReady(next) || !this.unusedSession(previousId)) return;
    if (!isFolderTrusted(loadSettings(this.home), next.options.workspace))
      return;
    await next.initialize();
    const names = previous.extensions.extensions
      .filter((ext) => ext.view !== undefined)
      .map((ext) => ext.name);
    const end = Date.now() + 2000;
    while (
      Date.now() < end &&
      names.some(
        (name) =>
          next.extensions.extensions.find((ext) => ext.name === name)?.view ===
          undefined,
      )
    )
      await delay(10);
  }
  snapshot(): WorkbenchSnapshot {
    this.metadata.refresh();
    if (this.viewedSessionId && !this.store.get(this.viewedSessionId))
      this.viewedSessionId = undefined;
    const runtime = this.active;
    const settings = runtime.options.settings;
    const savedSettings = loadSettings(this.home);
    const inspecting = !!this.viewedSessionId;
    const defaultFolder = this.defaultWorkspace(savedSettings);
    const taskRoot = this.tasksRootFor(savedSettings);
    // The open conversation is listed before its first message.
    const rows = this.store.list(undefined, false, true);
    const paths = [
      ...new Set([
        ...rows.map((row) => row.workspace),
        runtime.options.workspace,
        ...this.opened,
      ]),
    ];
    const nativeAgents = this.nativeTaskAgents(runtime);
    const sessions: Session[] = rows.map((row) => {
      const owner =
        this.runtimes.get(row.id) ??
        [...this.taskRuntimes.values()].find(
          (task) => task.session.id === row.id,
        );
      const selected = owner?.session.id === row.id;
      const queue = selected
        ? owner.harness.queuedMessages
        : { steering: [], followUp: [] };
      const path = new Set(
        this.store.messages(row.id).map((message) => message.id),
      );
      const nodes = this.store.tree(row.id);
      const branchIds = nodes
        .filter((node) => node.message && path.has(node.message.id))
        .flatMap((node) => [
          node.id,
          ...(node.message?.tool_calls ?? []).map(
            (call) => `${node.id}:${call.id}`,
          ),
          ...(node.message?.role === 'assistant' &&
          (node.message.completion || node.message.truncated) &&
          completionFailure(node.message)
            ? [`completion-${node.id}`]
            : []),
        ]);
      for (const failure of [
        ...(this.failures.get(row.id) ?? []),
        ...(this.notices.get(row.id) ?? []),
      ])
        if (failure.after === null || branchIds.includes(failure.after))
          branchIds.push(failure.id);
      const stream = this.streams.get(row.id);
      if (stream) branchIds.push(stream.id);
      for (const view of owner?.userShells.views ?? [])
        if (
          view.sessionId === row.id &&
          (!view.anchor || path.has(view.anchor)) &&
          !nodes.some((node) => node.message?.id === view.persistedMessageId)
        )
          branchIds.push('user-shell-' + view.id);
      return {
        id: row.id,
        archivedAt: this.metadata.archivedAt(row.id),
        lifecycle:
          this.runtimes.lifecycle(row.id) === 'deleting' ? 'deleting' : 'open',
        ...(this.deletionFailures.has(row.id)
          ? { deletionFailed: this.deletionFailures.get(row.id) }
          : {}),
        occupied: !owner && sessionOccupied(this.home, row.id),
        nativeResourcesActive: this.nativeSessionActiveNow(
          row.id,
          row.workspace,
        ),
        title: row.title || 'new session',
        workspaceId: identity(row.workspace),
        model: selected ? owner.harness.model.model : row.model,
        effort: ((selected
          ? owner.options.settings.default_thinking
          : savedSettings.default_thinking) || 'default') as Effort,
        draft: '',
        attachments: [],
        messages: this.projectMessages(runtime, row.id, nodes),
        fileUndoTurns: owner
          ? this.fileRewinds.get(owner)?.availableTurns()
          : [],
        leafId: row.head,
        branchIds,
        hiddenIds: [],
        undoStack: [],
        queueVersion: owner?.harness.queuedVersion,
        queue: [
          ...queue.steering.map((value, i) => ({
            id: `steer-${i}`,
            text: value,
            kind: 'steering' as const,
          })),
          ...queue.followUp.map((value, i) => ({
            id: `follow-${i}`,
            text: value,
            kind: 'follow-up' as const,
          })),
        ],
        state: selected && owner.busy ? 'waiting' : 'idle',
        readOnly: selected ? owner.harness.planMode : false,
        auto: selected ? owner.policy.yoloEnabled(row.id) : false,
        mode: selected ? owner.mode : 'manual',
        meters: selected && !owner.isClosing ? this.meters(owner) : undefined,
        turn: this.turn(row.id),
        changes: this.changeList(row.id),
        showThinking: !savedSettings.hide_thinking,
        expandTools: false,
        todos: selected
          ? owner.todos.map((todo, i) => ({
              id: `todo-${i}`,
              text: todo.content,
              status: todo.status === 'in_progress' ? 'running' : todo.status,
            }))
          : [],
        pinned: false,
        shared: false,
        updatedAt: new Date(row.updated).toISOString(),
      };
    });
    const models = [
      ...new Set([
        settings.auth.model,
        ...this.discoveredModels,
        ...settings.enabled_models,
        ...rows.map((row) => row.model),
        runtime.harness.model.model,
      ]),
    ]
      .filter(Boolean)
      .map((id) => {
        const facts = runtime.catalog.facts(id, settings);
        return {
          id,
          provider: facts.provider,
          contextWindow: facts.windowKnown ? facts.contextWindow : null,
          inputPrice: facts.rates?.input ?? null,
          outputPrice: facts.rates?.output ?? null,
          vision: false,
        };
      });
    return {
      version: 1,
      activeSessionId: this.selectedSessionId,
      previousSessionId: this.previous,
      runtime: {
        connected: !this.closing,
        processId: process.pid,
        coreVersion: VERSION,
        network: currentNetworkStatus(),
        observedAt: new Date().toISOString(),
        configured: !!this.options.model || isReady(settings),
        hasKey: (this.keySaved ??= Boolean(this.savedKey())),
        error:
          this.error ??
          this.taskSettingsError ??
          this.workspaceStreamFailures.values().next().value ??
          this.taskProjectionErrors.values().next().value?.message,
      },
      workspaces: paths.map((path) => ({
        id: identity(path),
        name: this.isScratch(path) ? 'circle' : basename(path),
        path,
        branch: this.validWorkspaceRoot(path) ? this.branch(path) : '',
        trusted:
          this.validWorkspaceRoot(path) &&
          isFolderTrusted(savedSettings, this.taskWorkspaces.get(path) ?? path),
        origin: 'native' as const,
        // The default circle folder is a project the person can pick. Scratch is
        // work without one: a task's own folder, or the shared unscoped folder.
        kind:
          this.isUnscoped(path) || isTaskWorkspace(path, taskRoot)
            ? ('scratch' as const)
            : ('project' as const),
        ...(isTaskWorkspace(path, taskRoot) ? { task: true } : {}),
        instructions:
          !inspecting &&
          this.validWorkspaceRoot(path) &&
          isFolderTrusted(savedSettings, this.taskWorkspaces.get(path) ?? path)
            ? ((runtime.options.workspace === path
                ? runtime
                : [...this.runtimes.values()].find(
                    (owner) => owner.options.workspace === path,
                  )
              )?.loadedInstructions.map((file) => ({
                name: file.path,
                path: file.path,
                content: file.content,
              })) ?? [])
            : [],
      })),
      sessions,
      files: [],
      agents: [
        ...this.store
          .list(undefined, true)
          .filter((row) => row.parent_id)
          .map(
            (row) =>
              ({
                id: row.id,
                sessionId: row.parent_id!,
                workspaceId: identity(row.workspace),
                resourceSessionId: row.id,
                // Core history has no durable per-child permission metadata.
                readOnly: true,
                name: row.title || 'agent',
                activity: this.activities.get(row.id),
                description: row.title,
                status: [...this.pending.values()].some(
                  (pending) => pending.row.origin?.agent === row.id,
                )
                  ? 'waiting'
                  : this.activeRuns.has(row.id)
                    ? 'running'
                    : 'completed',
                model: row.model,
                tokens: 0,
                messages: this.projectMessages(runtime, row.id),
              }) as AgentRecord,
          ),
        ...nativeAgents,
      ],
      jobs: [...this.runtimes.values()].flatMap((owner) =>
        owner.jobs.list().map((job) => ({
          id: `${job.sessionId}:${job.id}`,
          sessionId: job.sessionId,
          kind:
            job.kind === 'shell' || job.kind === 'adopted'
              ? ('command' as const)
              : job.kind,
          title: job.title,
          state:
            job.status === 'running'
              ? this.stoppedJobs.has(`${job.sessionId}:${job.id}`)
                ? ('stopping' as const)
                : ('running' as const)
              : job.status === 'done'
                ? ('completed' as const)
                : job.status === 'stopped'
                  ? ('cancelled' as const)
                  : ('failed' as const),
          elapsed: elapsed(job),
          output: existsSync(job.outputPath) ? outputTail(job.outputPath) : '',
          outputPath: job.virtualPath,
          stopRequested: this.stoppedJobs.has(`${job.sessionId}:${job.id}`),
          // A background subagent's job, by the session its record is: its stop and its
          // time in the subagents mode, while it works and after it has ended.
          ...(job.kind === 'agent' && job.agent ? { agentId: job.agent } : {}),
          ...(job.execution?.terminal
            ? { terminal: job.execution.terminal }
            : {}),
        })),
      ),
      interactions: [
        ...this.history,
        ...[...this.pending.values()].map((pending) => pending.row),
      ],
      approvalRules: sessions.flatMap((session) =>
        runtime.policy.store.rules(session.id).map((rule) => ({
          id: identity(
            JSON.stringify([session.id, rule.tool, rule.pattern, rule.at]),
          ),
          sessionId: session.id,
          description: `${rule.tool} · ${rule.label}`,
          kind: rule.pattern.startsWith('prefix:')
            ? ('prefix' as const)
            : rule.tool === 'execute'
              ? ('command' as const)
              : ('tool' as const),
        })),
      ),
      models,
      skills: inspecting
        ? []
        : runtime.skills.map((skill) => ({
            id: identity(skill.path),
            name: skill.name,
            description: skill.description,
            path: skill.path,
            // One that ships with Circle is bundled, as an extension that does is.
            scope:
              skill.source_label === BUILTIN_SKILL_SOURCE
                ? 'bundled'
                : skill.source_label.startsWith('Project') ||
                    skill.source_label.startsWith('Ancestor')
                  ? 'project'
                  : 'user',
            content: loadSkillBody(skill.name, runtime.skills),
          })),
      commands:
        !inspecting && isFolderTrusted(settings, runtime.options.workspace)
          ? [
              ...discoverCustomCommands(
                runtime.options.workspace,
                this.home,
                this.options.userHome,
              ).map((command) => ({
                name: command.name,
                description: command.description,
                arguments: command.argument_hint,
                scope: command.source.startsWith(runtime.options.workspace)
                  ? ('project' as const)
                  : ('user' as const),
                template: command.template,
              })),
              ...runtime.extensions.extensions.flatMap((extension) =>
                this.presentExtension(runtime, extension).commands.map(
                  (command) => ({
                    name: command.name,
                    description: command.description,
                    arguments: '',
                    scope: 'extension' as const,
                    template: '',
                  }),
                ),
              ),
            ]
          : [],
      mcp: savedSettings.mcp_servers.map((spec, i) => {
        const applied = inspecting
          ? undefined
          : settings.mcp_servers.find((row) => row.name === spec.name);
        const pendingReload = JSON.stringify(applied) !== JSON.stringify(spec);
        const status = inspecting
          ? undefined
          : runtime.mcp.status.find((row) => row.name === spec.name);
        return {
          id: String(spec.id ?? spec.name ?? i),
          name: String(spec.name ?? `server ${i + 1}`),
          transport: String(spec.transport ?? 'stdio') as 'stdio',
          command: String(spec.command ?? ''),
          args: Array.isArray(spec.args) ? formatMcpArguments(spec.args) : '',
          url: String(spec.url ?? ''),
          enabled: spec.enabled !== false,
          status: pendingReload
            ? 'reload required'
            : spec.enabled === false
              ? 'not connected'
              : status
                ? status.error
                  ? 'error'
                  : 'connected'
                : 'not connected',
          error: status?.error === 'disabled' ? undefined : status?.error,
          tools: runtime.mcp.tools
            .filter((tool) => status?.tools.includes(tool.name))
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              schema: tool.parameters,
            })),
        };
      }),
      extensions: inspecting
        ? []
        : runtime.extensions.extensions.map((extension) => {
            const shown = this.presentExtension(runtime, extension);
            return {
              id: extension.name,
              name: extension.name,
              version: extension.version,
              scope: extension.source,
              enabled: extension.enabled,
              status:
                extension.enabled && !extension.error
                  ? shown.status
                  : undefined,
              view:
                extension.enabled && !extension.error ? shown.view : undefined,
              tools: shown.tools.map((tool) => tool.name),
              commands: shown.commands.map((command) => command.name),
              declaredCommands: extension.declaredCommands,
              events: [...extension.handlers.keys()],
              error: extension.error || undefined,
            };
          }),
      requests: [],
      tools: inspecting
        ? []
        : runtime.allTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            kind: tool.effect,
            detail:
              tool.approval === false
                ? 'Runs under the core tool boundary.'
                : 'Approval is enforced by the Circle core.',
            schema: tool.parameters,
          })),
      uiPlugins: ['files', 'browser'],
      openUrl: this.openRequest,
      ...(this.whatsNew ? { whatsNew: this.whatsNew } : {}),
      settings: {
        theme: savedSettings.theme,
        hideThinking: savedSettings.hide_thinking,
        defaultModel: savedSettings.auth.model,
        defaultEffort: (savedSettings.default_thinking || 'default') as Effort,
        enabledModels: savedSettings.enabled_models,
        doubleEscape: savedSettings.double_escape,
        endpoint: settings.auth.base_url,
        protocol: settings.auth.protocol as 'openai' | 'anthropic',
        credentialFiles: savedSettings.credential_files,
        variables: { ...savedSettings.variables },
        // Names only: a saved value never leaves the runtime
        secrets: secretNames(this.home),
        updateCheck: savedSettings.update_check,
        workspaceFolder: defaultFolder.folder,
        ...(defaultFolder.stale
          ? { oldWorkspaceFolder: defaultFolder.stale }
          : {}),
        taskFolder: taskRoot,
        textSize: 'default',
        keybindings: {},
        hooks: runtime.hookListing().map(({ hook, active }) => ({
          source: hook.source,
          event: hook.event,
          name: hook.name,
          command: hook.command,
          tools: hook.tools === '*' ? '*' : hook.tools.join(', '),
          paths: hook.paths.join(', '),
          ...(hook.skill ? { skill: hook.skill } : {}),
          active,
        })),
        projectHooksIgnored: runtime.hookCatalog.projectIgnored,
      },
    };
  }
  // The terminal footer's numbers (src/tui/session_app.ts): usage over the whole session,
  // cost as formatCosts writes it, and the context of the last answer from this model.
  private meters(runtime: AgentRuntime): NonNullable<Session['meters']> {
    const stats = runtime.stats();
    const facts =
      runtime.harness.model.modelFacts ??
      runtime.catalog.facts(
        runtime.harness.model.model,
        runtime.options.settings,
        runtime.harness.model.contextWindow,
      );
    const last = runtime.harness.messages
      .filter((message) => message.role === 'assistant' && message.usage)
      .at(-1);
    const unreported = runtime.busy && stats.usage.input_tokens === 0;
    return {
      input: stats.usage.input_tokens,
      output: stats.usage.output_tokens,
      cacheRead: stats.usage.cache_read_tokens,
      cache: unreported ? 'N/A' : cacheRateLabel(stats.usage),
      inputUnknown: unreported,
      cost: formatCosts(
        [stats.costs],
        facts.rates?.input !== undefined && facts.rates.output !== undefined,
      ),
      contextInput:
        !last?.request_model ||
        last.request_model === runtime.harness.model.model
          ? (last?.usage?.input_tokens ?? null)
          : null,
      contextWindow: facts.windowKnown ? facts.contextWindow : null,
    };
  }
  private turn(id: string): Session['turn'] {
    const turn = this.turns.get(id);
    if (!turn) return undefined;
    return {
      verb: turn.status.verb,
      startedAt: turn.started,
      waited:
        turn.waited + (turn.since === undefined ? 0 : Date.now() - turn.since),
      tokens: turn.status.tokens,
      retry: turn.status.retry,
    };
  }
  private changeList(id: string): Session['changes'] {
    const files = this.changes.get(id);
    if (!files) return undefined;
    return [...files]
      .filter(([, file]) => file.diff)
      .map(([path, file]) => ({
        path,
        kind:
          file.original === undefined
            ? ('added' as const)
            : file.diff!.summary.startsWith('deleted')
              ? ('deleted' as const)
              : ('modified' as const),
        diff: file.diff!,
        at: file.at,
      }));
  }
  // Before a file tool runs: its diff against the file as it is, and the file's first
  // version for the session's changes. After it ran: how the file differs from that.
  private fileEvent(runtime: AgentRuntime, id: string, event: CircleEvent) {
    const name = String(event.payload.name ?? '');
    const args = (event.payload.args ?? {}) as Record<string, unknown>;
    const callId = String(event.payload.id ?? '');
    if (!FILE_TOOLS.includes(name) || !callId) return;
    const resolve = (path: string) => runtime.sandbox.resolvePath(path);
    if (event.kind === 'tool_waiting' || event.kind === 'tool_start') {
      const diff = diffView(approvalPreview(name, args, resolve, DIFF_ROWS));
      if (diff) this.diffs.set(`${id}:${callId}`, diff);
      if (event.kind !== 'tool_start') return;
      const files = this.changes.get(id) ?? new Map();
      this.changes.set(id, files);
      for (const path of changedPaths(name, args)) {
        let target: string;
        try {
          target = resolve(path);
        } catch {
          continue;
        }
        if (!files.has(target))
          files.set(target, { original: readText(target), at: event.ts });
      }
      return;
    }
    if (event.kind !== 'tool_result') return;
    for (const [target, file] of this.changes.get(id) ?? []) {
      const now = existsSync(target) ? readText(target) : undefined;
      const diff = diffView(fileChange(file.original, now, DIFF_ROWS));
      file.diff = diff;
      if (diff) file.at = event.ts;
    }
  }
  private savedKey(): string {
    try {
      const settings = loadSettings(this.home);
      const credentials = loadCredentials(this.home);
      return (
        credentials[settings.auth.api_key_ref] ||
        credentials.api_key ||
        ''
      ).trim();
    } catch {
      return '';
    }
  }
  // The key for `url`: the one typed, or else the saved one while `url` stays on the saved
  // endpoint's host (keepsSavedKey). A key saved for one provider is never sent to another.
  private keyFor(url: string, typed: unknown): string {
    const key = text(typed, 'API key', 4096).trim();
    if (key) return key;
    let saved: CircleSettings;
    try {
      saved = loadSettings(this.home);
    } catch {
      return '';
    }
    return keepsSavedKey(saved, url) ? this.savedKey() : '';
  }
  // An API URL the connection form may use: http(s), without credentials, query or fragment.
  private endpointOf(value: unknown): string {
    const endpoint = new URL(text(value, 'endpoint', 2000).trim());
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    )
      throw Error('invalid API endpoint');
    return normalizeBaseUrl(endpoint.href, 'openai');
  }
  publish(event?: RuntimeUpdate['event']) {
    if (this.closing) return;
    this.persistLocation();
    const update: RuntimeUpdate = {
      seq: ++this.sequence,
      connected: true,
      snapshot: this.snapshot(),
      tokenStream: { epoch: this.tokenEpoch, seq: this.tokenSequence },
      event,
    };
    this.options.emit(update);
    this.refreshTerminalTabWaits();
    return update;
  }
  private event(
    runtime: AgentRuntime,
    event: CircleEvent,
    publishSnapshot = true,
  ) {
    if (runtime.isClosing) return;
    if (
      ['run_end', 'run_error'].includes(event.kind) &&
      this.pendingTrustReloads.has(runtime)
    )
      setImmediate(() => {
        if (!runtime.isClosing && !this.closing)
          this.track(this.reloadTrustedRuntime(runtime), runtime, true);
      });
    const id = String(
      event.tags?.subagent ?? event.tags?.session_id ?? runtime.session.id,
    );
    if (event.tags?.subagent)
      this.activities.set(
        id,
        nextAgentActivity(this.activities.get(id), event),
      );
    if (!event.tags?.subagent && event.kind === 'todo_list') {
      let tracker = this.planCompletions.get(id);
      if (!tracker) {
        tracker = new PlanCompletionTracker();
        this.planCompletions.set(id, tracker);
      }
      const count = tracker.update(runtime.todos);
      if (count !== undefined) {
        const rows = this.notices.get(id) ?? [];
        rows.push({
          id: `plan-completed-${randomUUID()}`,
          after: runtime.store.get(id)?.head ?? null,
          text: `plan completed · ${count} steps`,
          at: event.ts,
          planCompleted: count,
        });
        this.notices.set(id, rows);
      }
    }
    if (!event.tags?.subagent) {
      const journal = this.fileRewinds.get(runtime);
      if (event.kind === 'run_start') {
        const user = runtime.store
          .tree(runtime.session.id)
          .findLast((node) => node.message?.role === 'user');
        if (user) journal?.beginTurn(user.id);
      }
      if (['run_end', 'run_error'].includes(event.kind)) journal?.endTurn();
    }
    if (event.kind === 'run_start') {
      this.activeRuns.add(id);
      // The stop mark belongs to the turn that was stopped, as in the terminal.
      const kept = (this.notices.get(id) ?? []).filter(
        (row) => row.text !== '✖ Interrupted',
      );
      this.notices.set(id, kept);
    }
    if (['run_end', 'run_error'].includes(event.kind))
      this.activeRuns.delete(id);
    if (!event.tags?.subagent) {
      const now = Date.now();
      if (event.kind === 'run_start')
        this.turns.set(id, {
          status: new TurnStatus(),
          started: now,
          waited: 0,
        });
      const turn = this.turns.get(id);
      if (turn) {
        // The turn's line goes under its last message, as in the terminal
        turn.status.apply(
          event,
          () =>
            id === runtime.session.id
              ? runtime.harness.messages.at(-1)?.id
              : undefined,
          now,
        );
        // Time spent waiting for a person is not the model's: the busy clock leaves it out.
        if (event.kind === 'tool_waiting') turn.since ??= now;
        if (
          ['tool_start', 'tool_result'].includes(event.kind) &&
          turn.since !== undefined
        ) {
          turn.waited += now - turn.since;
          turn.since = undefined;
        }
      }
      if (['run_end', 'run_error'].includes(event.kind)) {
        // What each finished turn took, kept while Circle runs, as the terminal keeps it
        if (turn)
          this.turnUsage.set(id, {
            ...this.turnUsage.get(id),
            ...turn.status.usage,
          });
        this.turns.delete(id);
      }
    }
    try {
      this.fileEvent(runtime, id, event);
    } catch {
      /* A diff is a view; failing to draw one never stops the turn. */
    }
    if (
      event.kind === 'info' &&
      !event.tags?.subagent &&
      (event.payload.model_notice as { event?: string } | undefined)?.event ===
        'title_failed' &&
      // A model without side requests is a scripted one. Every connected
      // endpoint can be asked, so that skip is nothing a person can act on.
      (event.payload.model_notice as { message?: string }).message !==
        'model has no side request'
    ) {
      const notice = event.payload.model_notice as { message?: string };
      const rows = this.notices.get(id) ?? [];
      rows.push({
        id: `title-failed-${randomUUID()}`,
        after: runtime.store.get(id)?.head ?? null,
        text: `title failed · ${String(notice.message ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 120)}`,
        at: event.ts,
      });
      this.notices.set(id, rows);
    }
    if (event.kind === 'run_error' && event.payload.interrupted) {
      const rows = this.notices.get(id) ?? [];
      if (!rows.some((row) => row.text === '✖ Interrupted')) {
        rows.push({
          id: `interrupted-${randomUUID()}`,
          after: runtime.store.get(id)?.head ?? null,
          text: '✖ Interrupted',
          at: event.ts,
        });
        this.notices.set(id, rows);
      }
    }
    if (event.kind === 'run_error' && !event.payload.interrupted) {
      const assistant = event.payload.completion_message_id
        ? runtime.store
            .messages(id)
            .find(
              (message) =>
                message.role === 'assistant' &&
                message.id === event.payload.completion_message_id,
            )
        : undefined;
      const persisted =
        assistant && (assistant.completion || assistant.truncated)
          ? completionFailure(assistant)
          : undefined;
      // A recorded completion failure is projected from history, including after restart.
      if (
        !event.payload.completion_failure ||
        persisted?.code !== event.payload.completion_failure
      ) {
        const rows = this.failures.get(id) ?? [];
        rows.push({
          id: `failure-${randomUUID()}`,
          after: runtime.store.get(id)?.head ?? null,
          text: `✖ ${String(event.payload.message ?? 'the turn failed')}`,
          ...(event.payload.completion_failure
            ? {
                completionFailure: event.payload
                  .completion_failure as ModelCompletionFailureCode,
              }
            : {}),
          at: event.ts,
        });
        this.failures.set(id, rows);
      }
    }
    if (event.kind === 'llm_start')
      this.streams.set(id, {
        id: `stream-${randomUUID()}`,
        text: '',
        thinking: '',
      });
    if (event.kind === 'llm_token' && !this.cancelling.has(id)) {
      const stream = this.streams.get(id);
      if (stream) {
        if (event.payload.thinking)
          stream.thinking += String(event.payload.text ?? '');
        else stream.text += String(event.payload.text ?? '');
      }
    }
    if (['llm_end', 'run_end', 'run_error', 'error'].includes(event.kind))
      this.streams.delete(id);
    if (
      ['tool_waiting', 'tool_start', 'tool_result', 'tool_end'].includes(
        event.kind,
      )
    ) {
      const result = event.payload.message as CoreMessage | undefined;
      const callId = String(event.payload.id ?? result?.tool_call_id ?? '');
      this.toolStates.set(`${id}:${callId}`, {
        status:
          event.kind === 'tool_waiting'
            ? 'waiting'
            : event.kind === 'tool_start'
              ? 'running'
              : event.payload.status === 'error' || result?.status === 'error'
                ? 'error'
                : 'success',
        output:
          result?.content ?? this.toolStates.get(`${id}:${callId}`)?.output,
      });
    }
    // The bus is observation only. Enforcement remains inside Harness and awaited callbacks.
    if (
      publishSnapshot &&
      event.kind === 'llm_token' &&
      this.options.emitTokenDelta
    ) {
      const stream = this.streams.get(id);
      if (stream) {
        const chunk = String(event.payload.text ?? '');
        this.options.emitTokenDelta({
          epoch: this.tokenEpoch,
          seq: ++this.tokenSequence,
          baseSeq: this.sequence,
          sessionId: id,
          streamId: stream.id,
          parentId: this.store.get(id)?.head ?? null,
          text: event.payload.thinking ? undefined : chunk,
          thinking: event.payload.thinking ? chunk : undefined,
          at: event.ts,
          turn: this.turn(id),
        });
        return;
      }
    }
    if (!publishSnapshot) return;
    this.publish({
      kind: event.kind,
      sessionId: id,
      payload: event.payload,
      runId: event.run_id,
      eventSeq: event.seq,
      at: event.ts,
      parentRunId: event.parent_run_id ?? undefined,
    });
  }
  private wait(
    runtime: AgentRuntime,
    row: Omit<Interaction, 'id' | 'sessionId' | 'status' | 'revision'>,
    signal: AbortSignal,
    origin?: InteractionContext,
    secret?: SecretRequest,
  ): Promise<string> {
    const id = `interaction-${randomUUID()}`;
    const interaction: Interaction = {
      ...row,
      id,
      sessionId: runtime.session.id,
      status: 'pending',
      revision: 1,
      origin: origin ? { ...origin } : undefined,
    };
    return this.taskResources.suspendResource(
      'agent',
      () =>
        new Promise<string>((resolve, reject) => {
          const abort = () => {
            this.pending.delete(id);
            reject(new Error('interaction cancelled'));
            this.publish();
          };
          const finish = (answer: string) => {
            signal.removeEventListener('abort', abort);
            resolve(answer);
          };
          this.pending.set(id, {
            row: interaction,
            signal,
            resolve: finish,
            reject: (error) => {
              signal.removeEventListener('abort', abort);
              reject(error);
            },
            secret,
          });
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          else this.publish();
        }),
      signal,
    );
  }
  private async approve(
    runtime: AgentRuntime,
    call: ToolCall,
    signal: AbortSignal,
    origin?: InteractionContext,
  ): Promise<ApprovalDecision> {
    const review = runtime.policy.review(call.name, call.args);
    const answer = await this.wait(
      runtime,
      {
        kind: 'approval',
        callId: call.id,
        input: structuredClone(call.args),
        title: `${call.name} · ${review.reason}`,
        reason: review.reason,
        ...(call.hook_reason ? { hookReason: call.hook_reason } : {}),
        prefix: review.prefix.length ? review.prefix.join(' ') : undefined,
        tool: call.name,
        command:
          typeof call.args.command === 'string' ? call.args.command : undefined,
        target: String(call.args.file_path ?? call.args.path ?? ''),
        diff:
          this.diffs.get(`${runtime.session.id}:${call.id}`) ??
          diffView(
            approvalPreview(
              call.name,
              call.args,
              (path) => runtime.sandbox.resolvePath(path),
              DIFF_ROWS,
            ),
          ),
        choices: [
          'approve',
          ...(review.verdict === 'ASK' && review.pattern ? ['always'] : []),
          ...(review.prefix.length ? ['prefix'] : []),
          'reject',
        ],
      },
      signal,
      origin,
    );
    return answer.startsWith('reject: ')
      ? { decision: 'reject', message: answer.slice(8) }
      : (answer as ApprovalDecision);
  }
  /** The variables or saved secrets changed: every conversation's model is told anew. */
  private secretsChanged() {
    for (const runtime of this.runtimes.values()) runtime.refreshPrompt();
    this.publish();
  }
  /** The model pressed "proceed" on a certificate warning: the person decides, auto mode passes it. */
  private async confirmCertificate(
    runtime: AgentRuntime,
    approval: CertificateApproval,
    signal: AbortSignal,
    callId?: string,
  ): Promise<'once' | 'always' | 'reject' | 'auto'> {
    // Auto mode passes it without asking; the model's result names the certificate
    if (runtime.policy.mode(runtime.session.id) === 'auto') return 'auto';
    const answer = await this.wait(
      runtime,
      {
        kind: 'approval',
        callId,
        tool: 'browser_click',
        title: `browser_click · trusts an untrusted certificate`,
        reason: 'trusts an untrusted certificate',
        target: approval.url,
        input: {
          host: approval.host,
          issued_to: approval.subject,
          issued_by: approval.issuer,
          valid_until: new Date(approval.validExpiry * 1000)
            .toISOString()
            .slice(0, 10),
          sha256: approval.fingerprint,
        },
        // Only a host on this network can be trusted for good.
        choices: [
          'approve',
          ...(approval.privateHost ? ['always'] : []),
          'reject',
        ],
      },
      signal,
    );
    return answer === 'approve'
      ? 'once'
      : answer === 'always'
        ? 'always'
        : 'reject';
  }
  /** A device whose SSH host key nobody has trusted: the person decides, auto mode trusts once. */
  private async confirmHostKey(
    runtime: AgentRuntime,
    approval: TerminalHostKeyApproval,
    signal: AbortSignal,
    callId?: string,
  ): Promise<'once' | 'always' | 'reject' | 'auto'> {
    if (runtime.policy.mode(runtime.session.id) === 'auto') return 'auto';
    const answer = await this.wait(
      runtime,
      {
        kind: 'approval',
        callId,
        tool: 'terminal_connect',
        title: 'terminal_connect · trusts an unknown device key',
        reason: 'trusts an unknown device host key',
        target: approval.host,
        input: {
          host: approval.host,
          key_type: approval.keyType || 'unknown',
          sha256: approval.fingerprint,
        },
        // Only a device on this network can be trusted for good.
        choices: [
          'approve',
          ...(approval.privateHost ? ['always'] : []),
          'reject',
        ],
      },
      signal,
    );
    return answer === 'approve'
      ? 'once'
      : answer === 'always'
        ? 'always'
        : 'reject';
  }
  private async confirmCoordinate(
    runtime: AgentRuntime,
    approval: CoordinateApproval,
    signal: AbortSignal,
    callId?: string,
  ): Promise<'once' | 'reject'> {
    if (runtime.policy.mode(runtime.session.id) === 'auto') return 'once';
    const answer = await this.wait(
      runtime,
      {
        kind: 'approval',
        callId,
        tool: 'browser_click_at',
        title: 'browser_click_at · clicks a coordinate target',
        reason: 'clicks a coordinate target',
        target: approval.origin,
        input: {
          site: approval.origin,
          x: approval.x,
          y: approval.y,
          element: approval.element,
        },
        choices: ['approve', 'reject'],
      },
      signal,
    );
    return answer === 'approve' ? 'once' : 'reject';
  }
  /** The model would give a page files: the person sees which and where, every time. */
  private async confirmUpload(
    runtime: AgentRuntime,
    approval: UploadApproval,
    signal: AbortSignal,
    callId?: string,
  ): Promise<'once' | 'reject'> {
    // Auto mode gives the files without asking
    if (runtime.policy.mode(runtime.session.id) === 'auto') return 'once';
    const answer = await this.wait(
      runtime,
      {
        kind: 'approval',
        callId,
        tool: 'browser_upload',
        title: 'browser_upload · gives the page files',
        reason: 'gives the page files',
        target: approval.origin,
        input: {
          site: approval.origin,
          field: approval.element,
          files: approval.files
            .map((file) => `${file.path} (${sizeText(file.size)})`)
            .join('\n'),
        },
        choices: ['approve', 'reject'],
      },
      signal,
    );
    return answer === 'approve' ? 'once' : 'reject';
  }
  /**
   * The model's action downloaded files from a site not allowed yet: auto mode keeps them,
   * the other modes ask once for each site.
   */
  private async confirmDownload(
    runtime: AgentRuntime,
    approval: DownloadApproval,
    signal: AbortSignal,
    callId?: string,
  ): Promise<'once' | 'always' | 'reject'> {
    if (runtime.policy.mode(runtime.session.id) === 'auto') return 'once';
    const answer = await this.wait(
      runtime,
      {
        kind: 'approval',
        callId,
        tool: 'browser_download',
        title: 'browser_download · keeps a download',
        reason: 'keeps a download',
        target: approval.site,
        input: {
          site: approval.site,
          files: approval.files
            .map((file) => `${file.name} (${sizeText(file.size)})`)
            .join('\n'),
        },
        choices: ['approve', 'always', 'reject'],
      },
      signal,
    );
    return answer === 'approve'
      ? 'once'
      : answer === 'always'
        ? 'always'
        : 'reject';
  }
  private async question(
    runtime: AgentRuntime,
    args: Record<string, unknown>,
    signal: AbortSignal,
    origin?: InteractionContext,
  ): Promise<string> {
    const questions = args.questions as {
      question: string;
      options: { label: string; description: string }[];
      multiple: boolean;
    }[];
    const answers: (string | string[])[] = [];
    for (const question of questions) {
      const answer = await this.wait(
        runtime,
        {
          kind: 'question',
          title: question.question,
          choices: question.options.map((option) => option.label),
          multiple: question.multiple,
        },
        signal,
        origin,
      );
      try {
        const value = JSON.parse(answer);
        answers.push([
          ...(Array.isArray(value.choices) ? value.choices : []),
          ...(value.comment ? [value.comment] : []),
        ]);
      } catch {
        answers.push(answer === 'cancelled' ? '' : answer);
      }
    }
    return JSON.stringify(answers);
  }
  private async secret(
    runtime: AgentRuntime,
    request: SecretRequest,
    signal: AbortSignal,
    origin?: InteractionContext,
  ): Promise<void> {
    await this.wait(
      runtime,
      {
        kind: 'secret',
        title: request.question,
        // An extension's secret goes to it; a value with no file is kept as a Circle secret
        target: request.extension
          ? `extension ${request.extension}`
          : request.target_file || `%${request.key}%`,
      },
      signal,
      origin,
      request,
    );
  }
  private track(
    task: Promise<unknown>,
    runtime = this.active,
    reportFailure = false,
  ) {
    const sessionId = runtime.session.id;
    this.tasks.add(task);
    void task
      .catch((error) => {
        // Harness already emitted the typed failure and its transcript diagnostic.
        if (error instanceof ModelCompletionFailure && !reportFailure) return;
        if (!this.closing) {
          if (this.runtimes.lifecycle(sessionId) !== 'open') return;
          // Harness errors already arrive through run_error on the source session.
          // A manual compaction has no harness turn, so attach its error here.
          if (reportFailure && !this.cancelling.has(sessionId)) {
            const rows = this.failures.get(sessionId) ?? [];
            rows.push({
              id: `failure-${randomUUID()}`,
              after: this.store.get(sessionId)?.head ?? null,
              text: `✖ ${error instanceof Error ? error.message : 'runtime failed'}`,
              ...(error instanceof ModelCompletionFailure
                ? { completionFailure: error.code }
                : {}),
              at: new Date().toISOString(),
            });
            this.failures.set(sessionId, rows);
          }
          this.publish();
        }
      })
      .finally(() => {
        this.tasks.delete(task);
        if (!this.closing) this.publish();
      });
  }
  async dispatch(input: unknown): Promise<RuntimeReply> {
    let command: RuntimeCommand;
    try {
      command = validateRuntimeCommand(input);
    } catch (error) {
      return {
        id: String((input as RuntimeCommand)?.id ?? 'invalid'),
        ok: false,
        error: String(error),
      };
    }
    const signature = createHash('sha256')
      .update(JSON.stringify(command))
      .digest('hex');
    const accepted = this.accepted.get(command.id);
    if (accepted)
      return accepted.signature === signature
        ? accepted.reply
        : {
            id: command.id,
            ok: false,
            error: 'command identity was reused with different input',
          };
    const operation = async (): Promise<RuntimeReply> => {
      try {
        this.error = undefined;
        if (this.closing && command.name !== 'close')
          throw Error('runtime is closing');
        // Reject stale actions after a session switch. Answer additionally binds its request origin.
        if (
          command.sessionId &&
          command.sessionId !== this.selectedSessionId &&
          ![
            'select-session',
            'delete-session',
            'rename-session',
            'archive-session',
            'answer',
            'stop-job',
            'workspace-service',
            'list-external-file-grants',
            'revoke-external-file-grant',
          ].includes(command.name)
        )
          throw Error('session changed; retry from the current session');
        const data = await this.execute(command);
        let appliedState: RuntimeReply['appliedState'];
        if (!this.closing && command.name !== 'workspace-service') {
          const publication = this.publish();
          if (publication?.tokenStream)
            appliedState = {
              epoch: publication.tokenStream.epoch,
              seq: publication.seq,
            };
        }
        return {
          id: command.id,
          ok: true,
          data,
          ...(appliedState ? { appliedState } : {}),
        };
      } catch (error) {
        return {
          id: command.id,
          ok: false,
          error:
            error instanceof Error ? error.message : 'runtime command failed',
        };
      }
    };
    // Answers and interrupts must remain available while an asynchronous action is running.
    const immediate = [
      'answer',
      'abort',
      'state',
      'close',
      'background',
      'stop-job',
      'delete-session',
      'workspace-service',
      'select-session',
      'list-external-file-grants',
      'revoke-external-file-grant',
    ].includes(command.name);
    const result = immediate ? operation() : this.mutation.then(operation);
    if (!immediate) this.mutation = result.then(() => {});
    if (!['state', 'export'].includes(command.name)) {
      this.accepted.set(command.id, { signature, reply: result });
      if (this.accepted.size > 100)
        this.accepted.delete(this.accepted.keys().next().value!);
    }
    return result;
  }
  private async assertArchivable(
    id: string,
    workspace: string,
    action = 'archiving',
    // Whether its terminal tabs and tasks count: a confirmed archive stops them.
    stoppable = true,
  ): Promise<void> {
    const owner = this.runtimes.get(id);
    if (stoppable && (await this.nativeSessionActive(id, workspace)))
      throw Error(
        `stop this session's native resources and tasks before ${action} it`,
      );
    if (
      stoppable &&
      [...this.taskServices.values()].some((service) =>
        service.hasActiveSession(id),
      )
    )
      throw Error(`stop this session's tasks before ${action} it`);
    if (
      (!owner && sessionOccupied(this.home, id)) ||
      (owner?.session.id === id &&
        (owner.busy || this.runtimes.lifecycle(id) !== 'open')) ||
      owner?.jobs.list(id).some((job) => job.status === 'running') ||
      [...this.pending.values()].some((pending) => pending.row.sessionId === id)
    )
      throw Error(`stop this session before ${action} it`);
  }
  // Archiving stops nothing unasked. Once the person confirmed it, the sessions'
  // terminal tabs and tasks stop first, as for a deletion (#201), and only when
  // nothing else keeps any of the sessions from being archived.
  private async prepareArchive(
    rows: { id: string; workspace: string }[],
    confirmed: boolean,
  ): Promise<void> {
    if (confirmed) {
      for (const row of rows)
        await this.assertArchivable(row.id, row.workspace, 'archiving', false);
      for (const row of rows)
        if (await this.nativeSessionActive(row.id, row.workspace))
          await this.releaseSessionResources(row.id, row.workspace);
    }
    for (const row of rows) await this.assertArchivable(row.id, row.workspace);
  }
  private resetPlan(runtime: AgentRuntime): void {
    const tracker = new PlanCompletionTracker();
    tracker.reset(runtime.todos);
    this.planCompletions.set(runtime.session.id, tracker);
  }
  /** An empty untitled session. It is not kept once the user leaves it. */
  private async unusedSession(id: string): Promise<boolean> {
    const row = this.store.get(id);
    if (!row || row.parent_id || row.head || row.title) return false;
    const owner = this.runtimes.get(id);
    if (!owner || owner.busy) return false;
    // An agent-only parent and recoverable drafts are real work even without a
    // chat head. Leaving the view must not delete their provenance or payload.
    if (
      this.taskAgentAttempts(id).records.length ||
      this.taskProjectionErrors.size
    )
      return false;
    if (owner.harness.recoverableInputs.items.length) return false;
    const root =
      this.workspaceRoots.get(row.workspace)?.canonical ?? row.workspace;
    if (await this.nativeSessionActive(id, root)) return false;
    if ((await this.workspaceServices.get(root)?.terminals.list(id))?.length)
      return false;
    // Durable operations are real session work even when a tool failed before
    // producing a chat message or allocating a terminal. Include every state:
    // completed/reconciled records still carry this owner's idempotency history.
    const operationLedger =
      this.operationLedger ??
      (existsSync(
        join(
          this.options.dataFolder ?? this.home,
          'workspace-operations',
          'operations.sqlite',
        ),
      )
        ? this.ledger()
        : undefined);
    if (
      operationLedger &&
      (await operationLedger).list({ sessionId: id, limit: 1 }).length
    )
      return false;
    // Resource reads yield: recheck the session before classifying it as empty.
    const current = this.store.get(id);
    if (!current || current.head || current.title || owner.busy) return false;
    if (
      this.taskAgentAttempts(id).records.length ||
      owner.harness.recoverableInputs.items.length
    )
      return false;
    if (owner.jobs.list().some((job) => job.status === 'running')) return false;
    if (
      [...this.pending.values()].some((pending) => pending.row.sessionId === id)
    )
      return false;
    return this.runtimes.lifecycle(id) === 'open';
  }
  private async dropUnused(id: string): Promise<void> {
    if (!id || id === this.selectedSessionId || !(await this.unusedSession(id)))
      return;
    await this.runtimes.delete(id, { confirmed: true });
    this.publish();
  }
  // Conversations with no project live here, not in the default circle workspace.
  // That folder is a project of its own; sharing it made "no project" look like circle.
  private unscopedPath(): string {
    return join(this.home, 'unscoped');
  }
  private isUnscoped(target: string): boolean {
    const unscoped = this.unscopedPath();
    if (target === unscoped) return true;
    try {
      return target === realpathSync.native(unscoped);
    } catch {
      return false;
    }
  }
  private workspaceById(id: string): string {
    for (const row of this.store.list(undefined, true))
      if (identity(row.workspace) === id) return row.workspace;
    if (identity(this.active.options.workspace) === id)
      return this.active.options.workspace;
    for (const owner of this.runtimes.values())
      if (identity(owner.options.workspace) === id)
        return owner.options.workspace;
    for (const folder of this.opened)
      if (identity(folder) === id) return folder;
    try {
      const scratch = realpathSync.native(this.scratchPath());
      if (identity(scratch) === id || identity(this.scratchPath()) === id)
        return scratch;
    } catch {
      /* The scratch folder is not there yet. */
    }
    throw Error('workspace not found');
  }
  // The home composer chooses these before a session exists. Apply them to the
  // runtime that will run the first message, so the turn uses that choice.
  private applyHomeChoices(
    runtime: AgentRuntime,
    p: Record<string, unknown>,
  ): void {
    if (
      typeof p.modelId === 'string' &&
      p.modelId !== runtime.harness.model.model
    )
      runtime.setModel(text(p.modelId, 'model', 500));
    if (p.effort !== undefined) {
      const effort = text(p.effort, 'effort', 20);
      if (effort !== 'default') runtime.setThinkingLevel(effort);
    }
    if (p.mode !== undefined) {
      if (!isSessionMode(p.mode)) throw Error('invalid mode');
      runtime.setMode(p.mode);
    }
  }
  // A leftover untitled session with no messages is reused so the first message
  // does not sit beside it. Opening a folder does not create one.
  private conversationRuntime(workspace: string): AgentRuntime {
    const empty = this.store
      .list(workspace, false, true)
      .find(
        (row) =>
          !row.parent_id &&
          !row.title &&
          !this.metadata.archivedAt(row.id) &&
          this.store.messages(row.id).length === 0 &&
          this.runtimes.lifecycle(row.id) !== 'deleting' &&
          !this.runtimes.get(row.id)?.busy,
      );
    return empty
      ? this.runtimes.open(workspace, empty.id)
      : this.runtimes.create(workspace);
  }
  private async submitPrompt(
    runtime: AgentRuntime,
    p: Record<string, unknown>,
    untilStored = false,
    inputId?: string,
  ): Promise<{ sessionId?: string }> {
    this.assertTaskSettings();
    await this.reloadTrustedRuntime(runtime);
    if (!isFolderTrusted(runtime.options.settings, runtime.options.workspace))
      throw Error('trust the workspace before running Circle');
    if (!this.options.model && !isReady(runtime.options.settings))
      throw Error('connect an API URL, key and model first');
    const prompt = text(p.text, 'prompt');
    if (!prompt.trim()) throw Error('prompt is empty');
    const kind = p.kind ?? 'steering';
    if (!['steering', 'follow-up'].includes(String(kind)))
      throw Error('invalid queue kind');
    if (
      p.attachments !== undefined &&
      (!Array.isArray(p.attachments) || p.attachments.length > 16)
    )
      throw Error('invalid attachments');
    const attachments = (
      (p.attachments ?? []) as {
        content: string;
        mime: MediaAttachment['mime_type'];
        name: string;
      }[]
    ).map((item) =>
      attachmentFromBase64(
        // up to the core's 20 MiB, as base64 behind a data: prefix
        text(
          item.content,
          'attachment',
          Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 100,
        ).replace(/^data:[^;]+;base64,/, ''),
        item.mime,
        text(item.name, 'filename', 500),
      ),
    );
    const display =
      p.display === undefined ? undefined : text(p.display, 'display');
    // A command whose durable input is already recorded is a replay: it goes
    // through the queue under the same input id instead of starting a turn twice.
    if (
      runtime.busy ||
      (inputId !== undefined &&
        this.store.inputs.get(runtime.session.id, inputId))
    ) {
      if (untilStored) throw Error('a turn is running');
      runtime.harness.queue(
        prompt,
        kind === 'follow-up' ? 'followUp' : 'steer',
        attachments,
        { inputId, display },
      );
      return {};
    }
    const run = runtime.harness.run(prompt, display, attachments);
    this.track(run, runtime);
    if (!untilStored) return {};
    const failed = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    const deadline = Date.now() + 8000;
    while (
      !this.store
        .messages(runtime.session.id)
        .some((message) => message.role === 'user')
    ) {
      const error = await Promise.race([
        failed,
        new Promise((resolve) => setTimeout(resolve, 15)).then(() => undefined),
      ]);
      if (
        this.store
          .messages(runtime.session.id)
          .some((message) => message.role === 'user')
      )
        break;
      if (error) throw error;
      if (Date.now() > deadline) throw Error('the first message was not saved');
    }
    return { sessionId: runtime.session.id };
  }
  private async execute(command: RuntimeCommand): Promise<unknown> {
    if (command.name === 'workspace-service')
      return this.workspaceCommand(command);
    this.metadata.refresh();
    this.synchronizeSharedSettings(loadSettings(this.home));
    const p = command.payload;
    // These capability operations address their explicit owner and must never
    // open or acquire the unrelated session currently being inspected.
    if (command.name === 'revoke-external-file-grant')
      return this.revokeExternalFileGrant(
        command.sessionId ?? this.selectedSessionId,
        text(p.id, 'grant', 200),
      );
    if (command.name === 'list-external-file-grants') {
      const ownerId = command.sessionId ?? this.selectedSessionId;
      const owner = this.externalOwner(ownerId, 'read');
      if (this.externalGrantOwners.get(ownerId) !== owner) {
        await this.externalFiles?.revokeSession(ownerId);
        return [];
      }
      return this.externalFiles?.list(ownerId) ?? [];
    }
    let runtime = this.active;
    const navigation = [
      'state',
      'close',
      'abort',
      'answer',
      'select-session',
      'new-session',
      // Starts in the workspace it names and checks that root itself.
      'begin-session',
      'open-workspace',
      'set-default-workspace',
      'delete-session',
      'archive-session',
      'archive-workspace',
      'rename-session',
      'stop-job',
      'save-settings',
      'trust',
      'export',
    ];
    if (!navigation.includes(command.name)) {
      this.workspaceRoot(runtime.options.workspace);
      const viewed = this.viewedSessionId
        ? this.store.get(this.viewedSessionId)
        : undefined;
      if (viewed) this.workspaceRoot(viewed.workspace);
    }
    if (
      this.viewedSessionId &&
      ![
        'state',
        'close',
        'select-session',
        'new-session',
        'begin-session',
        'open-workspace',
        'set-default-workspace',
        'delete-session',
        'archive-session',
        'archive-workspace',
        'rename-session',
        'answer',
        'stop-job',
        'export',
        'clone',
        'fork',
      ].includes(command.name)
    ) {
      const row = this.store.get(this.viewedSessionId);
      if (!row) throw Error('session not found');
      // This acquires a lease only after the previous writer released it. A live
      // foreign writer rejects the action without touching the selected history.
      this.workspaceRoot(row.workspace);
      runtime = this.runtimes.open(row.workspace, row.id);
      this.active = runtime;
      this.viewedSessionId = undefined;
      this.workspaceSessions.set(row.workspace, row.id);
    }
    if (
      this.runtimes.lifecycle(this.selectedSessionId) !== 'open' &&
      ![
        'state',
        'close',
        'select-session',
        'new-session',
        'begin-session',
        'delete-session',
        'answer',
      ].includes(command.name)
    )
      throw Error('session is deleting; wait for cleanup to finish');
    if (
      this.metadata.archivedAt(this.selectedSessionId) &&
      [
        'prompt',
        'shell',
        'write-file',
        'custom-command',
        'load-skill',
        'compact',
        'share',
        'select-branch',
        'label-branch',
        'set-plan-mode',
        'set-mode',
        'set-model',
        'set-auto',
        'set-effort',
      ].includes(command.name)
    )
      throw Error('restore this session before continuing');
    switch (command.name) {
      case 'state':
        return this.snapshot();
      case 'prompt':
        await this.submitPrompt(runtime, p, false, command.id);
        return {};
      case 'begin-session': {
        const promptText = text(p.text, 'prompt');
        if (!promptText.trim()) throw Error('prompt is empty');
        if (p.prepareOnly !== undefined && typeof p.prepareOnly !== 'boolean')
          throw Error('invalid command preparation');
        const workspace =
          p.workspaceId === undefined
            ? // Work with no project: the first message opens in a task folder of its own.
              this.taskFolder()
            : this.workspaceById(text(p.workspaceId, 'workspace', 200));
        if (!isFolderTrusted(loadSettings(this.home), workspace))
          throw Error('trust the workspace before running Circle');
        // A root replaced since it was opened is refused, as for every session.
        this.bindWorkspace(workspace);
        const owner = this.conversationRuntime(workspace);
        this.selectRuntime(owner);
        this.applyHomeChoices(owner, p);
        const started =
          p.prepareOnly === true
            ? { sessionId: owner.session.id }
            : await this.submitPrompt(owner, p, true);
        // Home shows the notice. Starting the session from there marks it
        // seen, the same as dismissing it.
        if (this.whatsNew) {
          dismissWhatsNew(this.home);
          this.whatsNew = undefined;
        }
        return { sessionId: started.sessionId ?? owner.session.id };
      }
      case 'abort': {
        const id = runtime.session.id;
        this.cancelling.add(id);
        try {
          await runtime.cancel({ keepQueue: false });
        } finally {
          this.cancelling.delete(id);
        }
        return {};
      }
      case 'clear-queue':
        return runtime.harness.clearQueue();
      case 'remove-queued': {
        if (!['steering', 'follow-up'].includes(String(p.kind)))
          throw Error('invalid queue kind');
        return runtime.harness.removeQueued(
          p.kind === 'steering' ? 'steer' : 'followUp',
          Number(p.index),
          text(p.text, 'queued message'),
        );
      }
      case 'edit-queued': {
        if (
          !Number.isSafeInteger(p.expectedQueueVersion) ||
          Number(p.expectedQueueVersion) < 0
        )
          throw Error('queued message revision is required');
        if (!['steering', 'follow-up'].includes(String(p.kind)))
          throw Error('invalid queue kind');
        return runtime.harness.editQueued(
          p.kind === 'steering' ? 'steer' : 'followUp',
          Number(p.index),
          text(p.text, 'queued message'),
          text(p.updatedText, 'updated message'),
          Number(p.expectedQueueVersion),
        );
      }
      case 'background':
        return runtime.jobs.backgroundForeground();
      case 'new-session': {
        this.workspaceRoot(this.selectedWorkspace);
        const previous = this.selectedSessionId;
        // Work with no project of its own gets a task folder; a project keeps its
        // own sessions together. The draft conversation the app fell back to is not
        // this task's, so it stays where it was, ready for the next loose question.
        const task = await this.projectlessTask(runtime, previous);
        if (task) return { sessionId: task.session.id };
        if ((await this.unusedSession(previous)) && !this.viewedSessionId)
          return { sessionId: previous };
        const owner = this.runtimes.create(this.selectedWorkspace);
        await this.carryExtensions(owner, previous);
        this.selectRuntime(owner);
        if (previous !== owner.session.id) await this.dropUnused(previous);
        return { sessionId: owner.session.id };
      }
      case 'select-session': {
        const id = text(p.id, 'session', 200);
        const row = this.store.get(id);
        const taskRuntime = [...this.taskRuntimes.values()].find(
          (task) => task.session.id === id,
        );
        if (taskRuntime && !taskRuntime.isClosing) {
          this.selectRuntime(taskRuntime);
          return { sessionId: id };
        }
        if (!row || row.parent_id) throw Error('session not found');
        if (id === this.selectedSessionId && !this.viewedSessionId)
          return { sessionId: id };
        const previous = this.selectedSessionId;
        try {
          const owner = this.runtimes.open(row.workspace, id);
          await this.reloadTrustedRuntime(owner);
          await this.carryExtensions(owner, previous);
          if (owner.isClosing || this.closing)
            throw Error('session is closing');
          this.selectRuntime(owner);
          if (previous !== id) await this.dropUnused(previous);
        } catch (error) {
          if (!(error instanceof SessionOccupiedError)) throw error;
          const leaving = this.runtimes.get(previous);
          if (leaving && leaving.session.id !== id) leaving.yieldLease();
          this.previous = this.selectedSessionId;
          this.viewedSessionId = id;
        }
        return { sessionId: id };
      }
      case 'delete-session': {
        const id = text(p.id, 'session', 200);
        const row = this.store.get(id);
        if (!row || row.parent_id) throw Error('session not found');
        const taskRuntime = [...this.taskRuntimes.values()].find(
          (runtime) => runtime.session.id === id,
        );
        if (taskRuntime) {
          if (p.confirmed !== true)
            throw Error('confirm stopping this task before deleting it');
          await this.releaseSessionResources(id, row.workspace);
        }
        if (!this.runtimes.get(id)) this.workspaceRoot(row.workspace);
        const owner =
          this.runtimes.get(id) ?? this.runtimes.open(row.workspace, id);
        const owned = new Set([id]);
        const descendants = this.store.list(undefined, true);
        let changed = true;
        while (changed) {
          changed = false;
          for (const child of descendants)
            if (
              child.parent_id &&
              owned.has(child.parent_id) &&
              !owned.has(child.id)
            ) {
              owned.add(child.id);
              changed = true;
            }
        }
        if (
          p.confirmed !== true &&
          ((await this.nativeSessionActive(id, row.workspace)) ||
            owner.busy ||
            owner.jobs.list().some((job) => job.status === 'running') ||
            [...this.pending.values()].some((pending) =>
              owned.has(pending.row.sessionId),
            ))
        )
          throw Error(
            'confirm stopping this session and its tasks before deleting it',
          );
        this.deletionFailures.delete(id);
        for (const target of owned) this.externalBlocked.add(target);
        await Promise.all(
          [...owned].map((target) => this.externalFiles?.revokeSession(target)),
        );
        const deletion = this.runtimes.delete(id, {
          confirmed: p.confirmed === true,
        });
        this.publish();
        try {
          await deletion;
        } catch (error) {
          // A cleanup that failed leaves the session in deletion with its history (#195):
          // the window says why, and deleting it again retries the cleanup.
          this.deletionFailures.set(
            id,
            error instanceof Error ? error.message : String(error),
          );
          this.publish();
          throw error;
        }
        this.metadata.set([...owned], false);
        for (const target of owned) {
          await this.externalFiles?.revokeSession(target);
          this.externalGrantOwners.delete(target);
          this.streams.delete(target);
          this.activeRuns.delete(target);
          this.failures.delete(target);
          this.notices.delete(target);
          this.deletionFailures.delete(target);
          this.planCompletions.delete(target);
          this.turns.delete(target);
          this.turnUsage.delete(target);
          this.activities.delete(target);
          this.changes.delete(target);
          for (const key of this.diffs.keys())
            if (key.startsWith(`${target}:`)) this.diffs.delete(key);
          for (const key of this.toolStates.keys())
            if (key.startsWith(`${target}:`)) this.toolStates.delete(key);
        }
        if (this.openRequest && owned.has(this.openRequest.sessionId))
          this.openRequest = undefined;
        this.history = this.history.filter(
          (item) => !owned.has(item.sessionId),
        );
        if (this.previous === id) this.previous = null;
        if (this.workspaceSessions.get(row.workspace) === id)
          this.workspaceSessions.delete(row.workspace);
        this.pendingTrustReloads.delete(owner);
        if (!this.closing && this.active === owner) {
          const fallback = this.store
            .list(row.workspace, false, true)
            .find(
              (item) =>
                !this.metadata.archivedAt(item.id) &&
                (this.runtimes.get(item.id) ||
                  !sessionOccupied(this.home, item.id)),
            );
          this.active = fallback
            ? this.runtimes.open(row.workspace, fallback.id)
            : this.runtimes.create(row.workspace);
          this.workspaceSessions.set(row.workspace, this.active.session.id);
        }
        return { sessionId: this.selectedSessionId };
      }
      case 'archive-session': {
        const id = text(p.id, 'session', 200);
        const row = this.store.get(id);
        if (!row || row.parent_id) throw Error('session not found');
        const archive = flag(p.archived);
        if (archive) await this.prepareArchive([row], p.confirmed === true);
        if (archive) {
          this.externalBlocked.add(id);
          await this.externalFiles?.revokeSession(id);
          this.externalGrantOwners.delete(id);
        }
        if (!archive) this.externalBlocked.delete(id);
        this.metadata.set([id], archive);
        return { sessionId: id, archivedAt: this.metadata.archivedAt(id) };
      }
      case 'archive-workspace': {
        const workspaceId = text(p.workspaceId, 'workspace', 200);
        const rows = this.store
          .list(undefined, false, true)
          .filter((row) => identity(row.workspace) === workspaceId);
        // A folder that only holds archived sessions is still one the settings page
        // can name, so ask workspaceById before deciding there is nothing to hide.
        const folder = this.workspaceById(workspaceId);
        await this.prepareArchive(rows, p.confirmed === true);
        // Removing a folder from the settings page forgets it altogether: an
        // opened folder with no sessions of its own would otherwise stay
        // listed forever, which reads as a remove that does nothing.
        this.opened.delete(folder);
        for (const row of rows) this.externalBlocked.add(row.id);
        for (const row of rows) {
          await this.externalFiles?.revokeSession(row.id);
          this.externalGrantOwners.delete(row.id);
        }
        this.metadata.set(
          rows.map((row) => row.id),
          true,
        );
        return { archived: rows.length };
      }
      case 'rename-session':
        if (!this.store.get(String(p.id ?? command.sessionId)))
          throw Error('session not found');
        // The person chose this name. A later open, here or in the terminal,
        // does not replace it with a generated title.
        this.store.rename(
          String(p.id ?? command.sessionId),
          text(p.title, 'title', 500),
          true,
        );
        return {};
      case 'fork':
      case 'clone':
      case 'select-branch': {
        if (
          command.name === 'select-branch' &&
          (runtime.busy ||
            runtime.jobs.list().some((job) => job.status === 'running'))
        )
          throw Error('stop the current turn before branching');
        const sourceId = this.selectedSessionId;
        const workspace = this.selectedWorkspace;
        const nodes = this.store.tree(sourceId);
        const node = p.messageId
          ? nodes.find((node) => node.id === p.messageId)
          : undefined;
        if ((p.messageId || command.name !== 'clone') && !node)
          throw Error('checkpoint not found');
        const head =
          command.name === 'clone'
            ? this.store.get(sourceId)!.head
            : command.name === 'fork'
              ? node!.parent
              : node!.id;
        this.store.requireBalancedTools(this.store.messages(sourceId, head));
        if (command.name === 'select-branch') {
          runtime.store.select(runtime.session.id, head);
          await runtime.switchSession(runtime.session.id);
        } else {
          const previous = sourceId;
          const fork = this.store.fork(sourceId, workspace, head);
          const owner = this.runtimes.open(workspace, fork.id);
          this.selectRuntime(owner);
          runtime = owner;
          this.previous = previous;
        }
        runtime.policy.setYolo(runtime.session.id, false);
        this.resetPlan(runtime);
        return { sessionId: runtime.session.id };
      }
      case 'label-branch': {
        const node = runtime.store
          .tree(runtime.session.id)
          .find((node) => node.id === p.messageId);
        if (!node?.message) throw Error('checkpoint not found');
        runtime.store.setLabel(
          runtime.session.id,
          node.message.id,
          text(p.label, 'label', 500),
        );
        return {};
      }
      case 'set-model': {
        runtime.setModel(text(p.modelId, 'model', 500));
        if (p.saveDefault === true) {
          const settings = saveSettingsChange(this.home, (saved) => {
            saved.auth.model = runtime.harness.model.model;
          });
          runtime.options.settings.auth.model = settings.auth.model;
        }
        return {};
      }
      case 'set-effort': {
        runtime.applyThinkingChoice(text(p.effort, 'effort', 20));
        const settings = saveSettingsChange(this.home, (saved) => {
          saved.default_thinking = runtime.options.settings.default_thinking;
        });
        this.applySharedEffort(settings.default_thinking, runtime);
        return {};
      }
      case 'set-plan-mode':
        runtime.setPlanMode(flag(p.enabled));
        if (flag(p.enabled))
          await this.externalFiles?.revokeSession(runtime.session.id);
        return {};
      case 'set-auto':
        runtime.policy.setYolo(runtime.session.id, flag(p.enabled));
        return {};
      case 'set-mode':
        if (!isSessionMode(p.mode)) throw Error('invalid mode');
        runtime.setMode(p.mode);
        if (p.mode === 'plan')
          await this.externalFiles?.revokeSession(runtime.session.id);
        return {};
      case 'configure': {
        if (
          [...this.runtimes.values()].some(
            (owner) =>
              owner.isClosing ||
              owner.busy ||
              owner.jobs.list().some((job) => job.status === 'running'),
          )
        )
          throw Error('finish the current turn before changing connection');
        const endpoint = this.endpointOf(p.endpoint);
        const protocol = text(p.protocol, 'protocol', 20);
        if (!['openai', 'anthropic'].includes(protocol))
          throw Error('invalid protocol');
        const baseUrl = normalizeBaseUrl(endpoint, protocol);
        const model = text(p.model, 'model', 500);
        if (!model.trim()) throw Error('model required');
        // An empty key keeps the saved one on the same host, so the path or the model can
        // change alone; another host needs its own key.
        const secret = this.keyFor(baseUrl, p.apiKey);
        if (!secret) throw Error('enter the API key for this endpoint');
        const settings = withConnectionLock(this.home, () => {
          saveCredentials({ api_key: secret }, this.home);
          return saveSettingsChange(this.home, (saved) => {
            Object.assign(
              saved,
              withConnection(
                { protocol, base_url: baseUrl, model, api_key_ref: 'api_key' },
                this.home,
              ),
            );
          });
        });
        this.keySaved = true;
        // The models listed are this endpoint's: what the form's probe found at the URL and
        // kind of API being saved, or none until they are asked for.
        const probed = this.probed;
        this.discoveredModels =
          probed &&
          probed.protocol === protocol &&
          normalizeBaseUrl(probed.baseUrl, protocol) === baseUrl
            ? [...probed.models]
            : [];
        for (const owner of this.runtimes.values()) {
          owner.refreshConnection({
            ...owner.options.settings,
            auth: structuredClone(settings.auth),
            initialized: settings.initialized,
            // withConnection empties it when the endpoint changes: it named the old one's models
            enabled_models: [...settings.enabled_models],
          });
        }
        return {};
      }
      case 'probe-connection': {
        // Setup's discovery (src/probe.ts): which kind of API answers at the URL, or its /v1,
        // and what models it lists. Nothing is saved; the key is neither returned nor kept.
        const endpoint = this.endpointOf(p.endpoint);
        const key = this.keyFor(endpoint, p.apiKey);
        if (!key) throw Error('enter the API key for this endpoint');
        const found = await connectionModels(
          endpoint,
          key,
          p.provider === undefined
            ? 'custom'
            : text(p.provider, 'provider', 100),
        );
        const baseUrl = found.base_url || endpoint;
        this.probed = {
          baseUrl,
          protocol: found.protocol,
          models: found.status === 'preset' ? [] : [...found.models],
        };
        return {
          status: found.status,
          protocol: found.protocol,
          models: found.models,
          baseUrl,
          inferred: found.inferred,
          summary: connectionSummary(found),
          detail: found.detail,
        };
      }
      case 'logout': {
        this.keySaved = undefined;
        if (
          [...this.runtimes.values()].some(
            (owner) =>
              owner.isClosing ||
              owner.busy ||
              owner.jobs.list().some((job) => job.status === 'running'),
          )
        )
          throw Error('stop the current turn before signing out');
        const settings = withConnectionLock(this.home, () => {
          clearCredentials(this.home);
          return saveSettingsChange(this.home, (saved) => {
            saved.initialized = false;
            saved.auth.base_url = '';
          });
        });
        for (const owner of this.runtimes.values()) {
          owner.refreshConnection({
            ...owner.options.settings,
            auth: structuredClone(settings.auth),
            initialized: settings.initialized,
          });
        }
        return {};
      }
      case 'trust': {
        // Both answers are a deliberate click: trusting loads a folder's code,
        // revoking it takes that away again.
        if (typeof p.enabled !== 'boolean')
          throw Error('explicit trust confirmation required');
        const enabled = p.enabled;
        // Home can ask to trust the project in the menu while another session
        // is the one open. The id names that project; otherwise it is the open one.
        const folder =
          p.workspaceId === undefined
            ? runtime.options.workspace
            : this.workspaceById(text(p.workspaceId, 'workspace', 200));
        const settings = saveSettingsChange(this.home, (saved) => {
          Object.assign(
            saved,
            enabled ? trustFolder(saved, folder) : untrustFolder(saved, folder),
          );
        });
        this.synchronizeSharedSettings(settings);
        const reloads: Promise<void>[] = [];
        for (const owner of this.runtimes.values())
          if (
            owner.options.workspace === folder &&
            this.pendingTrustReloads.has(owner) &&
            !owner.isClosing
          ) {
            reloads.push(this.reloadTrustedRuntime(owner));
          }
        await Promise.all(reloads);
        return { workspaceId: identity(folder), trusted: enabled };
      }
      case 'save-settings': {
        const data = p.settings as Record<string, unknown>;
        const settings = saveSettingsChange(this.home, (settings) => {
          if (!data || typeof data !== 'object' || Array.isArray(data))
            throw Error('invalid settings');
          if (
            data.workspaceFolder !== undefined ||
            data.oldWorkspaceFolder !== undefined ||
            data.taskFolder !== undefined
          )
            throw Error(
              'the default workspace only changes through the native folder dialog',
            );
          if (data.theme !== undefined) {
            if (!['auto', 'light', 'dark'].includes(String(data.theme)))
              throw Error('invalid theme');
            settings.theme = data.theme as CircleSettings['theme'];
          }
          if (data.hideThinking !== undefined)
            settings.hide_thinking = flag(data.hideThinking);
          if (data.updateCheck !== undefined)
            settings.update_check = flag(data.updateCheck);
          if (data.defaultModel !== undefined)
            settings.auth.model = text(data.defaultModel, 'model', 500);
          if (data.defaultEffort !== undefined) {
            const value = text(data.defaultEffort, 'effort', 20);
            if (
              ![
                'default',
                'minimal',
                'low',
                'medium',
                'high',
                'xhigh',
                'max',
              ].includes(value)
            )
              throw Error('invalid effort');
            settings.default_thinking = value === 'default' ? '' : value;
          }
          if (data.doubleEscape !== undefined) {
            if (!['tree', 'fork', 'none'].includes(String(data.doubleEscape)))
              throw Error('invalid shortcut');
            settings.double_escape =
              data.doubleEscape as CircleSettings['double_escape'];
          }
          for (const [ui, core] of [
            ['enabledModels', 'enabled_models'],
            ['credentialFiles', 'credential_files'],
          ] as const)
            if (data[ui] !== undefined) {
              if (
                !Array.isArray(data[ui]) ||
                !(data[ui] as unknown[]).every(
                  (item) => typeof item === 'string' && item.length < 1000,
                )
              )
                throw Error('invalid settings list');
              settings[core] = data[ui] as string[];
            }
          if (data.variables !== undefined) {
            if (
              !data.variables ||
              typeof data.variables !== 'object' ||
              Array.isArray(data.variables)
            )
              throw Error('invalid variables');
            const variables: Record<string, string> = {};
            for (const [name, value] of Object.entries(data.variables)) {
              if (!VARIABLE_NAME.test(name))
                throw Error(
                  'a variable name is capital letters, digits and _, starting with a letter',
                );
              // One name, one value: %NAME% must not mean two things
              if (secretNames(this.home).includes(name))
                throw Error(`${name} is already a secret`);
              variables[name] = text(value, 'variable value', 2000);
            }
            settings.variables = variables;
          }
          if (p.mcp !== undefined) {
            if (!Array.isArray(p.mcp)) throw Error('invalid MCP settings');
            settings.mcp_servers = p.mcp.map((entry) => {
              if (!entry || typeof entry !== 'object')
                throw Error('invalid MCP server');
              const row = entry as Record<string, unknown>;
              const transport = text(row.transport, 'transport', 50);
              if (
                !['stdio', 'sse', 'streamable_http', 'websocket'].includes(
                  transport,
                )
              )
                throw Error('invalid transport');
              return {
                ...settings.mcp_servers.find(
                  (saved) =>
                    saved.name === row.name || (row.id && saved.id === row.id),
                ),
                id: text(row.id ?? row.name, 'server id', 200),
                name: text(row.name, 'server name', 100),
                transport,
                command: text(row.command ?? '', 'command', 4000),
                args: parseMcpArguments(text(row.args ?? '', 'args', 4000)),
                url: text(row.url ?? '', 'url', 4000),
                enabled: flag(row.enabled),
              };
            });
          }
          if (p.extensions !== undefined) {
            if (!Array.isArray(p.extensions)) throw Error('invalid extensions');
            for (const row of p.extensions as {
              name: string;
              enabled: boolean;
            }[])
              settings.extensions[text(row.name, 'extension', 100)] = {
                ...settings.extensions[row.name],
                enabled: flag(row.enabled),
              };
          }
        });
        this.synchronizeSharedSettings(settings);
        if (data.defaultEffort !== undefined)
          this.applySharedEffort(settings.default_thinking);
        if (data.variables !== undefined)
          for (const owner of this.runtimes.values()) {
            owner.options.settings.variables = { ...settings.variables };
            owner.refreshPrompt();
          }
        return {};
      }
      case 'reload': {
        if (
          !isFolderTrusted(loadSettings(this.home), runtime.options.workspace)
        )
          throw Error('trust the workspace first');
        await runtime.reloadIntegrations();
        if (!this.options.model && isReady(runtime.options.settings))
          runtime.setModel(runtime.options.settings.auth.model);
        return {};
      }
      case 'answer': {
        const id = text(p.id, 'interaction', 200);
        const pending = this.pending.get(id);
        if (
          !pending ||
          pending.signal.aborted ||
          pending.row.revision !== p.revision ||
          pending.row.sessionId !== command.sessionId
        )
          throw Error('stale interaction');
        if (p.cancel === true) {
          if (pending.secret) await cancelRequest(this.home, pending.secret.id);
          this.pending.delete(id);
          this.history.push({
            ...pending.row,
            status: 'recorded',
            decision: 'cancelled',
          });
          pending.resolve(
            pending.row.kind === 'approval' ? 'reject' : 'cancelled',
          );
          return {};
        }
        const answer = text(p.answer, 'answer', pending.secret ? 4096 : 16000);
        if (
          pending.row.kind === 'approval' &&
          !pending.row.choices?.includes(answer) &&
          !answer.startsWith('reject: ')
        )
          throw Error('invalid approval decision');
        if (pending.secret)
          await submitAnswer(this.home, pending.secret.id, answer);
        this.pending.delete(id);
        this.history.push({
          ...pending.row,
          status: 'recorded',
          decision: pending.secret ? 'submitted' : answer,
        });
        this.history = this.history.slice(-100);
        pending.resolve(pending.secret ? 'submitted' : answer);
        return {};
      }
      case 'compact':
        if (!this.options.model && !isReady(runtime.options.settings))
          throw Error('connect an endpoint before compacting');
        if (runtime.busy) throw Error('a turn is running');
        this.track(
          runtime.compact(text(p.hint ?? '', 'hint', 10000)),
          runtime,
          true,
        );
        return {};
      case 'export': {
        const format = p.format ?? 'jsonl';
        if (!['jsonl', 'html', 'md'].includes(String(format)))
          throw Error('choose jsonl, html or md');
        // A foreign view reads committed history without instantiating an executable
        // owner. Its export still requires complete tool call/result pairs.
        if (!this.viewedSessionId) runtime.exportSession();
        const row = this.store.get(this.selectedSessionId)!;
        const messages = this.viewedSessionId
          ? this.store.messages(row.id)
          : runtime.harness.messages;
        this.store.requireBalancedTools(messages);
        const meta = {
          thread_id: row.id,
          title: row.title,
          workspace: row.workspace,
          model: row.model,
        };
        return {
          content:
            format === 'jsonl'
              ? this.viewedSessionId
                ? toSessionBundle(this.store, row.id)
                : runtime.exportSession()
              : format === 'html'
                ? toHtml(messages, meta)
                : toMarkdown(messages, meta),
          name: `${row.id}.${format}`,
        };
      }
      case 'import': {
        const previous = runtime.session.id;
        await runtime.importSession(
          text(p.content, 'session export', 4_000_000),
        );
        await this.externalFiles?.revokeSession(previous);
        this.externalGrantOwners.delete(previous);
        this.runtimes.reindex(runtime, previous);
        this.workspaceSessions.set(
          runtime.options.workspace,
          runtime.session.id,
        );
        this.resetPlan(runtime);
        return { sessionId: runtime.session.id };
      }
      case 'stop-job': {
        const id = text(p.id, 'job', 200);
        const jobId = id.split(':').at(-1)!;
        const owner = [...this.runtimes.values()].find(
          (owner) =>
            owner.jobs.get(jobId)?.sessionId === command.sessionId &&
            `${command.sessionId}:${jobId}` === id,
        );
        if (!owner) throw Error('job not found in this session');
        this.stoppedJobs.add(id);
        this.publish();
        try {
          await owner.jobs.stop(jobId, 'user');
        } catch (error) {
          this.stoppedJobs.delete(id);
          throw error;
        }
        return {};
      }
      case 'revoke-approval': {
        const id = text(p.ruleId, 'rule', 200);
        const rules = runtime.policy.store.rules(runtime.session.id);
        const index = rules.findIndex(
          (rule) =>
            identity(
              JSON.stringify([
                runtime.session.id,
                rule.tool,
                rule.pattern,
                rule.at,
              ]),
            ) === id,
        );
        if (index < 0) throw Error('rule not found');
        runtime.policy.store.revoke(runtime.session.id, index);
        return {};
      }
      case 'open-workspace': {
        const workspace = realpathSync.native(text(p.path, 'workspace', 8000));
        if (!statSync(workspace).isDirectory())
          throw Error('workspace is not a folder');
        // Home state only. The session is created by begin-session, with the
        // first message, and not before. Choosing the folder in the native dialog
        // is what authorizes its root for later workspace access.
        this.bindWorkspace(workspace);
        this.opened.add(workspace);
        return { workspaceId: identity(workspace) };
      }
      case 'set-default-workspace': {
        // The path comes from the native dialog through the main process, exactly
        // like open-workspace: the renderer never names one.
        const workspace = realpathSync.native(text(p.path, 'workspace', 8000));
        if (!statSync(workspace).isDirectory())
          throw Error('the default workspace must be a folder');
        if (!this.acceptableDefaultFolder(workspace))
          throw Error(
            'the default workspace may not be the Circle data folder, a folder inside it or a folder that holds it',
          );
        saveSettingsChange(this.home, (settings) => {
          // Selecting the built-in scratch folder again resets the default.
          settings.workspace_folder = this.isScratch(workspace)
            ? ''
            : workspace;
        });
        this.defaultFolder = undefined;
        const owner = this.runtime(workspace);
        this.selectRuntime(owner);
        return {
          workspaceId: identity(workspace),
          sessionId: owner.session.id,
        };
      }
      case 'set-task-folder': {
        // The path comes from the native dialog, as the default workspace's does.
        const folder = realpathSync.native(text(p.path, 'workspace', 8000));
        if (!statSync(folder).isDirectory())
          throw Error('the task folder must be a folder');
        const built = this.tasksPath();
        if (folder !== built && !this.acceptableDefaultFolder(folder))
          throw Error(
            'the task folder may not be the Circle data folder, a folder inside it or a folder that holds it',
          );
        saveSettingsChange(this.home, (settings) => {
          // Choosing Circle's own tasks folder again resets the default.
          settings.task_folder = folder === built ? '' : folder;
        });
        return { taskFolder: this.tasksRootFor(loadSettings(this.home)) };
      }
      case 'load-skill': {
        const skill = runtime.skills.find((skill) => skill.name === p.name);
        if (!skill) throw Error('skill not found');
        await runtime.activateSkillHooks(skill.name);
        return {
          name: skill.name,
          content: loadSkillBody(skill.name, runtime.skills),
        };
      }
      case 'init':
        return this.execute({
          ...command,
          name: 'prompt',
          payload: { text: readPrompt('commands', 'initialize.md') },
        });
      case 'shell': {
        if (
          !isFolderTrusted(runtime.options.settings, runtime.options.workspace)
        )
          throw Error('trust this workspace first');
        const workspace = this.trustedWorkspace(runtime.options.workspace);
        const shellCommand = text(p.command, 'shell command', 32000);
        const quiet = p.quiet === true;
        return (await this.ledger()).run(
          {
            id: command.id,
            sessionId: runtime.session.id,
            service: 'shell',
            method: 'run',
            paramsHash: createHash('sha256')
              .update(
                JSON.stringify({
                  workspace,
                  grant: this.workspaceRoots.get(workspace),
                  command: shellCommand,
                  quiet,
                }),
              )
              .digest('hex'),
          },
          () => runtime.userShells.run(shellCommand, quiet),
        );
      }
      case 'custom-command': {
        if (
          !isFolderTrusted(runtime.options.settings, runtime.options.workspace)
        )
          throw Error('trust this workspace first');
        if (runtime.busy) throw Error('a turn is running');
        const name = text(p.name, 'command name', 100);
        const args = text(p.args ?? '', 'command args', 16000);
        const secret =
          typeof p.secret === 'string' && p.secret.length > 0
            ? p.secret
            : undefined;
        let found = this.extensionCommand(runtime, name);
        if (
          !found &&
          isFolderTrusted(runtime.options.settings, runtime.options.workspace)
        ) {
          await runtime.initialize();
          found = this.extensionCommand(runtime, name);
        }
        if (found) {
          const extension = found.command;
          // Hub sign-in and sign-out are status: the hub page shows them, and the window
          // says them in passing rather than in the conversation. What any other hub
          // command finds is the conversation's, as every extension's output is.
          const hubStatus =
            name === 'hub' &&
            /^(?:(?:login|logout)(?:\s|$)|$)/.test(args.trim());
          const status: string[] = [];
          await extension.handler(args, {
            workspace: found.owner.options.workspace,
            ...(secret ? { secret } : {}),
            toast: (message) => {
              const id = runtime.session.id;
              if (this.runtimes.lifecycle(id) !== 'open') return;
              const rows = this.notices.get(id) ?? [];
              rows.push({
                id: `extension-${randomUUID()}`,
                after: this.store.get(id)?.head ?? null,
                text: message,
                at: new Date().toISOString(),
              });
              this.notices.set(id, rows);
              this.publish();
            },
            append: (content) => {
              if (hubStatus) {
                status.push(content);
                return;
              }
              const runtimeNotice = githubStatusNotice(
                content,
                name === 'github' &&
                  found.owner.extensions.isTrustedBundledCommand(
                    extension,
                    'github',
                  ),
              );
              if (runtimeNotice) {
                runtime.store.append(runtime.session.id, [
                  {
                    id: randomUUID(),
                    role: 'assistant',
                    content,
                    runtimeNotice,
                  },
                ]);
              } else {
                // Extension append is presentation, just like its terminal
                // notice. Only sendUserMessage may enter the model transcript.
                const id = runtime.session.id;
                if (this.runtimes.lifecycle(id) !== 'open') return;
                const rows = this.notices.get(id) ?? [];
                rows.push({
                  id: `extension-${randomUUID()}`,
                  after: this.store.get(id)?.head ?? null,
                  text: content,
                  at: new Date().toISOString(),
                });
                this.notices.set(id, rows);
                this.publish();
              }
            },
            sendUserMessage: (prompt) => {
              this.track(runtime.harness.run(prompt), runtime);
            },
          });
          return status.length ? { notice: status.join('\n') } : {};
        }
        const custom = discoverCustomCommands(
          runtime.options.workspace,
          this.home,
          this.options.userHome,
        ).find((item) => item.name === name);
        if (!custom) throw Error('custom command not found');
        let prompt = substituteArguments(custom.template, args);
        for (const match of [...prompt.matchAll(/!`([^`]+)`/g)].reverse()) {
          const result = await runtime.userShells.run(match[1]!);
          if (result.exit_code !== 0)
            throw Error('command template shell did not complete successfully');
          prompt =
            prompt.slice(0, match.index) +
            result.output.trim() +
            prompt.slice(match.index! + match[0].length);
        }
        return this.execute({
          ...command,
          name: 'prompt',
          payload: { text: prompt, display: `/${name} ${args}`.trim() },
        });
      }
      case 'save-command': {
        if (runtime.busy)
          throw Error('finish the current turn before saving a command');
        const name = text(p.name, 'command name', 100);
        if (
          !/^[a-z][a-z0-9_-]{0,63}$/.test(name) ||
          BUILTIN_SLASH.some(
            (item) => item.name === name || item.aliases?.includes(name),
          ) ||
          runtime.extensions.commands().has(name)
        )
          throw Error('invalid or reserved command name');
        const scope = p.scope ?? 'user';
        if (!['project', 'user'].includes(String(scope)))
          throw Error('invalid command scope');
        if (
          scope === 'project' &&
          !isFolderTrusted(runtime.options.settings, runtime.options.workspace)
        )
          throw Error('trust this workspace first');
        const owner =
          scope === 'project' ? runtime.options.workspace : this.home;
        const folder =
          scope === 'project'
            ? join(owner, '.circle', 'commands')
            : join(owner, 'commands');
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const rel = relative(
          realpathSync.native(owner),
          realpathSync.native(folder),
        );
        if (rel.startsWith('..') || isAbsolute(rel))
          throw Error('command folder leaves its owner');
        const path = join(realpathSync.native(folder), name + '.md');
        if (existsSync(path) && realpathSync.native(path) !== path)
          throw Error('linked commands must be edited in their source folder');
        const template = text(p.template, 'template', 120_000);
        const description = text(p.description ?? '', 'description', 1000);
        writeFileSync(
          path,
          `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\nargument-hint: ${JSON.stringify(text(p.arguments ?? '', 'argument hint', 1000))}\n---\n\n${template}\n`,
          { mode: 0o600 },
        );
        return { name, path };
      }
      case 'create-skill': {
        if (runtime.busy)
          throw Error('finish the current turn before adding a skill');
        if (
          !isFolderTrusted(runtime.options.settings, runtime.options.workspace)
        )
          throw Error('trust this workspace first');
        const name = text(p.name, 'skill name', 64);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
          throw Error('invalid skill name');
        const description = text(p.description ?? '', 'description', 1024);
        const body = text(p.body ?? '', 'skill', 120_000);
        const folder = join(
          runtime.options.workspace,
          '.circle',
          'skills',
          name,
        );
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const skillPath = join(folder, 'SKILL.md');
        if (existsSync(skillPath)) throw Error('skill already exists');
        writeFileSync(
          skillPath,
          `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`,
          { mode: 0o600 },
        );
        await runtime.reloadIntegrations();
        return { name, path: skillPath };
      }
      case 'preview-file-undo':
      case 'restore-turn-files': {
        if (runtime.busy || this.metadata.archivedAt(runtime.session.id))
          throw Error(
            'finish the running turn and restore the session before undoing files',
          );
        const journal = this.fileRewinds.get(runtime);
        if (!journal) throw Error('no text-tool file history for this runtime');
        const signal = new AbortController().signal;
        if (command.name === 'preview-file-undo')
          return journal.preview(text(p.turnId, 'turn'), signal);
        if (runtime.harness.planMode)
          throw Error('leave plan mode before restoring files');
        const receipt = await journal.restore(
          text(p.previewId, 'preview'),
          signal,
        );
        return { restored: true, ...receipt };
      }
      case 'write-file': {
        if (
          !isFolderTrusted(runtime.options.settings, runtime.options.workspace)
        )
          throw Error('trust this workspace first');
        const expected = p.expectedRevision;
        if (expected !== null && typeof expected !== 'string')
          throw Error(
            'expected revision is required; read the file, or use null to create it',
          );
        const path = text(p.path, 'path', 8000);
        const target = runtime.sandbox.resolvePath(path);
        const documents = this.services(runtime.options.workspace).documents;
        const file = relative(documents.root, canonicalPath(target))
          .split(sep)
          .join('/');
        const document = await documents.save(
          file,
          text(p.content, 'file', 4_000_000),
          expected,
        );
        return { output: `saved ${file}`, document };
      }
      case 'share':
      case 'unshare': {
        const folder = join(this.home, 'shares');
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const path = join(folder, `${runtime.session.id}.md`);
        if (command.name === 'unshare') {
          if (existsSync(path)) unlinkSync(path);
          return { path };
        }
        const reply = (await this.execute({
          ...command,
          name: 'export',
          payload: { format: 'md' },
        })) as { content: string };
        writeFileSync(path, reply.content, { mode: 0o600 });
        return { path };
      }
      case 'save-secret': {
        const name = text(p.name, 'secret name', 64);
        const previous =
          p.previous === undefined
            ? undefined
            : text(p.previous, 'secret name', 64);
        // A plain variable made secret leaves settings in the same step, so the model is
        // never told its value again
        const replaces =
          p.replaces === undefined
            ? undefined
            : text(p.replaces, 'variable name', 64);
        const settings = loadSettings(this.home);
        if (replaces !== undefined && !(replaces in settings.variables))
          throw Error(`no variable named ${replaces}`);
        const variables = Object.fromEntries(
          Object.entries(settings.variables).filter(
            ([key]) => key !== replaces,
          ),
        );
        if (name in variables) throw Error(`${name} is already a variable`);
        // Renamed without a new value: the saved value moves to the new name
        const value =
          p.value === undefined || p.value === ''
            ? previous && loadSecrets(this.home)[previous]
            : text(p.value, 'value', 4096);
        if (!value) throw Error('enter the value');
        saveSecret(this.home, name, value);
        if (previous && previous !== name) removeSecret(this.home, previous);
        if (replaces !== undefined) {
          const saved = saveSettingsChange(this.home, (current) => {
            delete current.variables[replaces];
          });
          for (const owner of this.runtimes.values())
            owner.options.settings.variables = { ...saved.variables };
        }
        this.secretsChanged();
        return {};
      }
      case 'remove-secret':
        if (!removeSecret(this.home, text(p.name, 'secret name', 64)))
          throw Error('no such secret');
        this.secretsChanged();
        return {};
      case 'discover-models': {
        const settings = loadSettings(this.home);
        if (!isReady(settings)) throw Error('connect an endpoint first');
        const found = await resolveEndpoint(
          settings.auth.base_url,
          loadCredentials(this.home)[settings.auth.api_key_ref] ?? '',
          { protocol: settings.auth.protocol },
        );
        // An endpoint that does not list its models (an Anthropic-style path without
        // GET /v1/models) is not an error: its model ids are typed instead.
        if (found.status === 'failed')
          return {
            status: 'failed',
            models: [],
            detail: found.detail || 'model discovery failed',
          };
        this.discoveredModels = found.models;
        return {
          status: found.status,
          models: found.models,
          detail: found.detail,
        };
      }
      case 'check-update':
        return {
          available: await availableUpdate(this.home),
          automaticInstall: false,
        };
      case 'dismiss-whats-new':
        dismissWhatsNew(this.home);
        this.whatsNew = undefined;
        return {};
      case 'launch-options':
        throw Error(
          'desktop launch options must be supplied when starting the application; use session controls for model, effort and plan mode',
        );
      case 'close':
        await this.close();
        return {};
    }
  }
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeAll();
    return this.closePromise;
  }
  private async closeAll(): Promise<void> {
    this.persistLocation();
    this.closing = true;
    await this.externalFiles?.close();
    this.externalGrantOwners.clear();
    for (const pending of this.pending.values())
      pending.reject(new Error('runtime closed'));
    this.pending.clear();
    this.terminalTabs.close();
    await Promise.all(
      [...this.taskServices.values()].map((service) => service.close()),
    );
    await this.runtimes.close();
    await Promise.allSettled(this.tasks);
    await Promise.allSettled(this.workspaceEventPending);
    await Promise.all(
      [...this.workspaceServices.values()].map((service) => service.dispose()),
    );
    await this.githubProfile?.dispose();
    if (this.operationLedger) await (await this.operationLedger).close();
    this.store.close();
  }
}
