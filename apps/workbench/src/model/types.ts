import type { ModelCompletionFailureCode } from '../../../../src/model_completion';
import type { WhatsNewNotice } from '../../../../src/whats_new';

export type Theme = 'auto' | 'light' | 'dark';
export type TextSize = 'small' | 'default' | 'large' | 'larger';
export type Effort =
  'default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PanelId = string;
export type SessionMode = 'manual' | 'accept-edits' | 'plan' | 'auto';
/** A diff as the core draws it: a summary row, then rows; `@@` rows start a hunk. */
export interface DiffRow {
  text: string;
  tone?: 'added' | 'removed';
}
export interface DiffView {
  summary: string;
  rows: DiffRow[];
}
export type PageId =
  | 'sessions'
  | 'models'
  | 'skills'
  | 'commands'
  | 'mcp'
  | 'extensions'
  | 'tools'
  | 'approvals'
  | 'settings'
  | 'help';
export type DialogId =
  | 'rename'
  | 'delete-session'
  | 'tree'
  | 'fork'
  | 'session'
  | 'export'
  | 'editor'
  | 'connect'
  | 'trust'
  | 'preview'
  | 'hotkeys'
  | 'compact'
  | 'exit'
  | 'secret'
  | 'job-stop'
  | 'external-files';
export interface Attachment {
  id: string;
  name: string;
  kind: 'file' | 'image' | 'document' | 'skill' | 'paste';
  content: string;
  mime?: string;
  size?: number;
  truncated?: boolean;
}
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: string;
  status:
    | 'running'
    | 'success'
    | 'error'
    | 'waiting'
    | 'unknown'
    | 'cancelled'
    | 'rejected';
  attachments?: Attachment[];
  elapsed?: string;
  filePath?: string;
  before?: string;
  after?: string;
  agentId?: string;
  /** Main-process ledger links to actual child session identities. */
  agentIds?: string[];
  diff?: DiffView;
}
export interface Message {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  at: string;
  thinking?: string;
  /** Seconds the model spent thinking, kept with the reply. */
  thinkingSeconds?: number;
  tool?: ToolCall;
  /** Host-projected human execution, distinct from a model tool call. */
  shell?: {
    id?: string;
    sourceSessionId: string;
    command: string;
    output: string;
    status: 'running' | 'done' | 'error' | 'stopped' | 'background';
    exitCode?: number;
    quiet?: boolean;
    interactive: boolean;
  };
  label?: string;
  attachments?: Attachment[];
  runtimeNotice?: import('../../../../src/runtime_notice').GitHubRuntimeNotice;
  /** A runtime notice, separate from user/model text, for interface translation. */
  planCompleted?: number;
  /** A deterministic hook notice. The reason is the hook's own words. */
  hookNotice?: import('../../../../src/hooks.js').HookNotice;
  /** A core completion diagnostic; arbitrary model/provider text stays untranslated. */
  completionFailure?: ModelCompletionFailureCode;
  /** The user stopped this reply, or a crash saved no reply. */
  interrupted?: boolean;
  usage?: {
    input: number;
    output: number;
    cost: number | null;
    elapsed: string;
    /** A stopped turn's price is an estimate. The dollar figure then ends with `~`. */
    estimated?: boolean;
  };
}
export interface Todo {
  id: string;
  text: string;
  status: 'pending' | 'running' | 'completed';
}
export interface Session {
  /** Controlled text-tool receipts available in the current native runtime only. */
  fileUndoTurns?: string[];
  id: string;
  /** Desktop-only organization; the core transcript and project files stay intact. */
  archivedAt?: string;
  lifecycle?: 'open' | 'deleting';
  /** Another process owns execution of this conversation. */
  occupied?: boolean;
  /** The last renderer action failure, kept with its source session for this window. */
  actionError?: string;
  /** Renderer-only state; never changes the core conversation or execution. */
  presentation?: {
    scroll?: {
      top: number;
      follow: boolean;
      anchor?: { messageId: string; offset: number };
    };
    planCollapsed?: boolean;
    disclosures?: Record<string, { open: boolean; defaultOpen: boolean }>;
    toolTabs?: Record<string, 'input' | 'output'>;
  };
  title: string;
  workspaceId: string;
  model: string;
  effort: Effort;
  draft: string;
  messages: Message[];
  leafId: string | null;
  branchIds?: string[];
  hiddenIds: string[];
  undoStack: string[][];
  attachments: Attachment[];
  queue: { id: string; text: string; kind: 'steering' | 'follow-up' }[];
  queueVersion?: number;
  state: 'idle' | 'waiting' | 'paused';
  readOnly: boolean;
  auto: boolean;
  mode?: SessionMode;
  /** The footer, as the terminal's: whole-session usage and the last answer's context. */
  meters?: {
    input: number;
    output: number;
    cacheRead: number;
    /** `N/A` when cache was not reported, otherwise a percent such as `63.7%`. */
    cache?: string;
    /** A turn is in flight and the endpoint has not reported input yet. */
    inputUnknown?: boolean;
    cost: string;
    contextInput: number | null;
    contextWindow: number | null;
  };
  /** The running turn: its busy word, start, tokens written, and a retry in progress. */
  turn?: {
    verb: string;
    startedAt: number;
    waited: number;
    tokens: number;
    retry?: string;
  };
  /** Files this session changed while the app ran, each against its first version. */
  changes?: {
    path: string;
    kind: 'added' | 'modified' | 'deleted';
    diff: DiffView;
    at: string;
  }[];
  showThinking: boolean;
  expandTools: boolean;
  todos: Todo[];
  pinned: boolean;
  shared: boolean;
  updatedAt: string;
}
export interface Workspace {
  id: string;
  name: string;
  path: string;
  branch: string;
  trusted: boolean;
  origin?: 'native' | 'preview';
  /**
   * `project` is a folder the person can pick, including the default circle
   * workspace. `scratch` is work that is not in any project: a task's own folder
   * under the task root, or the shared unscoped folder before it.
   */
  kind?: 'project' | 'scratch';
  /** One task's own folder under the task folder, grouped under no project. */
  task?: boolean;
  instructions: { name: string; content: string; path?: string }[];
}
export interface WorkspaceFile {
  id: string;
  workspaceId: string;
  path: string;
  content: string;
  original?: string;
  draft?: string;
  status?: 'modified' | 'added';
  language: string;
  nativeGrant?: { workspaceId: string; fileId: string };
  truncated?: boolean;
  source?: string;
}
export interface AgentRecord {
  id: string;
  sessionId: string;
  name: string;
  description: string;
  activity?: string;
  status: 'running' | 'completed' | 'waiting' | 'unknown';
  model: string;
  tokens: number;
  messages: Message[];
  /** Resource access remains owned by this actual child session, not its parent. */
  workspaceId?: string;
  resourceSessionId?: string;
  readOnly?: boolean;
  task?: {
    role?: 'worker' | 'reviewer';
    id: string;
    attempt: number;
    state:
      | 'queued'
      | 'preparing'
      | 'running'
      | 'waiting'
      | 'cancelling'
      | 'succeeded'
      | 'failed'
      | 'blocked'
      | 'cancelled'
      | 'interrupted'
      | 'needs_review';
    access: 'write' | 'readonly';
    baseline: string;
    /** The actual runtime execution, distinct from overall acceptance state. */
    runtimeState?: NonNullable<AgentRecord['task']>['state'];
    /** History is visible, but an old in-flight process has not been reconciled. */
    recovery?: 'needs_reconciliation';
  };
}
export interface Job {
  id: string;
  sessionId: string;
  kind: 'command' | 'agent' | 'watch';
  title: string;
  state:
    | 'running'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'stopping'
    | 'interrupted';
  elapsed: string;
  output: string;
  outputPath: string;
  stopRequested: boolean;
  agentId?: string;
}
export interface Interaction {
  callId?: string;
  input?: Record<string, unknown>;
  origin?: { jobId?: string; name?: string; agent?: string };
  id: string;
  sessionId: string;
  kind: 'approval' | 'question' | 'secret' | 'plan-exit';
  title: string;
  tool?: string;
  target?: string;
  command?: string;
  before?: string;
  after?: string;
  diff?: DiffView;
  /** The words an 'allow command prefix' answer would allow, for a command. */
  prefix?: string;
  /** Why the core asks, in its words. */
  reason?: string;
  /** A hook asked for this approval. The reason is the hook's own words. */
  hookReason?: string;
  choices?: string[];
  multiple?: boolean;
  status: 'pending' | 'recorded';
  decision?: string;
  revision: number;
}
export interface ApprovalRule {
  id: string;
  sessionId: string;
  description: string;
  kind: 'command' | 'prefix' | 'tool';
}
export interface Model {
  id: string;
  provider: string;
  contextWindow: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  vision: boolean;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  path: string;
  /** bundled: ships with Circle; a project or user skill of the same name replaces it. */
  scope: 'project' | 'user' | 'bundled';
  content: string;
}
export interface PromptCommand {
  name: string;
  description: string;
  arguments: string;
  scope: 'project' | 'user' | 'extension';
  template: string;
}
export interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable_http' | 'websocket';
  command: string;
  args: string;
  url: string;
  enabled: boolean;
  status:
    'sample' | 'not connected' | 'connected' | 'error' | 'reload required';
  tools: { name: string; description: string; schema: unknown }[];
  error?: string;
}
export interface RuntimeExtension {
  id: string;
  name: string;
  version: string;
  scope: 'project' | 'user' | 'bundled';
  enabled: boolean;
  /** The line it set with api.setStatus, shown above the sidebar footer. */
  status?: { text: string; lamp: 'running' | 'ok' | 'error' | 'wait' | 'none' };
  /** What it published with api.setView, for a UI plugin paired with it. */
  view?: unknown;
  tools: string[];
  commands: string[];
  /** Slash commands named in extension.json, including while the extension is off. */
  declaredCommands?: string[];
  events: string[];
  error?: string;
}
export interface PendingRequest {
  id: string;
  kind: string;
  sessionId: string;
  payload: Record<string, unknown>;
  at: string;
  status: 'not sent';
}
export interface Settings {
  theme: Theme;
  hideThinking: boolean;
  defaultModel: string;
  defaultEffort: Effort;
  enabledModels: string[];
  doubleEscape: 'tree' | 'fork' | 'none';
  endpoint: string;
  protocol: 'openai' | 'anthropic';
  credentialFiles: string[];
  /** Values the model may use by name, as `settings.json` keeps them. */
  variables: Record<string, string>;
  /** Names of the saved secrets, used as %NAME%: never a value. */
  secrets: string[];
  updateCheck: boolean;
  /**
   * The folder new sessions start in when no other folder was opened: the
   * configured default workspace, or the built-in scratch folder. It only
   * changes through the native folder dialog, never through save-settings.
   */
  workspaceFolder: string;
  /** Where a task with no project gets a folder of its own. */
  taskFolder?: string;
  /**
   * The built-in scratch folder's path while a different default workspace is
   * configured and the scratch folder still holds files: changing the default
   * does not move anything, so the settings page names the folder to delete.
   */
  oldWorkspaceFolder?: string;
  textSize: TextSize;
  keybindings: Record<string, string | string[]>;
  /** Hooks the connected runtime would run. Empty when none are configured. */
  hooks?: HookSetting[];
  /** A project hooks file is present and the folder is not trusted. */
  projectHooksIgnored?: boolean;
}
export interface HookSetting {
  source: 'user' | 'project' | 'skill';
  event: string;
  name: string;
  command: string;
  tools: string;
  paths: string;
  /** The skill that ships this hook. It runs only after that skill is loaded. */
  skill?: string;
  /** False for a skill hook this session has not loaded. Omitted means running. */
  active?: boolean;
}
export interface WorkbenchSnapshot {
  tools?: {
    name: string;
    description: string;
    kind: string;
    detail: string;
    schema: unknown;
  }[];
  runtime?: {
    network?: import('../../../../src/net').NetworkStatus;
    connected: boolean;
    configured: boolean;
    /** Whether a key is saved; the key itself never reaches the window. */
    hasKey?: boolean;
    error?: string;
    /** Set by the desktop application after the runtime process ended unexpectedly. */
    stopped?: {
      reason: 'out-of-memory' | 'crashed' | 'exited';
      /** The exit code as reported, such as `4294930435 (0xFFFF7003)`. */
      code: string;
      /** An automatic or requested restart is under way. */
      restarting: boolean;
      at: string;
    };
    processId?: number;
    observedAt?: string;
    coreVersion?: string;
  };
  version: 1;
  activeSessionId: string;
  previousSessionId: string | null;
  workspaces: Workspace[];
  sessions: Session[];
  files: WorkspaceFile[];
  fileListings?: Record<
    string,
    { loaded: number; complete: boolean; truncated: boolean; error?: string }
  >;
  agents: AgentRecord[];
  jobs: Job[];
  interactions: Interaction[];
  approvalRules: ApprovalRule[];
  models: Model[];
  skills: Skill[];
  commands: PromptCommand[];
  mcp: McpServer[];
  extensions: RuntimeExtension[];
  requests: PendingRequest[];
  settings: Settings;
  uiPlugins: string[];
  /** The last link an extension asked to open; the window opens each id once. */
  openUrl?: { id: string; url: string; sessionId: string };
  /**
   * The one-time upgrade notice, in both languages. Present only until it is
   * dismissed, and only drawn on the new-session home page.
   */
  whatsNew?: WhatsNewNotice;
}
export interface CommandResult {
  openSession?: boolean;
  /** Ctrl+N / new session: the empty conversation should take the keyboard. */
  focusComposer?: boolean;
  notice?: string;
  page?: PageId;
  dialog?: DialogId;
  panel?: PanelId;
  selection?: string;
  effect?: 'copy' | 'import' | 'download';
}
/** Local fields only: this API cannot edit history, permissions or execution. */
export type SessionViewPatch = Partial<
  Pick<
    Session,
    | 'draft'
    | 'attachments'
    | 'hiddenIds'
    | 'undoStack'
    | 'showThinking'
    | 'expandTools'
    | 'pinned'
    | 'shared'
    | 'presentation'
  >
>;
/** The first message from the home composer. No session exists until this runs. */
export interface BeginConversation {
  /** A known project. Omit it, or pass null, to work without a project. */
  workspaceId?: string | null;
  text: string;
  /** Choices from the home composer, applied to the session this message starts. */
  model?: string;
  effort?: Effort;
  mode?: SessionMode;
  /** Files chosen on the home composer, folded the same way as a session send. */
  attachments?: Attachment[];
}
export type BeginResult =
  { sessionId: string; commandResult?: CommandResult } | { dialog: 'trust' };
export interface RuntimePort {
  readonly mode: 'preview' | 'live';
  /** Changes when a reset replaces renderer session identities, even if IDs recur. */
  readonly presentationEpoch?: number;
  getSnapshot: () => WorkbenchSnapshot;
  subscribe: (listener: () => void) => () => void;
  change: (update: (draft: WorkbenchSnapshot) => void) => void;
  updateSessionView: (sessionId: string, patch: SessionViewPatch) => boolean;
  send: (
    kind?: 'steering' | 'follow-up',
  ) => CommandResult | Promise<CommandResult>;
  command: (
    name: string,
    args?: string,
  ) => CommandResult | Promise<CommandResult>;
  request: (
    kind: string,
    payload?: Record<string, unknown>,
    sessionId?: string,
  ) => string | Promise<unknown>;
  /**
   * Load a skill into the open conversation and send a message that asks for it, as one
   * step; the person's own draft and attachments are left alone. `display` is what the
   * transcript shows as the person's message.
   */
  runSkill?: (input: {
    name: string;
    text: string;
    display: string;
  }) => Promise<void>;
  /** Drop a session error the page is already showing, so it is not also a toast. */
  dismissActionError?: (sessionId?: string) => void;
  /** Start the desktop runtime again after it stopped. */
  restartRuntime?: () => Promise<void>;
  newSession: (workspaceId?: string) => string | Promise<string>;
  beginConversation: (
    input: BeginConversation,
  ) => BeginResult | Promise<BeginResult>;
  selectSession: (id: string) => void | Promise<void>;
  deleteSession: (id: string, confirmed?: boolean) => void | Promise<void>;
  branch: (messageId: string, kind: 'tree' | 'fork') => void | Promise<void>;
  answer: (
    id: string,
    revision: number,
    answer: string,
  ) => void | Promise<void>;
  reset: () => void;
}
