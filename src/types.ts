export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  raw_args?: string;
  argument_error?: string;
}
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens?: number;
  cache_write_1h_tokens?: number;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  model?: string;
  request_model?: string;
  content: string;
  attachments?: MediaAttachment[];
  shell?: { command: string; output: string; exit_code: number };
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  status?: 'success' | 'error';
  display?: string;
  /** Long pastes that `display` shows folded as `[Pasted text #N]`, by number. */
  pastes?: Record<string, string>;
  provider_content?: unknown[];
  usage?: Usage;
  cost?: import('./pricing.js').PriceReceipt;
  /** Seconds the model spent thinking before the answer text, kept across a restart. */
  thinking_seconds?: number;
  /** This assistant message is the partial reply saved when the turn was stopped. */
  interrupted?: boolean;
  internal?: string;
  truncated?: boolean;
  recoverable?: boolean;
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
