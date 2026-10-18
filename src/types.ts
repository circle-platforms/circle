export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  raw_args?: string;
  argument_error?: string;
  /** Set when a hook asked for a decision. Not part of what the model sent. */
  hook_reason?: string;
}
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens?: number;
  cache_write_1h_tokens?: number;
  /**
   * Input tokens included above that a stopped turn estimated. Not stored on a
   * message: `stats` fills it when it adds an interrupted reply.
   */
  estimated_input_tokens?: number;
  /** Output tokens included above that a stopped turn estimated. */
  estimated_output_tokens?: number;
  /** Input tokens whose endpoint omitted cache fields. Filled by `stats`. */
  cache_unreported_input?: number;
}
/** A model request made inside a tool, retained with that tool's result. */
export interface ToolModelCall {
  model: string;
  usage: Usage;
  cost?: import('./pricing.js').PriceReceipt;
  search_requests?: number;
}
/** Provider completion evidence. Absent on older history and custom models. */
export interface ModelCompletion {
  reason:
    | 'stop'
    | 'tool_calls'
    | 'length'
    | 'filter'
    | 'pause'
    | 'missing'
    | 'unknown';
  provider_reason?: string;
  output_limit?: number;
  client_stop?: 'repetition';
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  model?: string;
  request_model?: string;
  content: string;
  /** A desktop host-authored notice; content itself remains unchanged in history. */
  runtimeNotice?: import('./runtime_notice.js').GitHubRuntimeNotice;
  /** A deterministic hook's transcript line. The model reads `content`, not this. */
  hook?: import('./hooks.js').HookNotice;
  attachments?: MediaAttachment[];
  shell?: { id?: string; command: string; output: string; exit_code: number };
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  status?: 'success' | 'error';
  display?: string;
  /** Long pastes that `display` shows folded as `[Pasted text #N]`, by number. */
  pastes?: Record<string, string>;
  provider_content?: unknown[];
  /** Opaque API/key/model identity for replaying signed thinking; never a credential. */
  thinking_scope?: string;
  usage?: Usage;
  cost?: import('./pricing.js').PriceReceipt;
  /** Seconds the model spent thinking before the answer text, kept across a restart. */
  thinking_seconds?: number;
  /** This assistant message is the partial reply saved when the turn was stopped. */
  interrupted?: boolean;
  /**
   * False when this call's endpoint omitted cache fields. A reported zero stays
   * `cache 0.0%`; a missing field is `cache N/A`, the same as a stop.
   */
  cache_reported?: boolean;
  model_calls?: ToolModelCall[];
  internal?: string;
  truncated?: boolean;
  completion?: ModelCompletion;
  recoverable?: boolean;
  /**
   * The record a message imported from the Python releases was read from. Sessions imported
   * by earlier versions keep it in circle.sqlite; nothing reads it, and summary requests
   * leave it out.
   */
  /** Host-recorded bounded command facts; never a claim of arbitrary tree cleanup. */
  commandExecutions?: import('./command_process.js').CommandExecutionReceipt[];
  legacy_data?: { type: string; data: Record<string, unknown> };
}
export type Effect = 'read' | 'write' | 'execute' | 'unknown';
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: Effect;
  approval?: boolean;
  /** False keeps the tool from subagents: it belongs to the conversation the user sees. */
  subagents?: boolean;
  /**
   * False: %NAME% in its arguments stays as written. File writers set it, so what they put on
   * disk keeps the reference and never a secret's value. `plain`: plain variables' values go
   * in, secrets stay %NAME%, for a tool whose arguments become a model's input or the
   * conversation's (a subagent's task, a question, the todo list).
   */
  variables?: boolean | 'plain';
  /**
   * What the tool knows of a call that the model did not say, such as the site a browser
   * action acts on: added to the call's arguments before the approval, so the rules and
   * the card go by it, and checked again by the tool when it runs.
   */
  approvalFacts?: (
    args: Record<string, unknown>,
    sessionId: string,
  ) => Record<string, unknown> | undefined;
  /** Snapshot authorized inputs before waiting for approval; never perform writes here. */
  prepare?: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<Tool['run']>;
  run(args: Record<string, unknown>, context: ToolContext): Promise<string>;
}
export interface ToolContext {
  signal: AbortSignal;
  sessionId: string;
  /** The call being run: a request the tool raises can be shown under it. */
  callId?: string;
  /** The secrets whose values went into this call's arguments, by name. */
  secretNames?: string[];
  /** The arguments as the model wrote them, with %NAME% where a variable went. */
  rawArgs?: Record<string, unknown>;
  emitAttachments?: (attachments: MediaAttachment[]) => void;
  /** Whether the model in use reads images: false when it is known not to. */
  imageInput?: boolean;
  /** Bound to this harness's model and connection, including child harnesses. */
  webSearch?: (query: string, numResults: number) => Promise<string>;
  recordModelCall?: (call: ToolModelCall) => void;
}
export interface MediaAttachment {
  kind: 'image' | 'document';
  mime_type:
    'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf';
  filename: string;
  data: string;
  sha256: string;
}
export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: Tool[];
  signal: AbortSignal;
  token: (text: string, thinking?: boolean) => void;
  progress?: (
    kind: 'connected' | 'keepalive' | 'text' | 'thinking' | 'tool' | 'usage',
  ) => void;
  notice?: (event: ModelNotice) => void;
  /** Wait this many times the configured request timeout for the answer to start. */
  timeoutScale?: number;
  /**
   * Thinking depth for this request only. A side request (a session title) uses it so the
   * turn's depth stays put. `''` asks for no thinking on this request.
   */
  effort?: string;
  /** Output cap for this request only. A session title asks for a short reply. */
  maxTokens?: number;
}
export interface ModelNotice {
  event: string;
  [key: string]: unknown;
}
export interface ModelResponse {
  message: Message;
  usage: Usage;
}
export interface ChatModel {
  model: string;
  contextWindow?: number;
  outputBudget?: number;
  modelFacts?: import('./model_catalog.js').ModelFacts;
  /** Whether the model reads images: false when it is known not to, undefined when unknown. */
  imageInput?: boolean;
  /**
   * True when `complete` may be called beside the turn (a session title) without consuming
   * the reply the turn is waiting for. Scripted models leave this unset.
   */
  sideRequests?: boolean;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
export const emptyUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
});
export function addUsage(target: Usage, source: Usage): void {
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'cache_write_1h_tokens',
  ] as const) {
    if (source[key] !== undefined)
      target[key] = (target[key] ?? 0) + source[key]!;
  }
}
