export type Theme = 'auto' | 'light' | 'dark';
export type Effort =
  'default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PanelId = string;
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
  updateCheck: boolean;
  uiFontSize: number;
  codeFontSize: number;
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
    connected: boolean;
    configured: boolean;
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
export interface RuntimePort {
  readonly mode: 'preview' | 'live';
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
  ) => string | Promise<unknown>;
  newSession: (workspaceId?: string) => string | Promise<string>;
  selectSession: (id: string) => void | Promise<void>;
  deleteSession: (id: string) => void | Promise<void>;
  branch: (messageId: string, kind: 'tree' | 'fork') => void | Promise<void>;
  answer: (
    id: string,
    revision: number,
    answer: string,
  ) => void | Promise<void>;
  reset: () => void;
}
