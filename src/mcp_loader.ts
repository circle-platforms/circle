import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CLIENT_CAPABILITIES_META_KEY,
  Client,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  SseError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type ConnectOptions,
  type ElicitResult,
  type FetchLike,
  type Implementation,
  type JSONRPCResponse,
  type JsonSchemaType,
  type McpSubscription,
  type PriorDiscovery,
  type RequestOptions,
  type Tool as ServerTool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import {
  CallToolResultSchema,
  JSONObjectSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/core';
import { QuietJsonSchemaValidator } from './schema_formats.js';
import { WebSocketClientTransport } from './mcp_websocket.js';
import {
  negotiationSetting,
  programKey,
  rememberedEra,
  rememberEra,
  type Era,
} from './mcp_protocol.js';
import type {
  Tool,
  ToolContext,
  MediaAttachment,
  PreparedRun,
  Effect,
} from './types.js';
import { attachmentFromBase64 } from './media.js';
import { isRecord } from './settings.js';
import { Sandbox, secretLookingName, shellEnvironment } from './sandbox.js';
import { readFileBytes } from './file_access.js';
import { abortable } from './watch.js';
import {
  elicitationFields,
  elicitationOutcome,
  elicitationQuestions,
} from './mcp_elicitation.js';
import {
  McpAuthProvider,
  redirectPort,
  startRedirect,
  keptFor,
  directMcpGrant,
  McpLoginRequired,
  oauthMcpGrant,
  currentDirectMcpGrant,
} from './mcp_auth.js';
import { openInBrowser } from './open_url.js';
import {
  deviceEndpoint,
  deviceSignInWaiting,
  pollDeviceToken,
  startDeviceAuthorization,
} from './mcp_device.js';
import { VERSION } from './version.js';
import { formatJcs } from './knowledge/canonical.js';
import { replaceLongest } from './secrets.js';
import { visibleLine } from './visible_text.js';
import { tokenLen } from './middleware/tool_result_prune.js';
import type { Job, JobOwner } from './jobs.js';
import type { ElicitationAnswer } from './hooks.js';
import {
  environmentThenSecrets,
  expandReferences,
  mcpToolName,
  mcpType,
  WITHHELD_VARIABLES,
  type McpEntry,
  type McpScope,
  type McpServerConfig,
  type McpType,
} from './mcp_config.js';
import { runHeadersHelper } from './mcp_headers_helper.js';
export { replaceLongest };

export interface McpConnection {
  name: string;
  transport: McpType;
  /** Where its entry is written: your settings (the default), this project's in them, or the project's `.mcp.json`. */
  scope?: McpScope;
  /** The folder a `headersHelper` runs in: the workspace when none is given. */
  folder?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /**
   * Sent with every request to a server reached by URL; `${VAR}` and `${VAR:-default}` are filled in on connect, from
   * the environment and then the saved secrets.
   */
  headers?: Record<string, string>;
  /** A command whose standard output, a JSON object, gives more headers when the server is connected. */
  headersHelper?: string;
  /** Whether a project's or a local `headersHelper` may run: the folder is trusted. */
  trusted?: boolean;
  /**
   * Configured headers of the names Circle sets itself (`Circle-Session-Id`, `traceparent`),
   * as written: never sent, and their values never filled in.
   */
  notSent?: string[];
  /** The largest file a file parameter of the server's tools takes, in bytes. */
  maxFileBytes?: number;
  /** The most a tool call may take, in milliseconds, from the entry's `timeout`. */
  timeout?: number;
}
/** The largest file a file parameter takes unless the server's entry says otherwise. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export interface McpStatus {
  name: string;
  connection: string;
  tools: string[];
  error: string;
  /** The names of the headers a server is sent; their values are never listed. */
  headers?: string[];
  /** Configured headers that are not sent, since Circle sets them itself. */
  notSent?: string[];
  /** The server's sign-in page, while Circle waits for the browser to come back from it or for the code to be typed. */
  authorize?: string;
  /** During a device sign-in, the code to type on that page. */
  code?: string;
  /** Where its entry is written. */
  scope?: McpScope;
  /** What in its entry may not be what was meant, such as a `${VAR}` that is not set; never a value. */
  warnings?: string[];
  /** A server of the project's `.mcp.json` that waits for the person's approval, or that the person declined. */
  approval?: 'pending' | 'declined';
}
/** What a server shows while its sign-in is under way; a reload meanwhile shows the same. */
interface SignInShown {
  error: string;
  authorize: string;
  code?: string;
}
/** What a server waiting for its browser sign-in says in place of its tools. */
export const SIGN_IN_WAITING = 'waiting for sign-in in the browser';
/** The headers Circle sends of its own; lowercase, as compared. */
const OWN_HEADERS = new Set([
  'circle-session-id',
  'circle-agent-id',
  'traceparent',
]);
/** What the manager needs from the runtime it serves. */
export interface McpServices {
  /** The saved secrets, read on each connect for `${secret:NAME}` in headers. */
  secrets?: () => Record<string, string>;
  /** A server's connection ended on its own: what the model is told of it changed. */
  onChange?: () => void;
  /** The Circle session the runtime is in now; it can change while the runtime lives. */
  sessionId?: () => string;
  /**
   * Circle's home, where a server's sign-in is kept (mcp-auth.json). Without it a server that asks for a sign-in only
   * fails, as before.
   */
  home?: string;
  /** Opens a sign-in page in the system browser; by default the platform's opener. */
  openUrl?: (url: string) => Promise<void>;
  /**
   * Reads the file a file parameter names, under read_file's rules; at most `limit` bytes.
   * Without it, the terminal's rules for the workspace apply.
   */
  readFile?: (
    path: string,
    context: ToolContext,
    limit: number,
  ) => Promise<{ path: string; bytes: Buffer }>;
  /**
   * Asks the person in the question panel, as the `question` tool does: what a server asks in the middle of a call
   * (#556). Without it such a request is cancelled.
   */
  ask?: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
  /**
   * Someone is there to reconnect a server: a program that exits is marked failed until `/mcp reconnect`, rather than
   * started again by the next call.
   */
  interactive?: boolean;
  /**
   * Starts a background job for a call that runs on after its turn (jobs.ts startCall). Without it, or outside an
   * interactive session, a call runs where it was made until it ends.
   */
  background?: (
    title: string,
    owner: JobOwner,
    run: (signal: AbortSignal, log: (text: string) => void) => Promise<string>,
  ) => Job;
  /** Keeps a result too large to give the model in a file, and gives the path the model reads it by. */
  saveResult?: (text: string, tool: string) => string;
  /**
   * The Elicitation hooks, which may answer a server's question in the person's place, and the ElicitationResult
   * hooks, which may change or block the person's answer before the server gets it. Nothing: the hooks leave it.
   */
  elicitationHooks?: {
    before(
      request: ElicitationRequest,
      signal: AbortSignal,
    ): Promise<ElicitationAnswer | undefined>;
    after(
      request: ElicitationRequest,
      answer: ElicitationAnswer,
      signal: AbortSignal,
    ): Promise<ElicitationAnswer | undefined>;
  };
}
/** A server's question in the middle of a call, as its hooks are told of it. */
export interface ElicitationRequest {
  server: string;
  mode: 'form' | 'url';
  message: string;
  url?: string;
  elicitationId?: string;
  requestedSchema?: unknown;
}
/** How long a call of the conversation runs before it goes on as a background job. */
export const AUTO_BACKGROUND_MS = 120_000;
/** A result longer than this many characters, or than MAX_RESULT_TOKENS, is kept in a file. */
export const MAX_RESULT_CHARS = 50_000;
export const MAX_RESULT_TOKENS = 25_000;
/** A limit in milliseconds from the environment, or the default when it is not a number of 0 or more. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
/** The most a tool call may take unless its server's entry or CIRCLE_MCP_TOOL_TIMEOUT says otherwise: about 28 hours. */
export const DEFAULT_CALL_TIMEOUT_MS = 100_000_000;
/** How long a call to a server reached over the network may go without an answer or a progress notice. */
export const REMOTE_IDLE_MS = 5 * 60_000;
/** The same for a program started for a server. */
export const STDIO_IDLE_MS = 30 * 60_000;
/**
 * A tool's file parameters: its top-level properties that are base64 text
 * (`contentEncoding: "base64"`), which the model fills with a local file's path.
 */
export function fileParameters(schema: unknown): string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  return Object.entries(schema.properties)
    .filter(
      ([, property]) =>
        isRecord(property) &&
        property.type === 'string' &&
        typeof property.contentEncoding === 'string' &&
        property.contentEncoding.toLowerCase() === 'base64',
    )
    .map(([name]) => name);
}
/** What a file parameter's description gains, for the model. */
export const FILE_PARAMETER_NOTE =
  "Takes a LOCAL FILE PATH, absolute or relative to the workspace: Circle reads the file and sends its bytes. Give the path, never the file's content or base64.";
/**
 * The schema the model is shown: a file parameter's description says it takes a path. Its
 * limits on the encoded text (`pattern`, `format`, `minLength`, `maxLength`) are left out,
 * since Circle checks the model's arguments against this schema and a path is no base64.
 */
export function modelSchema(
  schema: Record<string, unknown>,
  files: string[],
): Record<string, unknown> {
  if (!files.length) return schema;
  const properties = { ...(schema.properties as Record<string, unknown>) };
  for (const name of files) {
    const {
      pattern: _pattern,
      format: _format,
      minLength: _minLength,
      maxLength: _maxLength,
      ...property
    } = properties[name] as Record<string, unknown>;
    const given =
      typeof property.description === 'string'
        ? property.description.trim()
        : '';
    properties[name] = {
      ...property,
      description: given
        ? `${given} ${FILE_PARAMETER_NOTE}`
        : FILE_PARAMETER_NOTE,
    };
  }
  return { ...schema, properties };
}
/** A file read for a file parameter. */
interface SentFile {
  name: string;
  /** The path as the model gave it. */
  path: string;
  bytes: Buffer;
  sha256: string;
  /** How the file is shown in place of its bytes. */
  label: string;
}
/** The most of a server's instructions the system prompt takes, in bytes of UTF-8. */
export const MAX_INSTRUCTIONS = 8 * 1024;
/**
 * A server's instructions as the system prompt takes them: line breaks and tabs kept, every
 * other control character and the bidirectional controls taken out, then `hide` applied (a
 * value cut by a control character is whole by then, and one at the cut is hidden before it),
 * and the first 8 KiB kept with a mark where the rest was cut. Nothing for a server that gave
 * none.
 */
export function serverInstructions(
  raw: unknown,
  hide: (text: string) => string = (text) => text,
): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = hide(
    raw
      .replace(/\r\n?/g, '\n')
      .replace(
        /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g,
        '',
      ),
  ).trim();
  if (!text) return undefined;
  if (Buffer.byteLength(text) <= MAX_INSTRUCTIONS) return text;
  let size = 0;
  let end = 0;
  for (const char of text) {
    size += Buffer.byteLength(char);
    if (size > MAX_INSTRUCTIONS) break;
    end += char.length;
  }
  return `${text.slice(0, end).trimEnd()}\n[cut by Circle: the server's instructions are longer than 8 KiB]`;
}
export { mcpToolName };
export interface McpConnections {
  connections: McpConnection[];
  // Entries that are not started, with the reason (`/mcp` lists them)
  skipped: McpStatus[];
}
/** What a server's row shows of its connection: its command line or its address, as written. */
export function connectionText(connection: {
  command?: string;
  args?: string[];
  url?: string;
}): string {
  return connection.command
    ? [connection.command, ...(connection.args ?? [])].join(' ')
    : (connection.url ?? '');
}
const strings = (value: unknown): Record<string, string> | undefined =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, String(item)]),
      )
    : undefined;
/**
 * The connections the configured servers make, and why the others are not made. `servers` is an `mcpServers` object,
 * taken as your own, or the entries of every place a run reads (mcp_config.ts mcpServersForRun).
 */
export function buildMcpConnections(
  servers: Record<string, McpServerConfig> | McpEntry[],
  options: { trusted?: boolean } = {},
): McpConnections {
  const entries: McpEntry[] = Array.isArray(servers)
    ? servers
    : Object.entries(servers).map(([name, config]) => ({
        name,
        scope: 'user' as const,
        config,
        folder: '',
      }));
  const connections: McpConnection[] = [];
  const skipped: McpStatus[] = [];
  for (const { name, scope, config: item, folder } of entries) {
    if (!isRecord(item)) continue;
    const shown = connectionText({
      command: typeof item.command === 'string' ? item.command : undefined,
      args: Array.isArray(item.args) ? item.args.map(String) : undefined,
      url: typeof item.url === 'string' ? item.url : undefined,
    });
    const skip = (error: string): void => {
      skipped.push({ name, connection: shown, tools: [], error, scope });
    };
    if (item.enabled === false) {
      skip('disabled');
      continue;
    }
    const type = mcpType(item);
    if (item.type === 'sdk') {
      skip(
        `declares type "sdk", which only an application that embeds Circle can register`,
      );
      continue;
    }
    if (!type) {
      skip(
        `its type ${JSON.stringify(item.type)} is not one of stdio, http, sse and ws`,
      );
      continue;
    }
    if (type === 'stdio' && item.type === undefined && item.url !== undefined) {
      skip(
        'has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry',
      );
      continue;
    }
    let connection: McpConnection;
    if (type === 'stdio') {
      if (typeof item.command !== 'string' || !item.command.trim()) {
        skip('a stdio server needs a "command"');
        continue;
      }
      connection = {
        name,
        transport: 'stdio',
        scope,
        folder,
        command: item.command,
        args:
          item.args === undefined
            ? []
            : Array.isArray(item.args)
              ? item.args.map(String)
              : [String(item.args)],
        ...(strings(item.env) ? { env: strings(item.env) } : {}),
      };
    } else {
      if (typeof item.url !== 'string' || !item.url.trim()) {
        skip('not configured: the entry has no url');
        continue;
      }
      connection = { name, transport: type, scope, folder, url: item.url };
      if (isRecord(item.headers)) {
        // Circle's own are left out here, before anything is filled in: a variable named in a header that is not sent
        // is not needed
        const headers: Record<string, string> = {};
        const notSent: string[] = [];
        for (const [key, value] of Object.entries(item.headers))
          if (OWN_HEADERS.has(key.toLowerCase())) notSent.push(key);
          else headers[key] = String(value);
        connection.headers = headers;
        if (notSent.length) connection.notSent = notSent;
      }
      if (typeof item.headersHelper === 'string' && item.headersHelper.trim()) {
        connection.headersHelper = item.headersHelper;
        connection.trusted = scope === 'user' || options.trusted === true;
      }
    }
    // Below a second the entry's limit is not read, as the documented format has it
    if (typeof item.timeout === 'number' && item.timeout >= 1000)
      connection.timeout = item.timeout;
    // A limit that cannot be read is not replaced by the default: the server does not start
    const limit = item.max_file_bytes;
    if (
      limit !== undefined &&
      (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
    ) {
      skip('max_file_bytes must be a whole number of bytes, 1 or more');
      continue;
    }
    if (typeof limit === 'number') connection.maxFileBytes = limit;
    connections.push(connection);
  }
  return { connections, skipped };
}
/**
 * Header values as sent: each `${VAR}` and `${VAR:-default}` filled in from Circle's own environment, then from the
 * saved secrets, so a token need not be written into settings. A reference to nothing set stays as written.
 */
export function resolveHeaders(
  headers: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
  secrets: Record<string, string> = {},
): Record<string, string> {
  return fillHeaders(headers, env, secrets).headers;
}
/**
 * A header that carries credentials by its name: `Authorization`, `Proxy-Authorization`, or a
 * name that looks secret, such as `X-Api-Key` or `Cookie`.
 */
const credentialHeader = (name: string): boolean =>
  /^(?:proxy-)?authorization$/i.test(name) || secretLookingName(name);
/** A connection's values with their references filled in, and what the server must not be seen to say back. */
interface Filled {
  headers: Record<string, string>;
  /**
   * Each secret value put in, with what is shown in its place: `%NAME%` for a saved secret, as everywhere a secret's
   * value is hidden, and the reference as written for an environment variable whose name, or whose header's, looks
   * secret. Any other value is no secret, and hiding it would only change what the server says wherever it stands.
   */
  filled: Map<string, string>;
  /** References to nothing set, by where they are; never a value. */
  missing: string[];
}
function fillHeaders(
  headers: Record<string, string> = {},
  env: NodeJS.ProcessEnv,
  secrets: Record<string, string>,
): Filled {
  const resolved: Record<string, string> = {};
  const filled = new Map<string, string>();
  const missing: string[] = [];
  const lookup = environmentThenSecrets(env, secrets);
  for (const [name, template] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
      throw new Error(`invalid header name '${name}'`);
    const expanded = expandReferences(template, lookup, (variable) =>
      WITHHELD_VARIABLES.has(variable),
    );
    for (const variable of expanded.missing)
      missing.push(`headers.${name} names \${${variable}}, which is not set`);
    for (const used of expanded.used)
      if (!used.value) continue;
      else if (used.from === 'secret') filled.set(used.value, `%${used.name}%`);
      else if (secretLookingName(used.name) || credentialHeader(name))
        filled.set(used.value, `\${${used.name}}`);
    if (/[\r\n\0]/.test(expanded.text))
      throw new Error(`header ${name} has a line break or NUL in its value`);
    resolved[name] = expanded.text;
  }
  return { headers: resolved, filled, missing };
}
/**
 * The address a server reached over the network is connected at: its `url` with its references filled in, as a
 * connection fills them in. Nothing for a program, or for an address that is not one once filled in.
 */
export function connectionAddress(
  connection: McpConnection,
  secrets: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!connection.url) return undefined;
  try {
    return new URL(
      expandReferences(
        connection.url,
        environmentThenSecrets(env, secrets),
        (variable) => WITHHELD_VARIABLES.has(variable),
      ).text,
    ).href;
  } catch {
    return undefined;
  }
}
/** What a connection is started or reached with: its references filled in. */
interface Resolved extends Filled {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}
function resolveConnection(
  connection: McpConnection,
  env: NodeJS.ProcessEnv,
  secrets: Record<string, string>,
): Resolved {
  const lookup = environmentThenSecrets(env, secrets);
  const missing: string[] = [];
  const filled = new Map<string, string>();
  const one = (text: string, where: string, remote = false): string => {
    const expanded = expandReferences(text, lookup, (variable) =>
      remote ? WITHHELD_VARIABLES.has(variable) : false,
    );
    for (const variable of expanded.missing)
      missing.push(`${where} names \${${variable}}, which is not set`);
    for (const used of expanded.used)
      if (used.value && used.from === 'secret')
        filled.set(used.value, `%${used.name}%`);
    return expanded.text;
  };
  if (connection.transport === 'stdio')
    return {
      headers: {},
      filled,
      missing,
      command: one(connection.command!, 'command'),
      args: (connection.args ?? []).map((arg, index) =>
        one(arg, `args[${index}]`),
      ),
      ...(connection.env
        ? {
            env: Object.fromEntries(
              Object.entries(connection.env).map(([key, value]) => [
                key,
                one(value, `env.${key}`),
              ]),
            ),
          }
        : {}),
    };
  const url = one(connection.url!, 'url', true);
  const headers = fillHeaders(connection.headers, env, secrets);
  for (const [value, shown] of headers.filled) filled.set(value, shown);
  return {
    headers: headers.headers,
    filled,
    missing: [...missing, ...headers.missing],
    url,
  };
}
function hideFilled(filled: Map<string, string>): (text: string) => string {
  return (text) => replaceLongest(text, filled);
}
/** An error whose message says no filled-in value. */
function hiddenError(error: unknown, hide: (text: string) => string): unknown {
  if (!(error instanceof Error)) return error;
  const message = hide(error.message);
  return message === error.message ? error : new Error(message);
}
/** The call under way: its trace, and who it runs for (#551), as its requests carry them. */
interface CallStore {
  traceparent: string;
  sessionId?: string;
  agentId?: string;
  /** Fires when the call is stopped, as by esc. */
  signal?: AbortSignal;
  /** Ends the attempt under way: the stream its answer was to come on ended without it (#555). */
  lost?: (error: Lost) => void;
}
const toolCalls = new AsyncLocalStorage<CallStore>();
/**
 * A W3C trace context for one tool call: version 00, a new random trace id and parent id
 * (never all zeros), sampled.
 */
export function traceparent(): string {
  const id = (bytes: number): string => {
    for (;;) {
      const value = randomBytes(bytes).toString('hex');
      if (/[^0]/.test(value)) return value;
    }
  };
  return `00-${id(16)}-${id(8)}-01`;
}
/**
 * How a server reached over HTTP is sent each request: with the Circle session of that
 * moment as `Circle-Session-Id`, read again for every request since a runtime can move to
 * another session, and during a tool call with that call's `traceparent`. Both are Circle's
 * own: a configured header of either name is never sent (buildMcpConnections leaves them
 * out already).
 */
function requestFetch(sessionId?: () => string | undefined): FetchLike {
  return (url, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('Circle-Session-Id');
    headers.delete('Circle-Agent-Id');
    headers.delete('traceparent');
    // A call says whose it is: the conversation's session, and a subagent's own as Circle-Agent-Id. Outside a
    // call, the runtime's session of the moment.
    const call = toolCalls.getStore();
    const session = call?.sessionId ?? sessionId?.();
    if (session) headers.set('Circle-Session-Id', session);
    if (call?.agentId) headers.set('Circle-Agent-Id', call.agentId);
    if (call) headers.set('traceparent', call.traceparent);
    const sent = fetch(url, { ...init, headers });
    // The attempt of the moment: a stream of an earlier attempt that ends late does not end this one
    const lost = call?.lost;
    const id = lost ? callId(init) : undefined;
    if (!lost || id === undefined) return sent;
    return sent.then((response) => watchAnswer(response, id, lost));
  };
}
/** The id of the tools/call a POST sends, if it sends one. */
function callId(init: RequestInit | undefined): string | number | undefined {
  if (init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string')
    return undefined;
  try {
    const message: unknown = JSON.parse(init.body);
    return isRecord(message) &&
      message.method === 'tools/call' &&
      (typeof message.id === 'number' || typeof message.id === 'string')
      ? message.id
      : undefined;
  } catch {
    return undefined;
  }
}
/**
 * A call answered over an event stream: the MCP library waits for the answer for as long as the call may take, even
 * after the stream ended without it (#555). A copy of the stream is read here; when it ends without the answer and
 * without an event id the library could resume it by, the call is told its answer is lost. A stream with an event id
 * is the library's to resume, as the 2025-11-25 revision has it.
 */
function watchAnswer(
  response: Response,
  id: string | number,
  lost: (error: Lost) => void,
): Response {
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !response.body || !/^text\/event-stream\b/i.test(type))
    return response;
  const [mine, theirs] = response.body.tee();
  void answerIn(mine, id).then((outcome) => {
    if (outcome === 'lost')
      lost(new Lost('the stream the answer was to come on ended without it'));
  });
  return new Response(theirs, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
/** Reads an event stream until the answer to request `id` passes in it, or the stream ends. */
async function answerIn(
  stream: ReadableStream<Uint8Array>,
  id: string | number,
): Promise<'answered' | 'resumable' | 'lost'> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resumable = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // An event ends at an empty line
      const events = buffer.split(/\r\n\r\n|\n\n|\r\r/);
      buffer = events.pop() ?? '';
      for (const event of events) {
        const data: string[] = [];
        for (const line of event.split(/\r\n|\n|\r/)) {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const text = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'id' && text) resumable = true;
          else if (field === 'data') data.push(text);
        }
        let message: unknown;
        try {
          message = data.length ? JSON.parse(data.join('\n')) : undefined;
        } catch {
          continue;
        }
        if (
          isRecord(message) &&
          message.id === id &&
          ('result' in message || 'error' in message)
        ) {
          void reader.cancel().catch(() => {});
          return 'answered';
        }
      }
    }
  } catch {
    // The stream broke off
  }
  return resumable ? 'resumable' : 'lost';
}
function transportFor(
  connection: McpConnection,
  resolved: Resolved,
  workspace: string,
  fetch: FetchLike,
  authProvider?: McpAuthProvider,
): Transport {
  if (connection.transport === 'stdio')
    return new StdioClientTransport({
      command: resolved.command!,
      args: resolved.args ?? [],
      cwd: workspace,
      env: {
        ...(shellEnvironment() as Record<string, string>),
        CIRCLE_PROJECT_DIR: workspace,
        ...resolved.env,
      },
      stderr: 'pipe',
    });
  const url = new URL(resolved.url!);
  const protocols =
    connection.transport === 'ws' ? ['ws:', 'wss:'] : ['http:', 'https:'];
  if (!protocols.includes(url.protocol) || url.username || url.password)
    throw new Error('invalid MCP server URL');
  const headers = resolved.headers;
  const requestInit = Object.keys(headers).length ? { headers } : undefined;
  if (connection.transport === 'http')
    return new StreamableHTTPClientTransport(url, {
      requestInit,
      fetch: authProvider ? authProvider.authorizedFetch(fetch) : fetch,
      ...(authProvider ? { authProvider } : {}),
    });
  if (connection.transport === 'ws') {
    if (requestInit) throw new Error('a ws server cannot be sent headers yet');
    return new WebSocketClientTransport(url);
  }
  return new SSEClientTransport(url, {
    requestInit,
    fetch: authProvider ? authProvider.authorizedFetch(fetch) : fetch,
    ...(authProvider ? { authProvider } : {}),
  });
}
/** Image and PDF content a model is given as an attachment rather than as text. */
const ATTACHED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
];
/**
 * A resource link as the model reads it (#553): what it is and where, and how to read it, since the link is not
 * the content and need not be in the server's list.
 */
function resourceLinkText(
  block: Record<string, unknown>,
  server: string,
): string {
  const uri = String(block.uri);
  const label = String(block.title || block.name || uri);
  const mime = typeof block.mimeType === 'string' ? ` (${block.mimeType})` : '';
  const about =
    typeof block.description === 'string' && block.description.trim()
      ? `: ${block.description.trim()}`
      : '';
  return `Resource link: ${label} <${uri}>${mime}${about}. Its content is not here; read_mcp_resource with server ${JSON.stringify(server)} and this uri reads it.`;
}
/** A tool result as the model reads it: its text, and the pictures and PDFs it carries. */
function resultText(
  result: ToolResult,
  tool: string,
  context: ToolContext,
  server: string,
): { text: string; attachments: MediaAttachment[] } {
  const content = Array.isArray(result.content) ? result.content : [];
  const attachments: MediaAttachment[] = [];
  const text = content
    .map((block) => {
      if (!isRecord(block)) return JSON.stringify(block);
      if (block.type === 'text') return String(block.text || '');
      if (block.type === 'resource_link' && typeof block.uri === 'string')
        return resourceLinkText(block, server);
      const resource: Record<string, unknown> | undefined =
        block.type === 'resource' && isRecord(block.resource)
          ? block.resource
          : undefined;
      // A resource the result carries whole, as text: its words, under where it is from
      if (resource && typeof resource.text === 'string')
        return `Resource <${String(resource.uri)}>${typeof resource.mimeType === 'string' ? ` (${resource.mimeType})` : ''}:\n${resource.text}`;
      const data = block.type === 'image' ? block.data : resource?.blob;
      const mime = block.type === 'image' ? block.mimeType : resource?.mimeType;
      if (
        context.emitAttachments &&
        typeof data === 'string' &&
        typeof mime === 'string' &&
        ATTACHED_TYPES.includes(mime)
      ) {
        const filename = `${tool}-${attachments.length + 1}.${mime.split('/')[1]}`;
        attachments.push(
          attachmentFromBase64(
            data,
            mime as MediaAttachment['mime_type'],
            filename,
          ),
        );
        return `Attachment: ${filename} (${mime})`;
      }
      return JSON.stringify(block);
    })
    .join('\n');
  return { text, attachments };
}
// The longest a timer can wait; the MCP SDK stops a request after 60 seconds unless told.
const NO_LIMIT = 2_147_483_647;
/**
 * What a tool's annotations and `_meta` say of it. None of it decides whether a call asks: permission rules and the
 * person's mode do. Read-only (`readOnlyHint`, and not also `destructiveHint`): its calls may run side by side, and one
 * cut off after it was sent goes once more. Idempotent (`idempotentHint`): the same, the latter only; and a call that
 * sends files may get an earlier result again while no call that may change what the server holds has reached it.
 * `circle/requiresUserInteraction: true` in its `_meta`: every call asks a person, in every mode.
 */
function toolHints(spec: { annotations?: unknown; _meta?: unknown }): {
  readOnly: boolean;
  idempotent: boolean;
  asksPerson: boolean;
} {
  const hints = isRecord(spec.annotations) ? spec.annotations : {};
  return {
    readOnly: hints.readOnlyHint === true && hints.destructiveHint !== true,
    idempotent: hints.idempotentHint === true,
    asksPerson:
      isRecord(spec._meta) && spec._meta[REQUIRES_USER_INTERACTION] === true,
  };
}
/** The `_meta` key a server marks a tool with whose every call a person approves. */
export const REQUIRES_USER_INTERACTION = 'circle/requiresUserInteraction';
/** What a tool's server says of it that Circle acts on. */
interface ToolMarks {
  readOnly: boolean;
  asksPerson: boolean;
  /** The server it belongs to and its own name there. */
  server: string;
  tool: string;
}
type ToolResult = CallToolResult;
/** The errors a request's chain of causes carries, outermost first. */
function causes(error: unknown): { code?: unknown; message?: unknown }[] {
  const chain: { code?: unknown; message?: unknown }[] = [];
  for (
    let cause = error;
    isRecord(cause) || cause instanceof Error;
    cause = (cause as { cause?: unknown }).cause
  ) {
    chain.push(cause as { code?: unknown; message?: unknown });
    if (chain.length > 6) break;
  }
  return chain;
}
/** Failures before a request left this machine: nothing reached the server, so sending it again is safe (#555). */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
function notSent(error: unknown): boolean {
  return causes(error).some(
    (cause) => typeof cause.code === 'string' && NOT_SENT_CODES.has(cause.code),
  );
}
/** An HTTP status a request failed with, when it failed with one. */
function httpStatus(error: unknown): number | undefined {
  for (const cause of causes(error)) {
    if (cause instanceof SdkHttpError && cause.status > 0) return cause.status;
    if (
      cause instanceof SseError &&
      typeof cause.code === 'number' &&
      cause.code > 0
    )
      return cause.code;
  }
  return undefined;
}
/**
 * What a failure to connect says, with what the server answered when the library's words leave that out, as they do
 * when the server refused Circle's question for its revision.
 */
function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  for (const cause of causes(error))
    if (cause instanceof SdkHttpError && typeof cause.data.text === 'string') {
      const answered = oneLine(cause.data.text);
      return answered && !message.includes(answered)
        ? `${message}: ${answered}`
        : message;
    }
  return message;
}
/** A server reached over HTTP that no longer knows the session the request named. */
function sessionGone(error: unknown, client: Client): boolean {
  const transport = client.transport;
  return (
    httpStatus(error) === 404 &&
    transport instanceof StreamableHTTPClientTransport &&
    transport.sessionId !== undefined
  );
}
/** A failure that may pass if the request is made again: nothing was sent, or the server answered 5xx. */
function passing(error: unknown): boolean {
  const status = httpStatus(error);
  return notSent(error) || (status !== undefined && status >= 500);
}
/** A server's answer that it does not know a task (an invalid `taskId`, -32602). */
function unknownTask(error: unknown): boolean {
  return (
    error instanceof ProtocolError &&
    error.code === ProtocolErrorCode.InvalidParams
  );
}
/** A request that got no answer in its time. */
function timedOut(error: unknown): boolean {
  return causes(error).some(
    (cause) =>
      cause instanceof SdkError && cause.code === SdkErrorCode.RequestTimeout,
  );
}
/** A call that reached the server and whose answer cannot come: its answer's stream ended, or its task was lost. */
class Lost extends SdkError {
  constructor(message: string) {
    super(SdkErrorCode.ConnectionClosed, message);
  }
}
/** What the model reads when the server lost the session, or the connection ended, while a task of the call ran. */
const taskLost = (lost: string, taskId: string): string =>
  `${lost} while task ${taskId} was running: the tool may have run, so check whether it did before calling it again`;
/** The session or the connection a task of the call ran on was lost: the call is not sent again. */
class TaskLost extends Error {}
/**
 * The connection ended after the request was sent, so it may have reached the server (#555): the MCP library closed
 * the connection under the call, the call's answer was lost, or the socket was cut. A server's own error is none of
 * these, whatever its code or words: the library tells a closed connection of its own (an SdkError) from an error
 * the server sent (a ProtocolError).
 */
function droppedAfterSending(error: unknown): boolean {
  return causes(error).some((cause) => {
    if (cause instanceof Lost) return true;
    if (cause instanceof ProtocolError) return false;
    if (cause instanceof SdkError)
      return cause.code === SdkErrorCode.ConnectionClosed;
    return (
      cause.code === 'UND_ERR_SOCKET' ||
      cause.code === 'ECONNRESET' ||
      /\b(terminated|other side closed|socket hang up)\b/i.test(
        String(cause.message ?? ''),
      )
    );
  });
}
/**
 * Calls a server's tool and gives its result as the server sent it. The library would check a result against the
 * output schema of the tool and throw the result away when it does not match, as when the server added a field after
 * Circle connected (#513): it is given the tool as listed without its output schema, so it checks nothing of the
 * result and still sends the headers a tool's input schema asks for (`x-mcp-header`, 2026-07-28). The server still
 * checks the request, and whether a result matches its schema is for the caller to say.
 */
function callServerTool(
  client: Client,
  params: {
    name: string;
    arguments: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  },
  options: RequestOptions,
  spec?: ServerTool,
): Promise<ToolResult> {
  const { outputSchema: _unchecked, ...listed } = spec ?? {
    name: params.name,
    inputSchema: { type: 'object' as const },
  };
  return client.callTool(params, { ...options, toolDefinition: listed });
}
/** A server's words on one line of the screen, cut at `max` characters: see `visibleLine`. */
const oneLine = (text: string, max = 160): string => visibleLine(text, max);
/** A progress notice as the call's row reads it: `3/10 · indexing` (#554). */
export function progressText(notice: {
  progress: number;
  total?: number;
  message?: string;
}): string {
  const amount =
    notice.total === undefined
      ? String(notice.progress)
      : `${notice.progress}/${notice.total}`;
  return notice.message ? `${amount} · ${notice.message}` : amount;
}
/** A task's state as the call's row reads it: `task working · indexing` (#554). */
function taskText(task: { status: string; statusMessage?: string }): string {
  const status = `task ${task.status.replace(/_/g, ' ')}`;
  return task.statusMessage ? `${status} · ${task.statusMessage}` : status;
}
/** The tasks extension of the 2026-07-28 revision, as client and server declare it. */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
/** What Circle takes, as it declares it: a server's questions by a form and by a page to open. */
const CAPABILITIES = { elicitation: { form: {}, url: {} } };
/** The `_meta` of a request that declares the tasks extension too: a call that may get a task, and tasks/* requests. */
const TASKS_META = {
  [CLIENT_CAPABILITIES_META_KEY]: {
    ...CAPABILITIES,
    extensions: { [TASKS_EXTENSION]: {} },
  },
};
/** How far apart Circle asks how a task stands when its server says nothing, and the least and most apart it asks. */
export const TASK_POLL_MS = 2000;
export const TASK_POLL_MIN_MS = 250;
export const TASK_POLL_MAX_MS = 30_000;
/** The most questions of one task Circle answers; any after them are left. */
export const MAX_TASK_INPUTS = 16;
const TASK_STATUSES = new Set([
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
]);
/** A task as a server gives it, in answer to a call or to `tasks/get`. */
interface TaskState {
  taskId: string;
  status: string;
  statusMessage?: string;
  pollIntervalMs?: number;
  result?: unknown;
  error?: unknown;
  inputRequests?: unknown;
}
/** A task as a server gave it, checked: a task id of at most 128 printable characters and a status. */
function taskState(raw: unknown, server: string, tool: string): TaskState {
  if (
    !isRecord(raw) ||
    typeof raw.taskId !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/.test(raw.taskId) ||
    typeof raw.status !== 'string'
  )
    throw new Error(
      `MCP server "${server}" returned a malformed task handle for tool "${tool}"`,
    );
  return {
    taskId: raw.taskId,
    status: raw.status,
    ...(typeof raw.statusMessage === 'string'
      ? { statusMessage: raw.statusMessage }
      : {}),
    ...(typeof raw.pollIntervalMs === 'number' &&
    Number.isFinite(raw.pollIntervalMs)
      ? { pollIntervalMs: raw.pollIntervalMs }
      : {}),
    result: raw.result,
    error: raw.error,
    inputRequests: raw.inputRequests,
  };
}
/** The `_meta` key of the result Circle's client puts in place of a task a server answered a call with. */
const TASK_ANSWER = 'circle/task-answer';
/**
 * The MCP client, which hands Circle a task a server answered a call with (the 2026-07-28 tasks extension): the library
 * takes such an answer for one it cannot read, so the client notes which calls declared the extension as they go out,
 * keeps a task answered to one of them, and gives the library a result in its place that names it.
 */
class CircleClient extends Client {
  // The ids of the calls sent declaring the extension, until each is answered
  private readonly mayBeTasks = new Set<string | number>();
  // The tasks servers answered them with, by the name the result in their place carries
  private readonly tasks = new Map<string, Record<string, unknown>>();
  override async connect(
    transport: Transport,
    options?: ConnectOptions,
  ): Promise<void> {
    const send = transport.send.bind(transport);
    transport.send = (message, sendOptions) => {
      if (
        'method' in message &&
        message.method === 'tools/call' &&
        'id' in message &&
        declaresTasks(message.params)
      )
        this.mayBeTasks.add(message.id);
      return send(message, sendOptions);
    };
    return super.connect(transport, options);
  }
  protected override _onresponse(response: JSONRPCResponse): void {
    if (
      response.id !== undefined &&
      this.mayBeTasks.delete(response.id) &&
      'result' in response &&
      isRecord(response.result) &&
      response.result.resultType === 'task'
    ) {
      const name = randomUUID();
      this.tasks.set(name, response.result);
      super._onresponse({
        ...response,
        result: {
          resultType: 'complete',
          content: [],
          _meta: { [TASK_ANSWER]: name },
        },
      });
      return;
    }
    super._onresponse(response);
  }
  /** The task a call's result stands in for, once; nothing for any other result. */
  takeTask(result: ToolResult): Record<string, unknown> | undefined {
    const name = isRecord(result._meta) ? result._meta[TASK_ANSWER] : undefined;
    if (typeof name !== 'string') return undefined;
    const task = this.tasks.get(name);
    this.tasks.delete(name);
    return task;
  }
}
/** Whether a request's params declare the tasks extension. */
function declaresTasks(params: unknown): boolean {
  const meta = isRecord(params) ? params._meta : undefined;
  const capabilities = isRecord(meta)
    ? meta[CLIENT_CAPABILITIES_META_KEY]
    : undefined;
  const extensions = isRecord(capabilities)
    ? capabilities.extensions
    : undefined;
  return isRecord(extensions) && isRecord(extensions[TASKS_EXTENSION]);
}
/**
 * A tool the 2025-11-25 revision has run only as a task of that revision (`execution.taskSupport: "required"`), which
 * Circle does not run: on a connection of that revision such a call is not sent, since the server would refuse it.
 */
function onlyAnOldTask(spec: unknown, client: Client): boolean {
  const execution = isRecord(spec) ? spec.execution : undefined;
  return (
    isRecord(execution) &&
    execution.taskSupport === 'required' &&
    client.getProtocolEra() !== 'modern'
  );
}
/**
 * Whether a structured result matches the output schema a tool was listed with, compiled when first needed: undefined
 * when the tool has no output schema or it cannot be compiled, since then nothing can be said either way.
 */
function structureCheck(
  schema: unknown,
  validator: AjvJsonSchemaValidator,
): (value: unknown) => boolean | undefined {
  let check: ((value: unknown) => boolean) | null | undefined;
  return (value) => {
    if (!isRecord(schema)) return undefined;
    if (check === undefined)
      try {
        const validate = validator.getValidator(schema as JsonSchemaType);
        check = (input) => validate(input).valid;
      } catch {
        check = null;
      }
    return check ? check(value) : undefined;
  };
}
/** At most this many results of calls that sent files are kept, and this much of them. */
export const MAX_CACHED_RESULTS = 64;
export const MAX_CACHED_BYTES = 16 * 1024 * 1024;
/**
 * The results of successful calls to idempotent tools that sent files, by what the call
 * sent, with the server each came from; the oldest used goes first when there are too many.
 * An idempotent call repeated has no further effect only while nothing else changed what
 * the server holds, so a server's results are forgotten whenever another call that may
 * change it is sent there, and when its connection ends.
 */
class SentResults {
  private entries = new Map<
    string,
    { server: string; result: ToolResult; size: number }
  >();
  private size = 0;
  has(key: string): boolean {
    return this.entries.has(key);
  }
  get(key: string): ToolResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.result);
  }
  set(key: string, server: string, result: ToolResult): void {
    const size = JSON.stringify(result).length;
    if (size > MAX_CACHED_BYTES) return;
    const earlier = this.entries.get(key);
    if (earlier) {
      this.entries.delete(key);
      this.size -= earlier.size;
    }
    this.entries.set(key, { server, result: structuredClone(result), size });
    this.size += size;
    for (const [oldest, entry] of this.entries) {
      if (
        this.entries.size <= MAX_CACHED_RESULTS &&
        this.size <= MAX_CACHED_BYTES
      )
        break;
      this.entries.delete(oldest);
      this.size -= entry.size;
    }
  }
  /** Forgets every result kept from one server. */
  forget(server: string): void {
    for (const [key, entry] of this.entries)
      if (entry.server === server) {
        this.entries.delete(key);
        this.size -= entry.size;
      }
  }
  clear(): void {
    this.entries.clear();
    this.size = 0;
  }
}
/** What a result taken from the cache says before the files it was for. */
export const CACHED_RESULT =
  'cached (same content): an earlier call in this session sent the same files and arguments, so the server was not called again and this is its result';
/**
 * What the model reads before a structured result that does not match the output schema the server listed for the tool
 * when Circle connected. Circle can say that much for certain; whether the result is right is not for it to judge.
 */
export const UNDECLARED_STRUCTURE =
  'structured result, as the server sent it: it does not match the output schema the server listed for this tool when Circle connected';
/** What the card adds to a file the call will not send, since it gets its earlier result. */
export const NOT_SENT =
  'not sent: the same call earlier in this session got its result, which is given again';
/** A server Circle is connected to. */
interface Connected {
  name: string;
  client: CircleClient;
  connection: McpConnection;
  /** The address it was reached at, its references filled in. */
  url?: string;
  instructions?: string;
  /** False once the connection ended, closed by Circle or by the server. */
  open: boolean;
  /** Its tools as it listed them last, by their own names. */
  specs: Map<string, ServerTool>;
  /** The values filled into its entry, which what it says is shown without. */
  filled: Map<string, string>;
  /** When it listed its tools last, by the manager's clock. */
  listedAt: number;
  /** How long that list stays good, when the server said (`ttlMs`, 2026-07-28). */
  ttlMs?: number;
  /** A digest of that list, to tell a listing that changed nothing. */
  listing: string;
}
/** How long after a server says its tools changed Circle lists them, so several notices in a row list them once. */
export const TOOLS_CHANGED_WAIT_MS = 300;
/** What a server whose tools changed shows while Circle keeps its earlier tools. */
export const TOOLS_NOT_LISTED_AGAIN =
  'the server changed its tools and listing them again failed; the earlier tools stay until a reload';
/** The same for a server whose list of tools expired (`ttlMs`). */
export const TOOLS_EXPIRED_NOT_LISTED =
  "the server's list of tools expired and listing them again failed; the earlier tools stay until a reload";
/** The longest a server's `ttlMs` is believed: a day, as the MCP library holds a cached list at most. */
export const MAX_LIST_TTL_MS = 24 * 60 * 60_000;
/** A change stream that closes sooner than this after it opened closed at once. */
export const LISTEN_QUICK_MS = 10_000;
/** How many times in a row such a stream is opened again before Circle stops for the connection. */
export const LISTEN_QUICK_REOPENS = 3;
/** How many times a longer-lived stream is opened again within an hour before Circle pauses. */
export const LISTEN_HOURLY_REOPENS = 5;
/** That pause. */
export const LISTEN_PAUSE_MS = 6 * 60 * 60_000;
/** What the change streams of one connection did: how many in a row closed at once, and when longer ones reopened. */
export interface StreamHistory {
  quick: number;
  reopened: number[];
}
/**
 * What follows a change stream that closed, opened at `openedAt` and closed at `now`: open it again at once (0), after
 * a pause (its milliseconds), or stop for the connection.
 */
export function afterStreamClosed(
  history: StreamHistory,
  openedAt: number,
  now: number,
): number | 'stop' {
  if (now - openedAt < LISTEN_QUICK_MS)
    return ++history.quick > LISTEN_QUICK_REOPENS ? 'stop' : 0;
  history.quick = 0;
  while (history.reopened.length && history.reopened[0]! <= now - 60 * 60_000)
    history.reopened.shift();
  const pause =
    history.reopened.length >= LISTEN_HOURLY_REOPENS ? LISTEN_PAUSE_MS : 0;
  if (pause) history.reopened.length = 0;
  history.reopened.push(now + pause);
  return pause;
}
const OPEN = 'open';
const DECLINE_PAGE = 'decline';
/** The question for a page a server asks the person to open. */
function openPageQuestion(server: string, message: string, page: URL) {
  return {
    question: `${server} asks you to open a page: ${message.trim() || '(no message)'}\n${page.href}\nOpen it in the browser?`,
    header: server.length > 24 ? `${server.slice(0, 23)}…` : server,
    options: [
      { label: OPEN, description: 'open the page, and tell the server so' },
      { label: DECLINE_PAGE, description: `${server} is told you declined` },
    ],
    multiple: false,
    custom: false,
  };
}
/** The first answer of a panel's reply, or nothing when it was closed. */
function firstAnswer(reply: string): string | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(reply);
  } catch {
    return undefined;
  }
  const values = Array.isArray(decoded)
    ? decoded
    : isRecord(decoded) && Array.isArray(decoded.answers)
      ? decoded.answers
      : undefined;
  const first = values?.[0];
  return first === undefined
    ? undefined
    : String(Array.isArray(first) ? first[0] : first).trim();
}
/** What a server gets: its values only with an accept of a form. */
function elicitResult(
  answer: ElicitationAnswer,
  mode: 'form' | 'url',
): ElicitResult {
  return answer.action === 'accept' && mode === 'form' && answer.content
    ? {
        action: 'accept',
        content: answer.content as NonNullable<ElicitResult['content']>,
      }
    : { action: answer.action };
}
export class McpManager {
  tools: Tool[] = [];
  status: McpStatus[] = [];
  private servers: Connected[] = [];
  /**
   * Tools to read what servers publish as resources (#553): a tool result's `resource_link` points at one, and a
   * link need not be in the server's list. Offered while a connected server declares `resources`.
   */
  get resourceTools(): Tool[] {
    const readable = this.servers.filter(
      (server) =>
        server.open && server.client.getServerCapabilities()?.resources,
    );
    if (!readable.length) return [];
    const names = readable.map((server) => server.name);
    // Reading what a server publishes asks no one, as Circle's own reads do
    const effect: Effect = 'read';
    const find = (name: unknown): Connected => {
      const server = this.servers.find(
        (item) =>
          item.name === name &&
          item.open &&
          item.client.getServerCapabilities()?.resources,
      );
      if (!server)
        throw new Error(
          `no connected server ${JSON.stringify(name)} publishes resources; these do: ${names.join(', ')}`,
        );
      return server;
    };
    const server = {
      type: 'string',
      enum: names,
      description: 'The MCP server that publishes it',
    };
    return [
      {
        name: 'read_mcp_resource',
        description:
          "Read a resource an MCP server publishes, by its URI: what a tool result's resource link points at, or a URI list_mcp_resources gives.",
        parameters: {
          type: 'object',
          properties: {
            server,
            uri: { type: 'string', description: 'The resource URI' },
          },
          required: ['server', 'uri'],
          additionalProperties: false,
        },
        effect: effect,
        run: async (args, context) => {
          const { client, name } = find(args.server);
          // Read afresh each time, whatever the server said of how long a read stays good
          const { contents } = await client.readResource(
            { uri: String(args.uri) },
            { signal: context.signal, timeout: NO_LIMIT, cacheMode: 'bypass' },
          );
          const attachments: MediaAttachment[] = [];
          const parts = contents.map((item) => {
            const mime = item.mimeType ? ` (${item.mimeType})` : '';
            if ('text' in item && typeof item.text === 'string')
              return `Resource <${item.uri}>${mime}:\n${item.text}`;
            const blob = 'blob' in item ? item.blob : undefined;
            if (
              context.emitAttachments &&
              typeof blob === 'string' &&
              item.mimeType &&
              ATTACHED_TYPES.includes(item.mimeType)
            ) {
              const filename = `${name}-resource-${attachments.length + 1}.${item.mimeType.split('/')[1]}`;
              attachments.push(
                attachmentFromBase64(
                  blob,
                  item.mimeType as MediaAttachment['mime_type'],
                  filename,
                ),
              );
              return `Attachment: ${filename}${mime} from <${item.uri}>`;
            }
            return `Resource <${item.uri}>${mime}: binary content of ${typeof blob === 'string' ? Math.floor((blob.length * 3) / 4) : 0} bytes, not shown`;
          });
          if (attachments.length) context.emitAttachments!(attachments);
          return parts.join('\n\n') || `<${String(args.uri)}> has no content`;
        },
      },
      {
        name: 'list_mcp_resources',
        description:
          'List the resources MCP servers publish: their names and URIs, for read_mcp_resource. A link a tool result gives need not be in the list.',
        parameters: {
          type: 'object',
          properties: { server },
          additionalProperties: false,
        },
        effect: effect,
        run: async (args, context) => {
          const from =
            args.server === undefined ? readable : [find(args.server)];
          const lines: string[] = [];
          for (const { client, name } of from) {
            let cursor: string | undefined;
            // At most ten pages from a server, each asked for afresh: enough to see what it has, and never a loop
            for (let page = 0; page < 10; page++) {
              const listed = await client.request(
                {
                  method: 'resources/list',
                  params: cursor ? { cursor } : undefined,
                },
                ListResourcesResultSchema,
                { signal: context.signal, timeout: NO_LIMIT },
              );
              for (const item of listed.resources)
                lines.push(
                  `${name} · ${item.title || item.name} <${item.uri}>${item.mimeType ? ` (${item.mimeType})` : ''}`,
                );
              cursor = listed.nextCursor;
              if (!cursor) break;
            }
          }
          return lines.join('\n') || 'no resources listed';
        },
      },
    ];
  }
  // What each tool's server says of it: read-only, or that every call asks a person
  private hinted = new Map<string, ToolMarks>();
  private results = new SentResults();
  // For file parameters when the runtime gives no reader: the workspace, as the terminal reads
  private files?: Sandbox;
  // The tool names a server may not take (Circle's own tools), as the last load was given them
  private reserved = new Set<string>();
  // Ends the sign-ins under way when the manager closes
  private lifetime = new AbortController();
  // A sign-in under way, by server address: its page
  private signingIn = new Map<string, SignInShown>();
  // A server's tools to list again after it said they changed: the wait, the listing under way, and another notice
  private relisting = new Map<
    Connected,
    { wait?: NodeJS.Timeout; running?: Promise<void>; again?: boolean }
  >();
  // `timeout` bounds connecting a server, 30 seconds unless CIRCLE_MCP_TIMEOUT says otherwise. `callTimeout` is the
  // most a tool call may take where its server's entry gives no `timeout`: about 28 hours unless
  // CIRCLE_MCP_TOOL_TIMEOUT says otherwise. A call also ends when it goes without an answer or a progress notice for
  // the idle limit (idleMs). An interrupt cancels a call at any time.
  constructor(
    readonly workspace: string,
    readonly timeout = envMs('CIRCLE_MCP_TIMEOUT', 30_000),
    readonly callTimeout?: number,
    private readonly services: McpServices = {},
  ) {}
  /**
   * The idle limit of a call: five minutes for a server reached over the network and thirty for a program, unless
   * CIRCLE_MCP_TOOL_IDLE_TIMEOUT says otherwise (0: none). A server's own `timeout` is the least it can be.
   */
  private idleMs(connection: McpConnection): number {
    const fallback =
      connection.transport === 'stdio' ? STDIO_IDLE_MS : REMOTE_IDLE_MS;
    const idle = envMs('CIRCLE_MCP_TOOL_IDLE_TIMEOUT', fallback);
    if (idle === 0) return NO_LIMIT;
    return Math.max(idle, connection.timeout ?? 0);
  }
  /** The most one call of a server may take. */
  private totalMs(connection: McpConnection): number {
    return (
      connection.timeout ??
      this.callTimeout ??
      envMs('CIRCLE_MCP_TOOL_TIMEOUT', DEFAULT_CALL_TIMEOUT_MS)
    );
  }
  /** The waits before sending a call again that surely did not leave this machine (#555). */
  retryWaitsMs: readonly number[] = [500, 1000, 2000];
  /** The waits before connecting a server reached over the network again after its connection dropped: five tries. */
  reconnectWaitsMs: readonly number[] = [1000, 2000, 4000, 8000, 16000];
  /** The waits before trying a server's first connection again after an error that may pass: three more tries. */
  connectWaitsMs: readonly number[] = [1000, 2000, 4000];
  /** The waits before listing a server's tools again after an error that may pass: three more tries. */
  listWaitsMs: readonly number[] = [250, 500, 1000];
  /** How such a wait is made. */
  wait = (ms: number, signal: AbortSignal): Promise<void> =>
    delay(ms, undefined, { signal });
  /** The clock the manager reads: for a program's kept answer, a list's `ttlMs` and a change stream's age. */
  now = (): number => Date.now();
  /**
   * How long a program asked for its revision may take to answer before it is taken for one of the older revision; a
   * third of the time a server has to connect unless set, so the older handshake still fits in it.
   */
  probeMs?: number;
  /**
   * How a server is asked for its revision as it connects (mcp_protocol.ts). A program, and a server reached over
   * Streamable HTTP, is asked unless CIRCLE_MCP_PROTOCOL_NEGOTIATION is `legacy`; an `sse` or `ws` server is not. A
   * program that answered within the last 7 days that it speaks only the older revision is not asked again (unless the
   * setting is `auto`): it is connected with the older handshake at once. What a program answers is kept, where the
   * manager has a home to keep it in.
   */
  private negotiation(connection: McpConnection): {
    ask: boolean;
    probeMs?: number;
    prior?: PriorDiscovery;
    answered: (era: Era | undefined) => void;
  } {
    const setting = negotiationSetting();
    const nothing = (): void => {};
    if (
      setting === 'legacy' ||
      (connection.transport !== 'http' && connection.transport !== 'stdio')
    )
      return { ask: false, answered: nothing };
    if (connection.transport === 'http')
      return { ask: true, answered: nothing };
    const home = this.services.home;
    if (!home)
      return {
        ask: true,
        probeMs: this.probeMs ?? Math.floor(this.timeout / 3),
        answered: nothing,
      };
    const key = programKey({
      command: connection.command!,
      args: connection.args ?? [],
      ...(connection.env ? { env: connection.env } : {}),
      folder: this.workspace,
    });
    if (
      setting === 'default' &&
      rememberedEra(home, key, this.now()) === 'legacy'
    )
      return { ask: false, prior: { kind: 'legacy' }, answered: nothing };
    return {
      ask: true,
      probeMs: this.probeMs ?? Math.floor(this.timeout / 3),
      answered: (era) => {
        if (!era) return;
        try {
          rememberEra(home, key, era, this.now());
        } catch {
          // Not kept: the program is asked again next time
        }
      },
    };
  }
  /**
   * A server on the 2026-07-28 revision tells of changes only on a stream the client holds open
   * (`subscriptions/listen`): Circle holds one open with a server that says its tools can change, and opens it again
   * when it closes. A stream that closes within 10 seconds of opening is opened again three times in a row at most, for
   * this connection; one that stayed open longer is opened again at once, until five were opened again within an hour,
   * and the next after six hours. Until it is open again the server's tools stay as last listed.
   */
  private listenForChanges(server: Connected): void {
    const streams: StreamHistory = { quick: 0, reopened: [] };
    void toolCalls
      .exit(async () => {
        for (;;) {
          if (!server.open) return;
          const opened = this.now();
          let subscription: McpSubscription | undefined;
          try {
            subscription = await server.client.listen(
              { toolsListChanged: true },
              { timeout: this.timeout, signal: this.lifetime.signal },
            );
          } catch {
            // Refused, or not acknowledged in time: a stream that closed at once
          }
          if (subscription && (await subscription.closed) === 'local') return;
          if (!server.open || this.lifetime.signal.aborted) return;
          const next = afterStreamClosed(streams, opened, this.now());
          if (next === 'stop') return;
          if (next > 0) await this.wait(next, this.lifetime.signal);
        }
      })
      .catch(() => {});
  }
  /**
   * The client a call of this server goes out on: its connection now, since a turn keeps the tools it started with
   * when the server is connected again. A connection that ended by itself, as when the server's program exited, is
   * connected again first: nothing was sent on it (#555).
   */
  private async sender(
    connection: McpConnection,
    signal: AbortSignal,
  ): Promise<CircleClient> {
    const live = this.servers.find((item) => item.name === connection.name);
    if (live?.open) return live.client;
    if (!live) {
      const state = this.status.find((item) => item.name === connection.name);
      throw new Error(
        `${connection.name} is not connected${state?.error ? `: ${state.error}` : ''}; /mcp reconnect ${connection.name} connects it again`,
      );
    }
    // Where someone can reconnect it, a program that exited stays failed until they do
    if (this.services.interactive && live.connection.transport === 'stdio')
      throw new Error(
        `the program of ${connection.name} exited; /mcp reconnect ${connection.name} starts it again`,
      );
    const fresh = await abortable(this.connectedAgain(live.connection), signal);
    if (fresh) return fresh;
    const state = this.status.find((item) => item.name === connection.name);
    throw new Error(
      `the connection to ${connection.name} ended and connecting it again failed${state?.error ? `: ${state.error}` : ''}`,
    );
  }
  private readFile(
    path: string,
    context: ToolContext,
    limit: number,
  ): Promise<{ path: string; bytes: Buffer }> {
    if (this.services.readFile)
      return this.services.readFile(path, context, limit);
    this.files ??= new Sandbox(this.workspace);
    return readFileBytes(this.files, undefined, path, context, limit);
  }
  /** One of a server's tools as Circle offers it to the model. */
  private serverTool(
    connection: McpConnection,
    client: Client,
    spec: ServerTool,
    name: string,
    hints: { readOnly: boolean; idempotent: boolean; asksPerson: boolean },
    filled: Map<string, string>,
    validator: AjvJsonSchemaValidator,
  ): Tool {
    const hide = hideFilled(filled);
    const matches = structureCheck(spec.outputSchema, validator);
    const files = fileParameters(spec.inputSchema);
    const limit = connection.maxFileBytes ?? MAX_FILE_BYTES;
    // What a call sent: the session, the server's tool, each file's sha256 and the other
    // arguments. Only an idempotent tool's calls that send files are looked up by it.
    const cacheKey = (
      args: Record<string, unknown>,
      context: ToolContext,
      sent: SentFile[],
    ): string | undefined => {
      if (!hints.idempotent || !sent.length) return undefined;
      const others = Object.fromEntries(
        Object.entries(args).filter(
          ([key]) => !sent.some((file) => file.name === key),
        ),
      );
      return createHash('sha256')
        .update(
          formatJcs([
            this.services.sessionId?.() ?? context.sessionId ?? null,
            connection.name,
            spec.name,
            Object.fromEntries(sent.map((file) => [file.name, file.sha256])),
            others,
          ]),
        )
        .digest('hex');
    };
    // The server is sent each file's bytes; Circle shows the file by path, size and digest.
    // `reuse` is the kept result the card said this call gets, decided before the card.
    const callNow = async (
      args: Record<string, unknown>,
      context: ToolContext,
      sent: SentFile[] = [],
      reuse?: string,
    ): Promise<string> => {
      context.signal.throwIfAborted();
      const key = cacheKey(args, context, sent);
      const sending = { ...args };
      const encoded = sent.map((file) => {
        const base64 = file.bytes.toString('base64');
        sending[file.name] = base64;
        return [base64, file.label] as const;
      });
      // What the server says back: each sent file's base64 as its label and each secret value
      // as its name, in one pass, so neither breaks the other
      const shown = (text: string): string =>
        replaceLongest(text, [...encoded, ...filled]);
      const cached = reuse === undefined ? undefined : this.results.get(reuse);
      // Forgotten while the card was up: sending now is not what the card said
      if (reuse !== undefined && !cached)
        throw new Error(
          `not run: another call reached ${connection.name} after the card said this call would get its earlier result, which may no longer hold; nothing was sent. Call it again to send it.`,
        );
      let result: ToolResult;
      if (cached) result = cached;
      else {
        // A call that may change what the server holds makes what was kept for it untrue,
        // whether it then succeeds, fails or is interrupted
        if (!hints.readOnly) this.results.forget(connection.name);
        try {
          // What the server says of the call's progress, on its row while it runs: on one line, without the values
          // Circle filled in, and only while the call is under way
          let ended = false;
          let last: string | undefined;
          const report = (text: string): void => {
            const line = oneLine(shown(text));
            if (ended || !line || line === last) return;
            last = line;
            context.progress?.(line);
          };
          // While it is under way, a question the server asks may be for it (#556)
          const finished = this.callUnderway(connection.name);
          // A new trace for each call, on the requests made for it
          const store: CallStore = {
            traceparent: traceparent(),
            ...(context.identity ?? {}),
          };
          result = await toolCalls.run(store, async () => {
            // The SDK sends the cancellation from a listener on the signal, which runs
            // where the abort came from, such as a key press: a signal of this call's own,
            // aborted from within the call, keeps the trace on that request too
            const own = new AbortController();
            const forward = AsyncLocalStorage.bind(() =>
              own.abort(context.signal.reason),
            );
            context.signal.addEventListener('abort', forward, { once: true });
            if (context.signal.aborted) forward();
            store.signal = own.signal;
            try {
              // A transport failure (#555). A request that surely never left this machine is sent again, a few
              // times. One that may have reached the server is sent again only for a tool its trusted server says
              // is read-only or idempotent, once, after connecting the server again; any other says it may have.
              let target = await this.sender(connection, own.signal);
              let resent = false;
              let renewed = false;
              const started = this.now();
              // Once the server made a task for the call, the call has reached it: whatever then fails, the session or
              // the connection lost, or the task no longer known, the call is not sent again
              let made = false;
              for (let tries = 0; ; tries++) {
                const attempt = new AbortController();
                const stop = (): void => attempt.abort(own.signal.reason);
                own.signal.addEventListener('abort', stop, { once: true });
                if (own.signal.aborted) stop();
                // The stream its answer was to come on ended without it, and nothing resumes it
                store.lost = (error) => attempt.abort(error);
                try {
                  if (onlyAnOldTask(spec, target))
                    throw new Error(
                      `${spec.name} runs only as a task of the 2025-11-25 revision, which Circle does not run; nothing was sent`,
                    );
                  // The idle limit, which a progress notice starts again, and the most the call may take. The MCP
                  // library looks at the latter only when a notice comes, so the idle limit is never more than it.
                  const total = this.totalMs(connection);
                  const options: RequestOptions = {
                    signal: attempt.signal,
                    timeout: Math.min(this.idleMs(connection), total),
                    resetTimeoutOnProgress: true,
                    maxTotalTimeout: total,
                    // Asks the server for progress notices, shown on the call's row
                    onprogress: (notice) => report(progressText(notice)),
                  };
                  // A call that may be answered with a task says so; the server decides whether it is
                  const asTask = this.takesTasks(target, context);
                  const answered = await callServerTool(
                    target,
                    {
                      name: spec.name,
                      arguments: sending,
                      ...(asTask ? { _meta: TASKS_META } : {}),
                    },
                    options,
                    spec,
                  );
                  const task = asTask ? target.takeTask(answered) : undefined;
                  if (!task) return answered;
                  made = true;
                  return await this.followTask(
                    connection,
                    spec.name,
                    task,
                    {
                      signal: attempt.signal,
                      stopped: own.signal,
                      deadline: started + total,
                      idleMs: this.idleMs(connection),
                    },
                    report,
                  );
                } catch (error) {
                  if (own.signal.aborted || made) throw error;
                  const said =
                    error instanceof Error ? error.message : String(error);
                  if (notSent(error)) {
                    if (tries < this.retryWaitsMs.length) {
                      await this.wait(this.retryWaitsMs[tries]!, own.signal);
                      continue;
                    }
                    throw new Error(
                      `${said} · ${connection.name} could not be reached in ${tries + 1} tries: the request was not sent`,
                      { cause: error },
                    );
                  }
                  // The server forgot the session (HTTP 404 to a request that named it): the request did not run, so it
                  // goes once more on a new session
                  if (!renewed && sessionGone(error, target)) {
                    const fresh = await abortable(
                      this.connectedAgain(connection),
                      own.signal,
                    );
                    if (fresh) {
                      renewed = true;
                      target = fresh;
                      continue;
                    }
                  }
                  if (!droppedAfterSending(error)) throw error;
                  const fresh =
                    !resent && (hints.readOnly || hints.idempotent)
                      ? await abortable(
                          this.resendTarget(connection),
                          own.signal,
                        )
                      : undefined;
                  if (!fresh)
                    throw new Error(
                      `${said} · the connection to ${connection.name} closed before the call was answered: the tool may have run, so Circle did not send it again; check whether it did before calling it again`,
                      { cause: error },
                    );
                  resent = true;
                  target = fresh;
                } finally {
                  own.signal.removeEventListener('abort', stop);
                  store.lost = undefined;
                }
              }
            } finally {
              ended = true;
              finished();
              context.signal.removeEventListener('abort', forward);
            }
          });
        } catch (error) {
          throw hiddenError(error, shown);
        }
        if (key && !result.isError)
          this.results.set(key, connection.name, result);
      }
      const { text, attachments } = resultText(
        result,
        spec.name,
        context,
        connection.name,
      );
      const header = [
        ...(cached ? [CACHED_RESULT] : []),
        ...sent.map(
          (file) => `${file.name}: ${cached ? '' : 'sent '}${file.label}`,
        ),
      ].join('\n');
      const framed = (body: string) => (header ? `${header}\n\n${body}` : body);
      const structured = result.structuredContent;
      // An error is the tool's own word, given as it is: its structure is not checked
      if (result.isError)
        throw new Error(
          framed(
            shown(
              text ||
                (structured === undefined
                  ? 'MCP tool failed'
                  : JSON.stringify(structured)),
            ),
          ),
        );
      context.signal.throwIfAborted();
      if (attachments.length) context.emitAttachments!(attachments);
      // A result unlike the schema the tool was listed with still arrives whole: its text, then its structure with
      // what Circle can say of it. One that matches reads as it always did.
      if (structured !== undefined && matches(structured) === false)
        return framed(
          shown(
            [text, `${UNDECLARED_STRUCTURE}\n${JSON.stringify(structured)}`]
              .filter(Boolean)
              .join('\n\n'),
          ),
        );
      return framed(shown(text || JSON.stringify(structured ?? {})));
    };
    // Where the call runs: here, or on as a background job once it ran a while; and how much of its result the model
    // is given
    const call = (
      args: Record<string, unknown>,
      context: ToolContext,
      sent: SentFile[] = [],
      reuse?: string,
    ): Promise<string> =>
      this.outcome(name, context, (running) =>
        callNow(args, running, sent, reuse),
      );
    // Before the approval: each named file is read under read_file's rules, so the card shows
    // what will be sent, and the call sends those bytes
    const prepare = async (
      args: Record<string, unknown>,
      context: ToolContext,
    ): Promise<PreparedRun> => {
      const sent: SentFile[] = [];
      for (const parameter of files) {
        const path = args[parameter];
        if (path === undefined) continue;
        if (typeof path !== 'string' || !path.trim())
          throw new Error(`${parameter} takes the path of a local file`);
        const { bytes } = await this.readFile(path, context, limit);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        sent.push({
          name: parameter,
          path,
          bytes,
          sha256,
          label: `${path} (${bytes.length} bytes, sha256 ${sha256})`,
        });
      }
      // Decided now, so the card can say that the call sends nothing and gets its earlier
      // result; the call keeps to that
      const key = cacheKey(args, context, sent);
      const reuse =
        key !== undefined && this.results.has(key) ? key : undefined;
      const run: PreparedRun = (given, runContext) => {
        for (const file of sent)
          if (given[file.name] !== file.path)
            throw new Error(`${file.name} is not the file Circle read`);
        return call(given, runContext, sent, reuse);
      };
      if (sent.length)
        run.shown = Object.fromEntries(
          sent.map((file) => [
            file.name,
            reuse ? `${file.label}, ${NOT_SENT}` : file.label,
          ]),
        );
      return run;
    };
    // The paths the call's file parameters name, which hook path globs match
    const named = (args: Record<string, unknown>): string[] =>
      files.flatMap((parameter) => {
        const path = args[parameter];
        return typeof path === 'string' && path.trim() ? [path] : [];
      });
    return {
      name,
      description: hide(spec.description || name),
      parameters: modelSchema(spec.inputSchema, files),
      // Circle cannot see what a server's tool does: a call asks unless a rule allows it, in plan mode too, whatever
      // the server says of it
      effect: 'unknown',
      planAsks: true,
      ...(hints.readOnly ? { parallel: true } : {}),
      ...(hints.asksPerson ? { personApproval: true } : {}),
      ...(files.length
        ? {
            paths: named,
            prepare,
            run: async (args, context) =>
              (await prepare(args, context))(args, context),
          }
        : { run: (args, context) => call(args, context) }),
    };
  }
  /**
   * Connects the configured servers, side by side, and offers their tools. `servers` is an `mcpServers` object, taken
   * as your own, or the entries a run reads (mcp_config.ts). `waiting` lists servers that are not connected for a
   * reason of the run's, such as a `.mcp.json` server that waits for approval.
   */
  async load(
    servers: Record<string, McpServerConfig> | McpEntry[],
    reserved = new Set<string>(),
    signal?: AbortSignal,
    options: { waiting?: McpStatus[]; trusted?: boolean } = {},
  ): Promise<void> {
    const connected: Connected[] = [];
    const tools: Tool[] = [];
    const status: McpStatus[] = [];
    const hinted = new Map<string, ToolMarks>();
    try {
      const { connections, skipped } = buildMcpConnections(servers, {
        trusted: options.trusted,
      });
      status.push(...skipped, ...(options.waiting ?? []));
      this.reserved = reserved;
      signal?.throwIfAborted();
      const outcomes = await Promise.allSettled(
        connections.map((connection) =>
          this.firstConnection(connection, reserved, signal),
        ),
      );
      // In the order they are configured: of two servers whose tools would have one name, the earlier keeps it
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') continue;
        const { state, server } = outcome.value;
        status.push(state);
        if (!server) continue;
        const clash = outcome.value.tools.find((tool) =>
          tools.some((have) => have.name === tool.name),
        );
        if (clash) {
          state.error = `tool '${clash.name}' already exists`;
          state.tools = [];
          await McpManager.disconnect([server]);
          continue;
        }
        connected.push(server);
        tools.push(...outcome.value.tools);
        for (const [name, hint] of outcome.value.said) hinted.set(name, hint);
      }
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed) throw failed.reason;
      signal?.throwIfAborted();
      const previous = this.servers;
      this.servers = connected;
      this.tools = tools;
      this.status = status;
      this.hinted = hinted;
      // A server reached again may not be the one that answered: no result is kept over it
      this.results.clear();
      await McpManager.disconnect(previous);
    } catch (error) {
      await McpManager.disconnect(connected);
      throw error;
    }
  }
  /**
   * A server's first connection. One reached over HTTP or SSE that fails in a way that may pass (a 5xx, a refused
   * connection, a connect timeout) is tried again after each of the connect waits; a program, a ws server, a sign-in
   * and any other failure are not.
   */
  private async firstConnection(
    connection: McpConnection,
    reserved: Set<string>,
    signal?: AbortSignal,
  ): ReturnType<McpManager['connectServer']> {
    for (let tries = 0; ; tries++) {
      const outcome = await this.connectServer(
        connection,
        reserved,
        () => false,
        signal,
      );
      if (
        outcome.server ||
        outcome.state.authorize ||
        (connection.transport !== 'http' && connection.transport !== 'sse') ||
        tries >= this.connectWaitsMs.length ||
        !passing(outcome.failure)
      )
        return outcome;
      await this.wait(
        this.connectWaitsMs[tries]!,
        signal ?? this.lifetime.signal,
      );
    }
  }
  /**
   * One server: connected, with its tools, or why not. A server reached by URL that asks for a sign-in gets one in the
   * browser, which ends without holding up the others.
   */
  private async connectServer(
    connection: McpConnection,
    reserved: Set<string>,
    taken: (name: string) => boolean,
    signal?: AbortSignal,
  ): Promise<{
    state: McpStatus;
    server?: Connected;
    tools: Tool[];
    said: Map<string, ToolMarks>;
    /** Why it did not connect, when it did not. */
    failure?: unknown;
  }> {
    const headerNames = Object.keys(connection.headers ?? {});
    const state: McpStatus = {
      name: connection.name,
      connection: connectionText(connection),
      tools: [],
      error: '',
      scope: connection.scope,
      ...(headerNames.length ? { headers: headerNames } : {}),
      ...(connection.notSent ? { notSent: connection.notSent } : {}),
    };
    // The platform is an extra member of clientInfo, a declaration a server may read or ignore.
    const client = new CircleClient(
      {
        name: 'circle',
        version: VERSION,
        platform: process.platform,
      } as Implementation,
      // A server may ask the person for input in the middle of a call, with a form or by a page to open (#556). Circle
      // says it takes both; where no one can be asked a question is cancelled, unless a hook answers it. The library's
      // own validator is as quiet as the one below that checks a tool's result: it says nothing of a format it has no
      // check for.
      {
        capabilities: CAPABILITIES,
        jsonSchemaValidator: new QuietJsonSchemaValidator(),
      },
    );
    client.setRequestHandler('elicitation/create', (request, context) =>
      this.elicit(
        connection.name,
        request.params as Record<string, unknown>,
        context.mcpReq.signal,
      ),
    );
    let transport: Transport | undefined;
    let provider: McpAuthProvider | undefined;
    const timeout = AbortSignal.timeout(this.timeout);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const stop = () => {
      void client.close().catch(() => {});
      void transport?.close().catch(() => {});
    };
    combined.addEventListener('abort', stop, { once: true });
    // What the server sends back names a header's secret, never its value
    let hide = (text: string): string => text;
    try {
      const filled = await this.resolved(connection, state, combined);
      hide = hideFilled(filled.filled);
      provider = await this.authProvider(connection, filled);
      transport = transportFor(
        connection,
        filled,
        this.workspace,
        requestFetch(this.services.sessionId),
        provider,
      );
      if (transport instanceof StdioClientTransport)
        transport.stderr?.on('data', () => {});
      const negotiation = this.negotiation(connection);
      if (negotiation.ask)
        client.setVersionNegotiation({
          mode: 'auto',
          ...(negotiation.probeMs
            ? { probe: { timeoutMs: negotiation.probeMs } }
            : {}),
        });
      await abortable(
        client.connect(transport, {
          signal: combined,
          timeout: this.timeout,
          ...(negotiation.prior ? { prior: negotiation.prior } : {}),
        }),
        combined,
      );
      negotiation.answered(client.getProtocolEra());
      const { registered, said, specs, ttlMs, listing } =
        await this.listServerTools(
          connection,
          client,
          filled.filled,
          (name) => reserved.has(name) || taken(name),
          combined,
        );
      combined.throwIfAborted();
      const server: Connected = {
        name: connection.name,
        client,
        connection,
        ...(filled.url ? { url: filled.url } : {}),
        instructions: serverInstructions(client.getInstructions(), hide),
        open: true,
        specs,
        filled: filled.filled,
        listedAt: this.now(),
        ...(ttlMs === undefined ? {} : { ttlMs }),
        listing,
      };
      // The server went away: its instructions leave the prompt, /mcp says so, and no
      // result it gave earlier is given again
      client.onclose = () => {
        if (!server.open) return;
        server.open = false;
        this.results.forget(connection.name);
        if (connection.transport !== 'stdio') {
          // A server reached over the network that dropped is connected again, a few times, in the background
          state.error = 'the connection ended; reconnecting';
          this.reconnectDropped(connection);
        } else
          state.error = this.services.interactive
            ? `the program exited; /mcp reconnect ${connection.name} starts it again`
            : 'the program exited; the next call starts it again';
        this.services.onChange?.();
      };
      // A server that says its tools can change is listed again when it says they did: the next turn has the new
      // tools, and the turn under way keeps the ones it started with. One on the 2026-07-28 revision says so only on
      // a stream Circle holds open for it.
      if (client.getServerCapabilities()?.tools?.listChanged) {
        client.setNotificationHandler('notifications/tools/list_changed', () =>
          this.toolsChanged(server),
        );
        if (client.getProtocolEra() === 'modern') this.listenForChanges(server);
      }
      state.tools = registered.map((tool) => tool.name);
      return { state, server, tools: registered, said };
    } catch (error) {
      if (
        error instanceof UnauthorizedError &&
        provider?.authorizationUrl &&
        !signal?.aborted
      )
        this.signIn(connection, provider, state);
      else state.error = hide(failureText(error));
      await client.close().catch(() => {});
      await transport?.close().catch(() => {});
      if (signal?.aborted) throw signal.reason;
      return { state, tools: [], said: new Map(), failure: error };
    } finally {
      combined.removeEventListener('abort', stop);
    }
  }
  /**
   * Circle as an OAuth client of a server reached by URL, kept in the Circle home; none for a server whose entry sends
   * a credential header (that credential is used as written), or without a home to keep it in.
   */
  private async authProvider(
    connection: McpConnection,
    resolved: Resolved,
  ): Promise<McpAuthProvider | undefined> {
    const home = this.services.home;
    if (
      !home ||
      !resolved.url ||
      (connection.transport !== 'http' && connection.transport !== 'sse') ||
      Object.keys(resolved.headers).some(credentialHeader)
    )
      return undefined;
    const server = new URL(resolved.url).href;
    return new McpAuthProvider(home, server, await redirectPort(home, server));
  }
  /**
   * A connection's values as it is made now: its references filled in from the environment and the saved secrets, and
   * the headers its `headersHelper` prints over its own. What is not as meant is in the server's warnings.
   */
  private async resolved(
    connection: McpConnection,
    state: McpStatus,
    signal: AbortSignal,
  ): Promise<Resolved> {
    const resolved = resolveConnection(
      connection,
      process.env,
      this.services.secrets?.() ?? {},
    );
    const warnings = [...resolved.missing];
    if (connection.headersHelper) {
      if (!connection.trusted)
        warnings.push(
          'headersHelper not run: the folder is not trusted, so the server is reached with its own headers only',
        );
      else {
        const given = await runHeadersHelper(connection.headersHelper, {
          folder: connection.folder || this.workspace,
          server: connection.name,
          url: connectionText(connection),
          own: connection.scope !== 'project',
          signal,
        });
        for (const [name, value] of Object.entries(given)) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
            throw new Error(
              `headersHelper gave an invalid header name '${name}'`,
            );
          if (/[\r\n\0]/.test(value))
            throw new Error(
              `headersHelper gave header ${name} a line break or NUL in its value`,
            );
          if (OWN_HEADERS.has(name.toLowerCase())) continue;
          // Its values are never shown: a server that says one back reads as its header's name
          if (value && credentialHeader(name))
            resolved.filled.set(value, `<${name} from headersHelper>`);
          const same = Object.keys(resolved.headers).find(
            (key) => key.toLowerCase() === name.toLowerCase(),
          );
          if (same) delete resolved.headers[same];
          resolved.headers[name] = value;
        }
      }
    }
    if (warnings.length) state.warnings = warnings;
    else delete state.warnings;
    return resolved;
  }
  /**
   * The sign-in of a server that answered 401. When its authorization server offers the device code (RFC 8628), Circle
   * shows a user code with the address of the page it is typed on, opens that page, and polls until a person approved
   * or refused it there: nothing has to come back to this machine. Otherwise, or when the server gives no device code,
   * the browser sign-in: the page opens in the system browser (and /mcp shows its address in case none opens), Circle
   * waits on its loopback address for the redirect and exchanges the code for tokens. Either way the server is connected
   * again. One sign-in per server at a time; a reload meanwhile shows the one under way.
   */
  private signIn(
    connection: McpConnection,
    provider: McpAuthProvider,
    state: McpStatus,
  ): void {
    const pending = this.signingIn.get(provider.server);
    const show = (shown: SignInShown, current: McpStatus): void => {
      current.error = shown.error;
      current.authorize = shown.authorize;
      if (shown.code) current.code = shown.code;
      else delete current.code;
    };
    if (pending) return show(pending, state);
    const url = provider.authorizationUrl!.href;
    const shown: SignInShown = { error: SIGN_IN_WAITING, authorize: url };
    show(shown, state);
    this.signingIn.set(provider.server, shown);
    const lifetime = this.lifetime.signal;
    const discovery = provider.discoveryState();
    const device = deviceEndpoint(discovery);
    const tokenEndpoint =
      discovery?.authorizationServerMetadata?.token_endpoint;
    const clientId = provider.clientInformation()?.client_id;
    const resource = discovery?.resourceMetadata?.resource ?? provider.server;
    void (async () => {
      if (device && tokenEndpoint && clientId) {
        const authorization = await startDeviceAuthorization(
          device,
          clientId,
          resource,
          fetch,
          lifetime,
        ).catch((error: unknown) => {
          // A server that gives no device code is signed in to in the browser instead
          if (lifetime.aborted) throw error;
          return undefined;
        });
        if (authorization) {
          shown.error = deviceSignInWaiting(authorization.userCode);
          shown.authorize =
            authorization.verificationUriComplete ??
            authorization.verificationUri;
          shown.code = authorization.userCode;
          show(
            shown,
            this.status.find((item) => item.name === connection.name) ?? state,
          );
          this.services.onChange?.();
          await (this.services.openUrl ?? openInBrowser)(shown.authorize).catch(
            () => {},
          );
          const tokens = await pollDeviceToken(
            tokenEndpoint,
            clientId,
            resource,
            authorization,
            fetch,
            lifetime,
          );
          // The sign-in under way makes these the tokens of a new grant
          provider.saveTokens(tokens);
          await this.connectAgain(connection, lifetime);
          return;
        }
      }
      const redirect = startRedirect(
        provider.port,
        () => provider.expectedState,
        lifetime,
      );
      // Handled from now: a refusal may come while the browser is being opened
      redirect.callback.catch(() => {});
      await redirect.ready;
      await (this.services.openUrl ?? openInBrowser)(url).catch(() => {});
      const callback = await redirect.callback;
      const exchange = transportFor(
        connection,
        { headers: {}, filled: new Map(), missing: [], url: provider.server },
        this.workspace,
        requestFetch(this.services.sessionId),
        provider,
      ) as StreamableHTTPClientTransport | SSEClientTransport;
      try {
        // The code with the issuer it came from, which the library checks before it redeems the code (RFC 9207)
        await exchange.finishAuth(callback);
      } finally {
        await exchange.close().catch(() => {});
      }
      await this.connectAgain(connection, lifetime);
    })()
      .catch((error: unknown) => {
        if (lifetime.aborted) return;
        const current =
          this.status.find((item) => item.name === connection.name) ?? state;
        current.error = `sign-in failed: ${error instanceof Error ? error.message : String(error)}`;
        delete current.authorize;
        delete current.code;
        this.services.onChange?.();
      })
      .finally(() => this.signingIn.delete(provider.server));
  }
  /**
   * A server's tools as it lists them now, page by page, each page tried again as a listing that may pass is: Circle
   * walks the pages itself, so a cursor that comes again ends the listing with an error rather than a loop. One
   * validator per listing: a schema with an $id is kept by it, and a server that changed has new schemas.
   */
  private async listServerTools(
    connection: McpConnection,
    client: Client,
    filled: Map<string, string>,
    taken: (name: string) => boolean,
    signal: AbortSignal,
  ): Promise<{
    registered: Tool[];
    said: Map<string, ToolMarks>;
    specs: Map<string, ServerTool>;
    /** How long the list stays good, when the server said so on its first page. */
    ttlMs?: number;
    /** A digest of what it listed. */
    listing: string;
  }> {
    const registered: Tool[] = [];
    const said = new Map<string, ToolMarks>();
    const specs = new Map<string, ServerTool>();
    const validator = new QuietJsonSchemaValidator();
    const digest = createHash('sha256');
    let ttlMs: number | undefined;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const listed = await this.passingRetry(
        () =>
          client.request(
            { method: 'tools/list', params: cursor ? { cursor } : undefined },
            ListToolsResultSchema,
            { signal, timeout: this.timeout },
          ),
        this.listWaitsMs,
        signal,
      );
      digest.update(JSON.stringify(listed.tools));
      const ttl = (listed as Record<string, unknown>).ttlMs;
      if (
        !cursors.size &&
        typeof ttl === 'number' &&
        Number.isSafeInteger(ttl) &&
        ttl >= 0
      )
        ttlMs = ttl;
      for (const spec of listed.tools) {
        const name = mcpToolName(connection.name, spec.name);
        if (taken(name) || registered.some((tool) => tool.name === name))
          throw new Error(`tool '${name}' already exists`);
        const hints = toolHints(spec);
        said.set(name, {
          readOnly: hints.readOnly,
          asksPerson: hints.asksPerson,
          server: connection.name,
          tool: spec.name,
        });
        specs.set(spec.name, spec);
        registered.push(
          this.serverTool(
            connection,
            client,
            spec,
            name,
            hints,
            filled,
            validator,
          ),
        );
      }
      cursor = listed.nextCursor;
      if (cursor) {
        if (cursors.has(cursor))
          throw new Error('MCP tools pagination repeated a cursor');
        cursors.add(cursor);
      }
    } while (cursor);
    return {
      registered,
      said,
      specs,
      ...(ttlMs === undefined ? {} : { ttlMs }),
      listing: digest.digest('hex'),
    };
  }
  /** A server said its tools changed: they are listed again a moment later, once for several notices in a row. */
  private toolsChanged(server: Connected): void {
    if (!server.open) return;
    let pending = this.relisting.get(server);
    if (!pending) this.relisting.set(server, (pending = {}));
    if (pending.running) {
      pending.again = true;
      return;
    }
    clearTimeout(pending.wait);
    const own = pending;
    own.wait = setTimeout(() => {
      own.wait = undefined;
      own.running = this.listAgain(server, 'changed').finally(() => {
        own.running = undefined;
        if (own.again) {
          own.again = false;
          this.toolsChanged(server);
        } else if (this.relisting.get(server) === own)
          this.relisting.delete(server);
      });
    }, TOOLS_CHANGED_WAIT_MS);
    own.wait.unref?.();
  }
  /** A server's list of tools outlived its `ttlMs`: it is listed again now, or the listing under way is waited for. */
  private listExpired(server: Connected): Promise<void> {
    let pending = this.relisting.get(server);
    if (pending?.running) return pending.running;
    if (!pending) this.relisting.set(server, (pending = {}));
    const own = pending;
    own.running = this.listAgain(server, 'expired').finally(() => {
      own.running = undefined;
      if (own.again) {
        own.again = false;
        this.toolsChanged(server);
      } else if (!own.wait && this.relisting.get(server) === own)
        this.relisting.delete(server);
    });
    return own.running;
  }
  /**
   * Lists the tools again of each server whose last list has outlived the `ttlMs` it came with (2026-07-28; at most a
   * day is believed), before a turn starts, so the turn offers what the server lists now. A server that gave no `ttlMs`
   * is listed again only when it says its tools changed, or is reconnected. The turn waits for these listings at most
   * ttlWaitMs: one still under way then gives a later turn its tools, and no turn waits for it again. A listing that
   * fails keeps the earlier tools.
   */
  async refreshExpired(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const listings = this.servers
      .filter(
        (server) =>
          server.open &&
          server.ttlMs !== undefined &&
          now - server.listedAt >= Math.min(server.ttlMs, MAX_LIST_TTL_MS),
      )
      .map((server) => this.listExpired(server))
      // One a turn already waited for as long as it waits is not waited for again: a server that stopped answering
      // costs one turn that wait, not every turn until the listing ends
      .filter((listing) => !this.waitedOut.has(listing));
    if (!listings.length) return;
    const settled = new Set<Promise<void>>();
    for (const listing of listings)
      void listing.then(
        () => settled.add(listing),
        () => settled.add(listing),
      );
    const waited = new AbortController();
    try {
      await Promise.race([
        Promise.allSettled(listings),
        delay(this.ttlWaitMs, undefined, {
          signal: signal
            ? AbortSignal.any([signal, waited.signal])
            : waited.signal,
          ref: false,
        }).catch(() => {}),
      ]);
    } finally {
      waited.abort();
      if (!signal?.aborted)
        for (const listing of listings)
          if (!settled.has(listing)) this.waitedOut.add(listing);
    }
  }
  /** Listings a turn waited for until ttlWaitMs ran out, which the next turns do not wait for again. */
  private waitedOut = new WeakSet<Promise<void>>();
  /** How long a turn waits for the listings refreshExpired starts. */
  ttlWaitMs = 5_000;
  /**
   * The server's tools, status and kept results replaced by what it lists now, all at once, when it said they changed
   * or its list expired. When the listing fails, its earlier tools stay and its status says so. A list that expired and
   * comes back the same changes nothing: its tools and the results kept for them stay.
   */
  private async listAgain(
    server: Connected,
    why: 'changed' | 'expired',
  ): Promise<void> {
    const current = () => server.open && this.servers.includes(server);
    if (!current()) return;
    const state = this.status.find((item) => item.name === server.name);
    const own = new Set(state?.tools ?? []);
    const noted = (): boolean =>
      state?.error === TOOLS_NOT_LISTED_AGAIN ||
      state?.error === TOOLS_EXPIRED_NOT_LISTED;
    try {
      const listed = await this.listServerTools(
        server.connection,
        server.client,
        server.filled,
        (name) =>
          this.reserved.has(name) ||
          this.tools.some((tool) => tool.name === name && !own.has(name)),
        AbortSignal.any([
          AbortSignal.timeout(this.timeout),
          this.lifetime.signal,
        ]),
      );
      if (!current()) return;
      server.listedAt = this.now();
      if (listed.ttlMs === undefined) delete server.ttlMs;
      else server.ttlMs = listed.ttlMs;
      if (why === 'expired' && listed.listing === server.listing && !noted())
        return;
      server.listing = listed.listing;
      this.tools = [
        ...this.tools.filter((tool) => !own.has(tool.name)),
        ...listed.registered,
      ];
      server.specs = listed.specs;
      for (const name of own) this.hinted.delete(name);
      for (const [name, hint] of listed.said) this.hinted.set(name, hint);
      if (state) {
        state.tools = listed.registered.map((tool) => tool.name);
        if (noted()) state.error = '';
      }
    } catch {
      if (!current()) return;
      if (state)
        state.error =
          why === 'changed' ? TOOLS_NOT_LISTED_AGAIN : TOOLS_EXPIRED_NOT_LISTED;
    }
    // What a tool of the server returned before may not hold for the tools it has now
    this.results.forget(server.name);
    this.services.onChange?.();
  }
  /**
   * Whether a call may be answered with a task (the 2026-07-28 tasks extension): a call of the conversation itself, not
   * a subagent's, in an interactive session, to a server on that revision that says it runs tasks.
   */
  private takesTasks(client: CircleClient, context: ToolContext): boolean {
    const extensions = client.getServerCapabilities()?.extensions;
    return Boolean(
      this.services.interactive &&
      !context.identity?.agentId &&
      client.getProtocolEra() === 'modern' &&
      isRecord(extensions?.[TASKS_EXTENSION]),
    );
  }
  /**
   * A call its server answered with a task (the 2026-07-28 tasks extension), followed until the task ends: Circle asks
   * how it stands with `tasks/get` as far apart as the server says (`pollIntervalMs`, kept between 250 ms and 30
   * seconds, and 2 seconds when it says nothing) and shows it on the call's row; answers the questions it asks
   * (`input_required`) with `tasks/update`; and gives the call the task's result, or says why there is none. Stopping
   * the call (esc, or stopping the job it went on as) sends `tasks/cancel`, and so do its time limits: the most the call
   * may take from its start, and its idle limit, which each answer to `tasks/get` starts again. A status request that is
   * not answered is made again while the limits allow. Once the server made the task, the call has reached it and is
   * never sent again: a session the server lost (HTTP 404) or a connection that cannot be made again while the task
   * runs, and a task the server no longer knows (-32602), end the call with what Circle can say of it.
   */
  private async followTask(
    connection: McpConnection,
    tool: string,
    answer: Record<string, unknown>,
    limits: {
      signal: AbortSignal;
      stopped: AbortSignal;
      deadline: number;
      idleMs: number;
    },
    show: (text: string) => void,
  ): Promise<ToolResult> {
    const server = connection.name;
    const { signal } = limits;
    let task = taskState(answer, server, tool);
    const { taskId } = task;
    let cancelling = false;
    // Asks the server to cancel the task, once, on its connection of the moment; what it does then is the server's
    const cancel = (): void => {
      if (cancelling) return;
      cancelling = true;
      const live = this.servers.find(
        (item) => item.name === server && item.open,
      );
      void live?.client
        .request(
          { method: 'tasks/cancel', params: { taskId, _meta: TASKS_META } },
          JSONObjectSchema,
          { timeout: this.timeout },
        )
        .catch(() => {});
    };
    limits.stopped.addEventListener('abort', cancel, { once: true });
    if (limits.stopped.aborted) cancel();
    const answered = new Set<string>();
    let heard = this.now();
    try {
      for (;;) {
        show(taskText(task));
        if (task.status === 'completed') {
          const result = CallToolResultSchema.safeParse(task.result);
          if (!result.success)
            throw new Error(
              `task ${taskId} of ${server} completed without a result Circle can read`,
            );
          return result.data as ToolResult;
        }
        if (task.status === 'failed')
          throw new Error(
            isRecord(task.error) && typeof task.error.message === 'string'
              ? task.error.message
              : (task.statusMessage ?? 'Task failed'),
          );
        if (task.status === 'cancelled')
          throw new Error(
            task.statusMessage ?? 'Task was cancelled by the server',
          );
        if (!TASK_STATUSES.has(task.status)) {
          cancel();
          throw new Error(
            `task ${taskId} of ${server} has a status Circle does not know (${JSON.stringify(task.status)}); Circle asked the server to cancel it`,
          );
        }
        if (task.status === 'input_required')
          await this.answerTask(connection, task, answered, signal, cancel);
        const interval = Math.min(
          Math.max(task.pollIntervalMs ?? TASK_POLL_MS, TASK_POLL_MIN_MS),
          TASK_POLL_MAX_MS,
        );
        for (;;) {
          await this.wait(interval, signal);
          const left = Math.min(
            limits.deadline - this.now(),
            limits.idleMs - (this.now() - heard),
          );
          if (left <= 0) {
            cancel();
            throw new Error(
              `task ${taskId} of ${server} ran past the call's time limit; Circle asked the server to cancel it`,
            );
          }
          try {
            const client = await this.taskClient(connection, taskId, signal);
            task = taskState(
              await client.request(
                { method: 'tasks/get', params: { taskId, _meta: TASKS_META } },
                JSONObjectSchema,
                { signal, timeout: Math.min(left, this.timeout) },
              ),
              server,
              tool,
            );
            heard = this.now();
            break;
          } catch (error) {
            if (signal.aborted || error instanceof TaskLost) throw error;
            if (unknownTask(error))
              throw new Error(
                `${server} no longer knows task ${taskId}: its outcome is unknown. Calling the tool again may do the work twice; find out from the server what was done first`,
              );
            if (httpStatus(error) === 404)
              throw new TaskLost(
                taskLost('the server lost the session', taskId),
              );
            // Not answered, as when the server or the way to it is busy: asked again while the limits allow
            if (
              !passing(error) &&
              !droppedAfterSending(error) &&
              !timedOut(error)
            )
              throw error;
          }
        }
      }
    } finally {
      limits.stopped.removeEventListener('abort', cancel);
    }
  }
  /**
   * The client a task's requests go out on: the server's connection of the moment, connected again where it can be;
   * else the task is lost to Circle.
   */
  private async taskClient(
    connection: McpConnection,
    taskId: string,
    signal: AbortSignal,
  ): Promise<CircleClient> {
    try {
      return await this.sender(connection, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new TaskLost(
        taskLost(`the connection to ${connection.name} ended`, taskId),
        { cause: error },
      );
    }
  }
  /**
   * The questions a task asks (`inputRequests`), each answered once, as a server's question in a call is, and the answers
   * sent with `tasks/update`, at most MAX_TASK_INPUTS of a task. A question other than `elicitation/create`, or answers
   * that cannot be sent, have Circle ask the server to cancel the task, and the call fails.
   */
  private async answerTask(
    connection: McpConnection,
    task: TaskState,
    answered: Set<string>,
    signal: AbortSignal,
    cancel: () => void,
  ): Promise<void> {
    const server = connection.name;
    const requests = isRecord(task.inputRequests) ? task.inputRequests : {};
    const responses: Record<string, ElicitResult> = {};
    for (const [key, request] of Object.entries(requests)) {
      if (answered.has(key)) continue;
      if (answered.size >= MAX_TASK_INPUTS) break;
      answered.add(key);
      if (
        !isRecord(request) ||
        request.method !== 'elicitation/create' ||
        !isRecord(request.params)
      ) {
        cancel();
        throw new Error(
          `task ${task.taskId} of ${server} asks for ${isRecord(request) && typeof request.method === 'string' ? request.method : 'what it does not name'}, which Circle does not answer; Circle asked the server to cancel the task`,
        );
      }
      responses[key] = await this.elicit(server, request.params, signal);
    }
    if (!Object.keys(responses).length) return;
    for (let tries = 0; ; tries++) {
      try {
        const client = await this.taskClient(connection, task.taskId, signal);
        await client.request(
          {
            method: 'tasks/update',
            params: {
              taskId: task.taskId,
              inputResponses: responses,
              _meta: TASKS_META,
            },
          },
          JSONObjectSchema,
          { signal, timeout: this.timeout },
        );
        return;
      } catch (error) {
        if (signal.aborted || error instanceof TaskLost) throw error;
        if (unknownTask(error))
          throw new Error(
            `${server} no longer knows task ${task.taskId}: its outcome is unknown. Calling the tool again may do the work twice; find out from the server what was done first`,
          );
        if (httpStatus(error) === 404)
          throw new TaskLost(
            taskLost('the server lost the session', task.taskId),
          );
        if (
          (passing(error) || droppedAfterSending(error) || timedOut(error)) &&
          tries < this.retryWaitsMs.length
        ) {
          await this.wait(this.retryWaitsMs[tries]!, signal);
          continue;
        }
        cancel();
        throw new Error(
          `the answers to task ${task.taskId} of ${server} could not be sent (${error instanceof Error ? error.message : String(error)}); Circle asked the server to cancel the task`,
          { cause: error },
        );
      }
    }
  }
  /** The calls under way to each server: a question from a server is withdrawn once none of them is (#556). */
  private underway = new Map<
    string,
    { calls: number; idle: AbortController }
  >();
  private callUnderway(server: string): () => void {
    const entry = this.underway.get(server) ?? {
      calls: 0,
      idle: new AbortController(),
    };
    this.underway.set(server, entry);
    entry.calls++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--entry.calls > 0) return;
      this.underway.delete(server);
      entry.idle.abort();
    };
  }
  /**
   * A server's question in the middle of a call (#556). An Elicitation hook may answer it in the person's place;
   * otherwise a form is asked in the question panel, a question for each field and then whether to send the answers,
   * and a page to open is asked about before it opens. Then the ElicitationResult hooks may change or block the
   * answer. Closing the panel, esc on the call, or the server's own cancellation cancels it, and so does a run where
   * no one can be asked.
   */
  private async elicit(
    server: string,
    params: Record<string, unknown>,
    cancelled: AbortSignal,
  ): Promise<ElicitResult> {
    // The call it came with, when its answer's stream brought it; and in any case once no call to the server is under
    // way, as a program's question comes on a stream of its own
    const call = toolCalls.getStore()?.signal;
    const idle = this.underway.get(server)?.idle.signal;
    const signal = AbortSignal.any([
      cancelled,
      this.lifetime.signal,
      ...(call ? [call] : []),
      ...(idle ? [idle] : []),
    ]);
    const mode = params.mode === 'url' ? 'url' : 'form';
    const request: ElicitationRequest = {
      server,
      mode,
      message: typeof params.message === 'string' ? params.message : '',
      ...(mode === 'url' && typeof params.url === 'string'
        ? { url: params.url }
        : {}),
      ...(typeof params.elicitationId === 'string'
        ? { elicitationId: params.elicitationId }
        : {}),
      ...(mode === 'form' && params.requestedSchema !== undefined
        ? { requestedSchema: params.requestedSchema }
        : {}),
    };
    const hooks = this.services.elicitationHooks;
    const hooked = await hooks?.before(request, signal).catch(() => undefined);
    // A hook's answer goes as it is: the ElicitationResult hooks do not run for it
    if (hooked) return elicitResult(hooked, mode);
    const answered =
      mode === 'url'
        ? await this.askToOpen(request, signal)
        : await this.askForm(server, request, signal);
    const changed = await hooks
      ?.after(request, answered, signal)
      .catch(() => undefined);
    return elicitResult(changed ?? answered, mode);
  }
  /** A question asked in the panel; it holds the move of the call it came with to the background while it is open. */
  private async askPanel(
    questions: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const ask = this.services.ask;
    if (!ask) return undefined;
    const question = ask(questions, signal);
    this.openQuestions.add(question);
    try {
      const reply = await question;
      return signal.aborted ? undefined : reply;
    } catch (error) {
      if (signal.aborted) return undefined;
      throw error;
    } finally {
      this.openQuestions.delete(question);
    }
  }
  /** A form, asked field by field until the answers fit it. */
  private async askForm(
    server: string,
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<ElicitationAnswer> {
    const fields = elicitationFields(request.requestedSchema);
    let problems: string[] = [];
    for (;;) {
      const reply = await this.askPanel(
        {
          questions: elicitationQuestions(
            server,
            request.message,
            fields,
            problems,
          ),
        },
        signal,
      );
      if (reply === undefined) return { action: 'cancel' };
      const outcome = elicitationOutcome(fields, reply);
      if (outcome.action !== 'again') return outcome;
      problems = outcome.problems;
    }
  }
  /** A page a server asks the person to open: opened in the browser once they say so. */
  private async askToOpen(
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<ElicitationAnswer> {
    let page: URL;
    try {
      page = new URL(request.url ?? '');
    } catch {
      return { action: 'decline' };
    }
    if (page.protocol !== 'https:' && page.protocol !== 'http:')
      return { action: 'decline' };
    const reply = await this.askPanel(
      { questions: [openPageQuestion(request.server, request.message, page)] },
      signal,
    );
    const choice = reply === undefined ? undefined : firstAnswer(reply);
    if (choice === OPEN) {
      await (this.services.openUrl ?? openInBrowser)(page.href).catch(() => {});
      return { action: 'accept' };
    }
    return { action: choice === DECLINE_PAGE ? 'decline' : 'cancel' };
  }
  /**
   * Where a call cut after it was sent goes once more: the server's connection when it is still open, as an HTTP one
   * is after one request's socket was cut, so the other calls on it go on; otherwise the server connected again.
   * Nothing, when the server is gone.
   */
  private async resendTarget(
    connection: McpConnection,
  ): Promise<CircleClient | undefined> {
    const live = this.servers.find((item) => item.name === connection.name);
    if (!live) return undefined;
    return live.open ? live.client : this.connectedAgain(live.connection);
  }
  /** How long a call of the conversation runs before it goes on as a background job; 0: it never does. */
  autoBackgroundMs = envMs('CIRCLE_MCP_AUTO_BACKGROUND_MS', AUTO_BACKGROUND_MS);
  /** The questions servers ask that are open now: a call waiting on one is not moved to the background. */
  private openQuestions = new Set<Promise<unknown>>();
  /**
   * Runs a call. In an interactive session a call of the conversation itself (not a subagent's) that still runs after
   * autoBackgroundMs goes on as a background job: the model is told the job's id at once and reads the call's result
   * in the job's notice; stopping the job cancels the call. A call a server's open question holds up moves once the
   * question is answered. The result of a call that ends where it was made is given whole up to MAX_RESULT_CHARS
   * characters and MAX_RESULT_TOKENS tokens (CIRCLE_MAX_MCP_OUTPUT_TOKENS); a longer one, without pictures, is kept
   * in a file and the model is told its path.
   */
  private async outcome(
    tool: string,
    context: ToolContext,
    run: (context: ToolContext) => Promise<string>,
  ): Promise<string> {
    let attached = false;
    let moved = false;
    let progress = context.progress;
    const own = new AbortController();
    const forward = (): void => own.abort(context.signal.reason);
    context.signal.addEventListener('abort', forward, { once: true });
    if (context.signal.aborted) forward();
    const running = run({
      ...context,
      signal: own.signal,
      progress: (text) => progress?.(text),
      ...(context.emitAttachments
        ? {
            emitAttachments: (items) => {
              // The turn has ended for a call in the background: what it shows goes nowhere
              if (moved) return;
              attached = true;
              context.emitAttachments!(items);
            },
          }
        : {}),
    });
    const background = this.services.background;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (
        !background ||
        !this.services.interactive ||
        context.identity?.agentId ||
        !this.autoBackgroundMs
      )
        return this.limited(tool, await running, attached);
      const first = await Promise.race([
        running.then((text) => ({ text })),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.autoBackgroundMs);
          timer.unref?.();
        }),
      ]);
      if (first) return this.limited(tool, first.text, attached);
      // A question the server asks holds the move until it is answered
      while (this.openQuestions.size) {
        const ended = await Promise.race([
          running.then(
            () => true,
            () => true,
          ),
          Promise.allSettled([...this.openQuestions]).then(() => false),
        ]);
        if (ended) return this.limited(tool, await running, attached);
      }
      if (context.signal.aborted)
        return this.limited(tool, await running, attached);
      let job: Job;
      try {
        job = background(
          tool,
          { sessionId: context.sessionId, startedBy: 'model' },
          (signal, log) => {
            const stop = (): void => own.abort(signal.reason);
            signal.addEventListener('abort', stop, { once: true });
            if (signal.aborted) stop();
            progress = log;
            // The notice gives the result as the model would have read it here: whole, or kept in a file
            return running.then((text) => this.limited(tool, text, attached));
          },
        );
      } catch {
        // No room for another job: the call goes on here
        return this.limited(tool, await running, attached);
      }
      moved = true;
      context.signal.removeEventListener('abort', forward);
      // Its result is the job's, read in its notice: nothing waits for it here
      running.catch(() => {});
      return `${tool} was still running after ${Math.round(this.autoBackgroundMs / 1000)} seconds, so it goes on as background job ${job.id}; its result arrives in a notice when it ends. Do not poll or sleep for it. stop_job stops it, though the server may already have done some of the work.`;
    } finally {
      clearTimeout(timer);
      if (!moved) context.signal.removeEventListener('abort', forward);
    }
  }
  /** A result as the model is given it: whole, or, when too large and without pictures, the path of the file it is kept in. */
  private limited(tool: string, text: string, attached: boolean): string {
    const save = this.services.saveResult;
    if (!save || attached) return text;
    const most = envMs('CIRCLE_MAX_MCP_OUTPUT_TOKENS', MAX_RESULT_TOKENS);
    const tokens = tokenLen(text);
    if (text.length <= MAX_RESULT_CHARS && tokens <= most) return text;
    const path = save(text, tool);
    return `The result of ${tool} is too large to give here (${text.length} characters, about ${tokens} tokens), so it was kept in full in ${path}. Read the parts you need with read_file, with offset and limit, or search it with grep.`;
  }
  /** A request made again after each of `waits` while it fails in a way that may pass (`passing`). */
  private async passingRetry<T>(
    request: () => Promise<T>,
    waits: readonly number[],
    signal: AbortSignal,
  ): Promise<T> {
    for (let tries = 0; ; tries++) {
      try {
        return await request();
      } catch (error) {
        if (signal.aborted || tries >= waits.length || !passing(error))
          throw error;
        await this.wait(waits[tries]!, signal);
      }
    }
  }
  /**
   * A server reached over the network whose connection dropped: connected again in the background, after each of the
   * reconnect waits, until it is back. A call meanwhile waits for it. After the last try the server is failed, and
   * `/mcp reconnect` tries again.
   */
  private reconnectDropped(connection: McpConnection): void {
    if (this.reconnects.has(connection.name)) return;
    const lifetime = this.lifetime.signal;
    const reconnect = toolCalls.exit(async () => {
      try {
        for (const [index, ms] of this.reconnectWaitsMs.entries()) {
          await this.wait(ms, lifetime);
          await this.connectAgain(connection, lifetime);
          const back = this.servers.find(
            (server) => server.name === connection.name && server.open,
          );
          if (back) return back.client;
          const state = this.status.find(
            (item) => item.name === connection.name,
          );
          // A server that asks for a sign-in waits for it, as at its first connection
          if (state?.authorize) return undefined;
          if (state && index < this.reconnectWaitsMs.length - 1)
            state.error = `the connection ended; reconnecting (${index + 1} of ${this.reconnectWaitsMs.length} tries failed: ${state.error})`;
          this.services.onChange?.();
        }
        const state = this.status.find((item) => item.name === connection.name);
        if (state)
          state.error = `disconnected: ${this.reconnectWaitsMs.length} tries to connect again failed${state.error ? ` (${state.error})` : ''}; /mcp reconnect ${connection.name} tries again`;
        this.services.onChange?.();
        return undefined;
      } catch {
        return undefined;
      } finally {
        this.reconnects.delete(connection.name);
      }
    });
    this.reconnects.set(connection.name, reconnect);
  }
  private reconnects = new Map<string, Promise<CircleClient | undefined>>();
  /**
   * Connects a server again for calls to be sent on, and gives its new client, or nothing if it is not back: once for
   * all the calls that need it at the same time. It runs outside the call that asked, since the connection outlives
   * that call: its requests and its streams carry no call's trace or identity.
   */
  private connectedAgain(
    connection: McpConnection,
  ): Promise<CircleClient | undefined> {
    const running = this.reconnects.get(connection.name);
    if (running) return running;
    const reconnect = toolCalls.exit(async () => {
      try {
        await this.connectAgain(connection, this.lifetime.signal);
      } catch {
        return undefined;
      } finally {
        this.reconnects.delete(connection.name);
      }
      return this.servers.find(
        (server) => server.name === connection.name && server.open,
      )?.client;
    });
    this.reconnects.set(connection.name, reconnect);
    return reconnect;
  }
  /**
   * One server again, from its entry as the settings have it now: connected again and its tools listed again, while
   * the other servers, and the programs started for them, stay as they are (#559). Without an entry the server is
   * left: closed, and its tools gone.
   */
  async reloadServer(
    name: string,
    entries: Record<string, McpServerConfig> | McpEntry[],
    options: { waiting?: McpStatus[]; trusted?: boolean } = {},
  ): Promise<void> {
    const { connections, skipped } = buildMcpConnections(entries, {
      trusted: options.trusted,
    });
    skipped.push(...(options.waiting ?? []));
    const connection = connections.find((item) => item.name === name);
    if (
      !connection &&
      !skipped.some((item) => item.name === name) &&
      !this.status.some((item) => item.name === name)
    )
      throw new Error(`no MCP server named ${name}`);
    if (connection) {
      await this.connectAgain(connection, this.lifetime.signal);
      return;
    }
    // Not to be connected (removed, turned off, or not valid): what it had goes, and the status says why
    const before = this.status.find((item) => item.name === name);
    const own = new Set(before?.tools ?? []);
    const replaced = this.servers.filter((item) => item.name === name);
    this.servers = this.servers.filter((item) => item.name !== name);
    this.tools = this.tools.filter((tool) => !own.has(tool.name));
    for (const tool of own) this.hinted.delete(tool);
    const state = skipped.find((item) => item.name === name);
    this.status = [
      ...this.status.filter((item) => item.name !== name),
      ...(state ? [state] : []),
    ];
    this.results.forget(name);
    await McpManager.disconnect(replaced);
    this.services.onChange?.();
  }
  /**
   * A server connected again, after a sign-in with its tokens, for a reload of it alone or for a call (#555): its
   * status, connection and tools replace the old.
   */
  private async connectAgain(
    connection: McpConnection,
    lifetime: AbortSignal,
  ): Promise<void> {
    const before = this.status.find((item) => item.name === connection.name);
    const own = new Set(before?.tools ?? []);
    const outcome = await this.connectServer(
      connection,
      this.reserved,
      (name) => this.tools.some((tool) => tool.name === name && !own.has(name)),
      lifetime,
    );
    if (lifetime.aborted) {
      if (outcome.server) await McpManager.disconnect([outcome.server]);
      return;
    }
    const index = this.status.findIndex(
      (item) => item.name === connection.name,
    );
    if (index >= 0) this.status[index] = outcome.state;
    else this.status.push(outcome.state);
    const replaced = this.servers.filter(
      (item) => item.name === connection.name,
    );
    this.servers = [
      ...this.servers.filter((item) => item.name !== connection.name),
      ...(outcome.server ? [outcome.server] : []),
    ];
    this.tools = [
      ...this.tools.filter((tool) => !own.has(tool.name)),
      ...outcome.tools,
    ];
    for (const name of own) this.hinted.delete(name);
    for (const [name, hint] of outcome.said) this.hinted.set(name, hint);
    this.results.forget(connection.name);
    await McpManager.disconnect(replaced);
    this.services.onChange?.();
  }
  private static async disconnect(servers: Connected[]): Promise<void> {
    // A server closed by Circle is not listed again: listAgain sees it is no longer open
    for (const server of servers) server.open = false;
    await Promise.all(
      servers.map((server) => server.client.close().catch(() => {})),
    );
  }
  /** Trusted host reads only an advertised read-only tool, outside model tool dispatch. */
  async readOnly(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const server = this.servers.find((s) => s.name === serverName && s.open);
    if (
      !server ||
      this.hint(mcpToolName(serverName, toolName))?.readOnly !== true
    )
      throw new Error('read-only MCP tool unavailable');
    const response = await callServerTool(
      server.client,
      { name: toolName, arguments: args },
      { signal, timeout: this.timeout },
      server.specs.get(toolName),
    );
    const text = JSON.stringify(response);
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new Error('MCP host result limit');
    this.assertNoCredentials(serverName, text);
    return response;
  }
  /** A trusted host dispatch after an explicit person confirmation, never exposed as a model proxy. */
  async personCall(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const server = this.servers.find((s) => s.name === serverName && s.open);
    if (
      !server ||
      !this.tools.some((t) => t.name === mcpToolName(serverName, toolName))
    )
      throw Error('MCP tool unavailable');
    const result = await callServerTool(
      server.client,
      { name: toolName, arguments: args },
      { signal, timeout: this.timeout },
      server.specs.get(toolName),
    );
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw Error('MCP host result limit');
    this.assertNoCredentials(serverName, text);
    return result;
  }
  assertNoCredentials(serverName: string, text: string): void {
    const server = this.servers.find((s) => s.name === serverName && s.open);
    if (!server) throw Error('MCP host connection unavailable');
    const resolved = fillHeaders(
        server.connection.headers,
        process.env,
        this.services.secrets?.() ?? {},
      ),
      filled = resolved.filled;
    for (const [name, value] of Object.entries(resolved.headers))
      if (credentialHeader(name)) {
        filled.set(value, '[MCP credential omitted]');
        if (/^Bearer /i.test(value))
          filled.set(value.slice(7), '[MCP credential omitted]');
      }
    if (this.services.home && server.url) {
      const auth = keptFor(this.services.home, new URL(server.url).href);
      for (const value of [
        auth.tokens?.access_token,
        auth.tokens?.refresh_token,
        auth.client && 'client_secret' in auth.client
          ? auth.client.client_secret
          : undefined,
      ])
        if (value) filled.set(value, '[MCP credential omitted]');
    }
    if ([...filled.keys()].some((value) => value && text.includes(value)))
      throw Error('MCP host result contains a credential');
  }
  /** What each server still connected said of using it, when it said anything. */
  instructions(): { server: string; text: string }[] {
    return this.servers
      .filter((server) => server.open && server.instructions)
      .map((server) => ({ server: server.name, text: server.instructions! }));
  }
  /** What moving the configuration into the current format did, said in /mcp until the next start. */
  notes: string[] = [];
  describe(): string {
    if (!this.status.length && !this.notes.length)
      return 'No MCP servers. Add them to mcpServers in settings.json, or to .mcp.json in the project.';
    const where = (server: McpStatus): string =>
      server.scope === 'project'
        ? ' (.mcp.json)'
        : server.scope === 'local'
          ? ' (this project)'
          : '';
    const state = (server: McpStatus): string =>
      server.approval === 'pending'
        ? `\n    waits for your approval: /mcp reconnect ${server.name} asks for it`
        : server.approval === 'declined'
          ? `\n    declined for this project: /mcp reconnect ${server.name} asks again`
          : server.authorize
            ? '\n    ' + server.error + ': ' + server.authorize
            : server.error === 'disabled'
              ? '\n    disabled'
              : server.error === TOOLS_NOT_LISTED_AGAIN ||
                  server.error === TOOLS_EXPIRED_NOT_LISTED
                ? '\n    ' + server.tools.join(', ') + '\n    ' + server.error
                : server.error
                  ? '\n    failed: ' + server.error
                  : '\n    ' + server.tools.join(', ');
    return [
      ...this.notes.map((note) => `moved: ${note}`),
      ...(this.status.length
        ? [
            `MCP servers (${this.status.length}):\n` +
              this.status
                .map(
                  (server) =>
                    `  · ${server.name}${where(server)}  ${server.connection}${server.headers?.length ? '\n    headers: ' + server.headers.join(', ') : ''}${server.notSent?.length ? '\n    not sent, Circle sets them: ' + server.notSent.join(', ') : ''}${server.warnings?.length ? '\n    warning: ' + server.warnings.join('; ') : ''}${state(server)}`,
                )
                .join('\n'),
          ]
        : []),
    ].join('\n');
  }
  /** What the server of a tool, by its name here, says of it. */
  hint(tool: string): ToolMarks | undefined {
    return this.hinted.get(tool);
  }
  /** Whether every call of a tool, by its name here, asks a person: its server marks it so. */
  asksPerson(tool: string): boolean {
    return this.hinted.get(tool)?.asksPerson === true;
  }
  /** The server a tool, by its name here, belongs to, and its own name there: what rules for a server go by. */
  mcpTool(tool: string): { server: string; tool: string } | undefined {
    const marks = this.hinted.get(tool);
    return marks ? { server: marks.server, tool: marks.tool } : undefined;
  }
  async close(): Promise<void> {
    // A sign-in under way stops waiting; the manager can load again afterwards
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.signingIn.clear();
    const servers = this.servers.splice(0);
    this.tools = [];
    this.hinted = new Map();
    this.results.clear();
    await McpManager.disconnect(servers);
  }
}

export interface McpBearerConnection {
  server: string;
  binding: string;
  assertActive(): void;
  token(signal: AbortSignal, rejected?: string): Promise<string>;
}
export function backgroundMcpConnection(
  home: string,
  connection: McpConnection,
  secrets: () => Record<string, string>,
): McpBearerConnection {
  if (!connection.url || !['http', 'sse'].includes(connection.transport))
    throw new Error('select an HTTP MCP connection');
  const server = new URL(
    resolveConnection(connection, process.env, secrets()).url!,
  ).href;
  const directKey =
    server + '#circle-direct-' + encodeURIComponent(connection.name);
  const current = (initialize = false) => {
    const headers = fillHeaders(
      connection.headers,
      process.env,
      secrets(),
    ).headers;
    const credential = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )?.[1];
    if (credential !== undefined) {
      // A reference to nothing set stays as written: it is no token
      const unset = /\$\{((?:secret:)?([A-Za-z_][A-Za-z0-9_]*))/.exec(
        credential,
      );
      if (unset)
        throw new Error(
          `the Authorization header names \${${unset[1]}}, which is not set; save it with /secrets ${unset[2]}`,
        );
      const match = /^Bearer ([^\s]+)$/i.exec(credential);
      if (!match) throw new McpLoginRequired();
      const grant = initialize
        ? directMcpGrant(home, directKey, match[1]!)
        : currentDirectMcpGrant(home, directKey, match[1]!);
      if (!grant) throw new McpLoginRequired();
      return { grant, bearer: match[1]! };
    }
    if (Object.keys(connection.headers ?? {}).some(credentialHeader))
      throw new McpLoginRequired();
    const kept = initialize
      ? oauthMcpGrant(home, server)
      : keptFor(home, server);
    if (!kept.tokens || !kept.grant_id) throw new McpLoginRequired();
    return { grant: kept.grant_id, bearer: undefined };
  };
  const grant = current(true).grant,
    binding = createHash('sha256')
      .update(JSON.stringify([server, grant]))
      .digest('hex');
  return {
    server,
    binding,
    assertActive: () => {
      if (current().grant !== grant) throw new McpLoginRequired();
    },
    token: async (signal, rejected) => {
      signal.throwIfAborted();
      const state = current();
      if (state.grant !== grant) throw new McpLoginRequired();
      if (state.bearer) return state.bearer;
      const provider = new McpAuthProvider(
        home,
        server,
        keptFor(home, server).port ?? 0,
      );
      const token = await provider.backgroundToken(signal, rejected);
      if (current().grant !== grant) throw new McpLoginRequired();
      return token;
    },
  };
}
