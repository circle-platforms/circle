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
  | 'job-stop';
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
  status: 'running' | 'success' | 'error' | 'waiting' | 'unknown';
  elapsed?: string;
  filePath?: string;
  before?: string;
  after?: string;
  agentId?: string;
  diff?: DiffView;
}
export interface Message {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  at: string;
  thinking?: string;
  tool?: ToolCall;
  label?: string;
  attachments?: Attachment[];
  /** A runtime notice, separate from user/model text, for interface translation. */
  planCompleted?: number;
  usage?: {
    input: number;
    output: number;
    cost: number | null;
    elapsed: string;
  };
}
export interface Todo {
  id: string;
  text: string;
  status: 'pending' | 'running' | 'completed';
}
export interface Session {
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
    scroll?: { top: number; follow: boolean };
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
  state: 'idle' | 'waiting' | 'paused';
  readOnly: boolean;
  auto: boolean;
  mode?: SessionMode;
  /** The footer, as the terminal's: whole-session usage and the last answer's context. */
  meters?: {
    input: number;
    output: number;
    cacheRead: number;
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
   * workspace. `scratch` is a conversation that is not in any project.
   */
  kind?: 'project' | 'scratch';
  instructions: { name: string; content: string }[];
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
  status: 'running' | 'completed' | 'waiting';
  model: string;
  tokens: number;
  messages: Message[];
}
export interface Job {
  id: string;
  sessionId: string;
  kind: 'command' | 'agent' | 'watch';
  title: string;
  state: 'running' | 'waiting' | 'completed' | 'failed';
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
  scope: 'project' | 'user';
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
  /**
   * The built-in scratch folder's path while a different default workspace is
   * configured and the scratch folder still holds files: changing the default
   * does not move anything, so the settings page names the folder to delete.
   */
  oldWorkspaceFolder?: string;
  textSize: TextSize;
  keybindings: Record<string, string | string[]>;
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
}
export interface CommandResult {
  openSession?: boolean;
  notice?: string;
  page?: PageId;
  dialog?: DialogId;
  panel?: PanelId;
  selection?: string;
  effect?: 'copy' | 'import' | 'download';
}
/** The first message from the home composer. No session exists until this runs. */
export interface BeginConversation {
  /** A known project. Omit it, or pass null, to work without a project. */
  workspaceId?: string | null;
  text: string;
  /** Choices from the home composer, applied to the session this message starts. */
  model?: string;
  effort?: Effort;
  mode?: SessionMode;
}
export type BeginResult = { sessionId: string } | { dialog: 'trust' };
export interface RuntimePort {
  readonly mode: 'preview' | 'live';
  /** Changes when a reset replaces renderer session identities, even if IDs recur. */
  readonly presentationEpoch?: number;
  getSnapshot: () => WorkbenchSnapshot;
  subscribe: (listener: () => void) => () => void;
  change: (update: (draft: WorkbenchSnapshot) => void) => void;
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
