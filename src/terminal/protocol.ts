// What the runtime asks of a conversation's device terminals and what it gets back. In the
// desktop application the sessions live in the main process: the runtime posts
// `{type:'terminal', request}` and may post `{type:'terminal-cancel', id}`, and the main
// process answers `{type:'terminal-reply', reply}`. In the terminal the same
// TerminalSessions object is driven in the same process.
export const terminalActions = [
  'sessions',
  'connect',
  'send',
  'read',
  'wait',
  'press',
  'disconnect',
  'handoff',
] as const;
export type TerminalAction = (typeof terminalActions)[number];
export interface TerminalRequest {
  id: string;
  sessionId: string;
  action: TerminalAction;
  args: Record<string, unknown>;
}
export interface TerminalResult {
  text: string;
  /**
   * The device the result's session sits on, as `host:port`: the next action's approval
   * goes by it, and the tools remember it per conversation like the browser's site.
   */
  host?: string;
  /** The terminal the result is about, such as `t1`, so the tools can key the host by it. */
  session?: string;
  /**
   * The action needs the person first: the device's host key is not trusted yet. The
   * runtime asks, then repeats the request with `args.approval`.
   */
  approval?: TerminalApproval;
}
export type TerminalApproval = TerminalHostKeyApproval;
/**
 * A host key the person must allow before the first login: `once` for this conversation,
 * `always` for good, which only a host on this network can get.
 */
export interface TerminalHostKeyApproval {
  kind: 'hostkey';
  token: string;
  /** The device, as `host:port`. */
  host: string;
  keyType: string;
  fingerprint: string;
  privateHost: boolean;
}
export interface TerminalReply {
  id: string;
  ok: boolean;
  error?: string;
  data?: TerminalResult;
}
// The keys `press` knows, as the bytes a terminal console expects with no special modes
// on: control bytes, carriage return, and the arrow keys' normal-mode sequences.
export const TERMINAL_KEYS: Record<string, string> = {
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
  Delete: '\x1b[3~',
  Ctrl_C: '\x03',
  Ctrl_D: '\x04',
  Ctrl_Z: '\x1a',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
};
const MAX_ARGS = 200_000;
export function validateTerminalRequest(value: unknown): TerminalRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid terminal request');
  const request = value as TerminalRequest;
  if (
    typeof request.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(request.id) ||
    typeof request.sessionId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(request.sessionId) ||
    !terminalActions.includes(request.action) ||
    !request.args ||
    typeof request.args !== 'object' ||
    Array.isArray(request.args) ||
    JSON.stringify(request.args).length > MAX_ARGS
  )
    throw Error('invalid terminal request');
  return request;
}
