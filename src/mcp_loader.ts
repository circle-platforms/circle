import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  CallToolResultSchema,
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  ElicitRequestSchema,
  type ElicitResult,
  ErrorCode,
  GetTaskResultSchema,
  ListToolsResultSchema,
  McpError,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Implementation,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types.js';
import type {
  FetchLike,
  Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolHint } from './approvals.js';
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
export { replaceLongest };

export interface McpConnection {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable_http' | 'websocket';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /**
   * Sent with every request to a server reached by URL; `${env:NAME}` and `${secret:NAME}`
   * are filled in on connect.
   */
  headers?: Record<string, string>;
  /**
   * Configured headers of the names Circle sets itself (`Circle-Session-Id`, `traceparent`),
   * as written: never sent, and their values never filled in.
   */
  notSent?: string[];
  /**
   * False: the server's tool annotations are not read, and every tool asks as an unknown one
   * does. Default true.
   */
  trustAnnotations?: boolean;
  /** The largest file a file parameter of the server's tools takes, in bytes. */
  maxFileBytes?: number;
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
}
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
// Model APIs take tool names of letters, digits, `_` and `-`, at most 64 characters. A tool
// is offered as `<server>_<tool>` for any server name, with every other character turned
// into `_`, so the request goes through. A name that would be longer is
// shortened and given a hash of the original, so two long names stay apart.
export function mcpToolName(server: string, tool: string): string {
  const part = (value: string): string =>
    value.replace(/[^A-Za-z0-9_-]+/g, '_') || '_';
  const name = `${part(server)}_${part(tool)}`;
  if (name.length <= 64) return name;
  const hash = createHash('sha256')
    .update(`${server}\0${tool}`)
    .digest('hex')
    .slice(0, 8);
  return `${name.slice(0, 55)}_${hash}`;
}
export interface McpConnections {
  connections: McpConnection[];
  // Entries that are not started, with the reason (`/mcp` lists them)
  skipped: McpStatus[];
}
export function buildMcpConnections(
  servers: Record<string, unknown>[],
): McpConnections {
  const connections = new Map<string, McpConnection>();
  const skipped: McpStatus[] = [];
  for (const [index, item] of servers.entries()) {
    if (!isRecord(item)) continue;
    const name = String(item.name || item.id || `mcp${index}`);
    let connection: McpConnection | undefined;
    if (item.command) {
      const args =
        item.args === undefined
          ? []
          : Array.isArray(item.args)
            ? item.args.map(String)
            : [String(item.args)];
      const env = isRecord(item.env)
        ? Object.fromEntries(
            Object.entries(item.env).map(([key, value]) => [
              key,
              String(value),
            ]),
          )
        : undefined;
      connection = {
        name,
        transport: 'stdio',
        command: String(item.command),
        args,
        env,
      };
    } else if (item.url) {
      const raw = String(item.transport || 'sse').toLowerCase();
      const transport = ['sse', 'streamable_http', 'websocket'].includes(raw)
        ? (raw as McpConnection['transport'])
        : 'sse';
      connection = { name, transport, url: String(item.url) };
      if (isRecord(item.headers)) {
        // Circle's own are left out here, before anything is filled in: a secret named in
        // a header that is not sent is not needed
        const headers: Record<string, string> = {};
        const notSent: string[] = [];
        for (const [key, value] of Object.entries(item.headers))
          if (OWN_HEADERS.has(key.toLowerCase())) notSent.push(key);
          else headers[key] = String(value);
        connection.headers = headers;
        if (notSent.length) connection.notSent = notSent;
      }
    }
    if (!connection) continue;
    // Only true or no value trusts what the server says of its tools
    if (item.trust_annotations !== undefined && item.trust_annotations !== true)
      connection.trustAnnotations = false;
    // A limit that cannot be read is not replaced by the default: the server does not start
    const limit = item.max_file_bytes;
    if (
      limit !== undefined &&
      item.enabled !== false &&
      (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
    ) {
      connections.delete(name);
      skipped.push({
        name,
        connection: connection.command || connection.url || '',
        tools: [],
        error: 'max_file_bytes must be a whole number of bytes, 1 or more',
      });
      continue;
    }
    if (typeof limit === 'number') connection.maxFileBytes = limit;
    if (item.enabled === false) {
      // A disabled later entry still overrides an earlier server with the same
      // name. Never construct a transport or expose tools for either entry.
      connections.delete(name);
      skipped.push({
        name,
        connection: connection.command || connection.url || '',
        tools: [],
        error: 'disabled',
      });
      continue;
    }
    // The later of two servers with one name is used; the earlier is reported.
    const earlier = connections.get(name);
    if (earlier) {
      connections.delete(name);
      skipped.push({
        name,
        connection: earlier.command || earlier.url || '',
        tools: [],
        error: `another MCP server is also named '${name}'; the later one is used`,
      });
    }
    connections.set(name, connection);
  }
  return { connections: [...connections.values()], skipped };
}
// Header values as sent: each `${env:NAME}` replaced by that variable of Circle's own
// environment and each `${secret:NAME}` by that saved secret, so a token need not be written
// into settings.json. An error names the header and the variable or secret, never a value.
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
function fillHeaders(
  headers: Record<string, string> = {},
  env: NodeJS.ProcessEnv,
  secrets: Record<string, string>,
): { headers: Record<string, string>; filled: Map<string, string> } {
  const resolved: Record<string, string> = {};
  // Each secret value put in, with what is shown in its place: `%NAME%` for a saved secret, as
  // everywhere a secret's value is hidden, and the reference as written for an environment
  // variable whose name, or whose header's, looks secret. Any other value is no secret, and
  // hiding it would only change what the server says wherever the same text stands.
  const filled = new Map<string, string>();
  for (const [name, template] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
      throw new Error(`invalid header name '${name}'`);
    const value = template.replace(
      /\$\{(env|secret):([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (reference: string, kind: string, variable: string) => {
        // Only a value set as text: `constructor` and the other names every object has are
        // neither variables nor secrets
        const value =
          kind === 'env'
            ? env[variable]
            : Object.hasOwn(secrets, variable)
              ? secrets[variable]
              : undefined;
        const found = typeof value === 'string' ? value : '';
        if (!found)
          throw new Error(
            kind === 'env'
              ? `header ${name} needs the environment variable ${variable}, which is not set`
              : `header ${name} needs the secret ${variable}, which is not saved; save it with /secrets ${variable}`,
          );
        if (kind === 'secret') filled.set(found, `%${variable}%`);
        else if (secretLookingName(variable) || credentialHeader(name))
          filled.set(found, reference);
        return found;
      },
    );
    if (/[\r\n\0]/.test(value))
      throw new Error(`header ${name} has a line break or NUL in its value`);
    resolved[name] = value;
  }
  return { headers: resolved, filled };
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
  lost?: (error: McpError) => void;
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
  lost: (error: McpError) => void,
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
  workspace: string,
  headers: Record<string, string>,
  fetch: FetchLike,
  authProvider?: McpAuthProvider,
): Transport {
  if (connection.transport === 'stdio')
    return new StdioClientTransport({
      command: connection.command!,
      args: connection.args ?? [],
      cwd: workspace,
      env: {
        ...(shellEnvironment() as Record<string, string>),
        ...connection.env,
      },
      stderr: 'pipe',
    });
  const url = new URL(connection.url!);
  const protocols =
    connection.transport === 'websocket'
      ? ['ws:', 'wss:']
      : ['http:', 'https:'];
  if (!protocols.includes(url.protocol) || url.username || url.password)
    throw new Error('invalid MCP server URL');
  const requestInit = Object.keys(headers).length ? { headers } : undefined;
  if (connection.transport === 'streamable_http')
    return new StreamableHTTPClientTransport(url, {
      requestInit,
      fetch: authProvider ? authProvider.authorizedFetch(fetch) : fetch,
      ...(authProvider ? { authProvider } : {}),
    });
  if (connection.transport === 'websocket') {
    if (requestInit)
      throw new Error('a websocket server cannot be sent headers');
    return new WebSocketClientTransport(url);
  }
  // A `url` entry without a known transport is reached over HTTP with server-sent events
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
 * What a tool's annotations make of it, when its server is trusted with them: read-only
 * (`readOnlyHint`) runs as Circle's own reads do; destructive (`destructiveHint`) asks every
 * time. A tool that says both is destructive. Anything else is unknown, as without them.
 * Idempotent (`idempotentHint`): a call that sends files may get an earlier result again,
 * while no call that may change what the server holds has reached it since.
 */
function toolHints(
  annotations: unknown,
  trusted: boolean,
): { readOnly: boolean; destructive: boolean; idempotent: boolean } {
  const hints = trusted && isRecord(annotations) ? annotations : {};
  const destructive = hints.destructiveHint === true;
  return {
    readOnly: hints.readOnlyHint === true && !destructive,
    destructive,
    idempotent: hints.idempotentHint === true,
  };
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
/** A call that reached the server and whose answer cannot come: its answer's stream ended, or its task was lost. */
class Lost extends McpError {
  constructor(message: string) {
    super(ErrorCode.ConnectionClosed, message);
  }
}
/**
 * The connection ended after the request was sent, so it may have reached the server (#555): the MCP library closed
 * the connection under the call (it has no transport since), the call's answer was lost, or the socket was cut. A
 * server's own error is none of these, whatever its code or words: -32000 is the library's code for a closed
 * connection and also a server's for an error of its own.
 */
function droppedAfterSending(error: unknown, client: Client): boolean {
  return causes(error).some((cause) => {
    if (cause instanceof Lost) return true;
    if (cause instanceof McpError)
      return (
        cause.code === ErrorCode.ConnectionClosed &&
        client.transport === undefined
      );
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
 * Calls a server's tool and gives its result as the server sent it. The SDK's `callTool` checks a result against the
 * output schema it kept from the last listing of the tools and throws the result away when it does not match, as when
 * the server added a field after Circle connected (#513); this sends `tools/call` itself. The server still checks the
 * request, and whether a result matches its schema is for the caller to say.
 */
function callServerTool(
  client: Client,
  params: { name: string; arguments: Record<string, unknown> },
  options: RequestOptions,
): Promise<ToolResult> {
  return client.request(
    { method: 'tools/call', params },
    CallToolResultSchema,
    options,
  );
}
/** A server's words on one line of the screen: no control or bidirectional-text characters, cut at `max`. */
function oneLine(text: string, max = 160): string {
  const line = text
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
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
/**
 * How a tool is called (#554). A tool that says it may or must run as a task (`execution.taskSupport`, the
 * 2025-11-25 revision) goes as one when its server says it runs tool calls as tasks; one that must, on a server that
 * does not, is not sent, since the server would refuse it.
 */
function callMode(spec: unknown, client: Client): 'call' | 'task' | 'refused' {
  const execution = isRecord(spec) ? spec.execution : undefined;
  const support = isRecord(execution) ? execution.taskSupport : undefined;
  const capabilities = client.getServerCapabilities() as
    { tasks?: { requests?: { tools?: { call?: unknown } } } } | undefined;
  const served = isRecord(capabilities?.tasks?.requests?.tools?.call);
  if (support === 'required') return served ? 'task' : 'refused';
  return support === 'optional' && served ? 'task' : 'call';
}
const TASK_ENDS = new Set([
  'completed',
  'failed',
  'cancelled',
  'input_required',
]);
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
  client: Client;
  connection: McpConnection;
  instructions?: string;
  /** False once the connection ended, closed by Circle or by the server. */
  open: boolean;
}
type ServerTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
/** How long after a server says its tools changed Circle lists them, so several notices in a row list them once. */
export const TOOLS_CHANGED_WAIT_MS = 300;
/** What a server whose tools changed shows while Circle keeps its earlier tools. */
export const TOOLS_NOT_LISTED_AGAIN =
  'the server changed its tools and listing them again failed; the earlier tools stay until a reload';
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
    // A read, as a read-only tool of theirs is, while every such server is trusted with what it says of its tools;
    // otherwise these ask as that server's tools do
    const effect: Effect = readable.every(
      (server) => server.connection.trustAnnotations !== false,
    )
      ? 'read'
      : 'unknown';
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
          const { contents } = await client.readResource(
            { uri: String(args.uri) },
            { signal: context.signal, timeout: NO_LIMIT },
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
            // At most ten pages from a server: enough to see what it has, and never a loop
            for (let page = 0; page < 10; page++) {
              const listed = await client.listResources(
                cursor ? { cursor } : {},
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
  // What each tool's server says of it, when trusted with it: destructive or read-only
  private hinted = new Map<string, ToolHint>();
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
  // `timeout` bounds connecting and listing tools. A tool call has no limit unless `callTimeout`
  // is given: a tool may wait minutes (a login), and an interrupt cancels it.
  constructor(
    readonly workspace: string,
    readonly timeout = 30000,
    readonly callTimeout?: number,
    private readonly services: McpServices = {},
  ) {}
  /** The waits before sending a call again that surely did not leave this machine (#555). */
  retryWaitsMs: readonly number[] = [500, 1000, 2000];
  /** How such a wait is made. */
  wait = (ms: number, signal: AbortSignal): Promise<void> =>
    delay(ms, undefined, { signal });
  /**
   * The client a call of this server goes out on: its connection now, since a turn keeps the tools it started with
   * when the server is connected again. A connection that ended by itself, as when the server's program exited, is
   * connected again first: nothing was sent on it (#555).
   */
  private async sender(
    connection: McpConnection,
    signal: AbortSignal,
  ): Promise<Client> {
    const live = this.servers.find((item) => item.name === connection.name);
    if (live?.open) return live.client;
    if (!live) {
      const state = this.status.find((item) => item.name === connection.name);
      throw new Error(
        `${connection.name} is not connected${state?.error ? `: ${state.error}` : ''}; /mcp reload ${connection.name} connects it again`,
      );
    }
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
    hints: { readOnly: boolean; idempotent: boolean },
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
    const call = async (
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
              for (let tries = 0; ; tries++) {
                const attempt = new AbortController();
                const stop = (): void => attempt.abort(own.signal.reason);
                own.signal.addEventListener('abort', stop, { once: true });
                if (own.signal.aborted) stop();
                // The stream its answer was to come on ended without it, and nothing resumes it
                store.lost = (error) => attempt.abort(error);
                try {
                  const mode = callMode(spec, target);
                  if (mode === 'refused')
                    throw new Error(
                      `${spec.name} runs only as a task, and ${connection.name} does not say it runs tool calls as tasks; nothing was sent`,
                    );
                  const options: RequestOptions = {
                    signal: attempt.signal,
                    timeout: this.callTimeout ?? NO_LIMIT,
                    maxTotalTimeout: this.callTimeout,
                    // Asks the server for progress notices, shown on the call's row
                    onprogress: (notice) => report(progressText(notice)),
                  };
                  const params = { name: spec.name, arguments: sending };
                  return mode === 'task'
                    ? await this.callAsTask(target, params, options, report)
                    : await callServerTool(target, params, options);
                } catch (error) {
                  if (own.signal.aborted) throw error;
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
                  if (!droppedAfterSending(error, target)) throw error;
                  const fresh =
                    !resent && (hints.readOnly || hints.idempotent)
                      ? await abortable(
                          this.resendTarget(connection),
                          own.signal,
                        )
                      : undefined;
                  if (!fresh)
                    throw new Error(
                      `${said} · the connection to ${connection.name} ended after the call was sent: the request may have reached the server, so Circle did not send it again`,
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
      effect: hints.readOnly ? 'read' : 'unknown',
      // What the server says of its tool covers what the tool does there, not what a call
      // sends it: a local file's bytes or a secret's value leave this machine with the call
      ...(hints.readOnly
        ? {
            callEffect: (args, secrets) =>
              secrets.length ||
              files.some((parameter) => args[parameter] !== undefined)
                ? 'unknown'
                : 'read',
          }
        : {}),
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
  async load(
    servers: Record<string, unknown>[],
    reserved = new Set<string>(),
    signal?: AbortSignal,
  ): Promise<void> {
    const connected: Connected[] = [];
    const tools: Tool[] = [];
    const status: McpStatus[] = [];
    const hinted = new Map<string, ToolHint>();
    try {
      const { connections, skipped } = buildMcpConnections(servers);
      status.push(...skipped);
      this.reserved = reserved;
      for (const connection of connections) {
        signal?.throwIfAborted();
        const outcome = await this.connectServer(
          connection,
          reserved,
          (name) => tools.some((tool) => tool.name === name),
          signal,
        );
        status.push(outcome.state);
        if (!outcome.server) continue;
        connected.push(outcome.server);
        tools.push(...outcome.tools);
        for (const [name, hint] of outcome.said) hinted.set(name, hint);
      }
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
    said: Map<string, ToolHint>;
  }> {
    const headerNames = Object.keys(connection.headers ?? {});
    const state: McpStatus = {
      name: connection.name,
      connection: connection.command || connection.url || '',
      tools: [],
      error: '',
      ...(headerNames.length ? { headers: headerNames } : {}),
      ...(connection.notSent ? { notSent: connection.notSent } : {}),
    };
    // The platform is an extra member of clientInfo, a declaration a server may read or ignore.
    const client = new Client(
      {
        name: 'circle',
        version: VERSION,
        platform: process.platform,
      } as Implementation,
      // A server may ask the person for input in the middle of a call, with a form (#556), where someone can be asked.
      // The MCP library answers a request of another mode (a page to open) with an error; without a question panel
      // (print, line and RPC mode) Circle does not say it takes forms, so a server does not ask.
      { capabilities: this.services.ask ? { elicitation: { form: {} } } : {} },
    );
    if (this.services.ask)
      client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
        this.elicit(connection.name, request.params, extra.signal),
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
      const filled = fillHeaders(
        connection.headers,
        process.env,
        this.services.secrets?.() ?? {},
      );
      hide = hideFilled(filled.filled);
      provider = await this.authProvider(connection);
      transport = transportFor(
        connection,
        this.workspace,
        filled.headers,
        requestFetch(this.services.sessionId),
        provider,
      );
      if (transport instanceof StdioClientTransport)
        transport.stderr?.on('data', () => {});
      await abortable(
        client.connect(transport, {
          signal: combined,
          timeout: this.timeout,
        }),
        combined,
      );
      const { registered, said } = await this.listServerTools(
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
        instructions: serverInstructions(client.getInstructions(), hide),
        open: true,
      };
      // The server went away: its instructions leave the prompt, /mcp says so, and no
      // result it gave earlier is given again
      client.onclose = () => {
        if (!server.open) return;
        server.open = false;
        state.error =
          'the connection ended; the next call connects it again, and so does /mcp reload';
        this.results.forget(connection.name);
        this.services.onChange?.();
      };
      // A server that says its tools can change is listed again when it says they did: the next turn has the new
      // tools, and the turn under way keeps the ones it started with
      if (client.getServerCapabilities()?.tools?.listChanged)
        client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
          this.toolsChanged(server, filled.filled),
        );
      state.tools = registered.map((tool) => tool.name);
      return { state, server, tools: registered, said };
    } catch (error) {
      if (
        error instanceof UnauthorizedError &&
        provider?.authorizationUrl &&
        !signal?.aborted
      )
        this.signIn(connection, provider, state);
      else
        state.error = hide(
          error instanceof Error ? error.message : String(error),
        );
      await client.close().catch(() => {});
      await transport?.close().catch(() => {});
      if (signal?.aborted) throw signal.reason;
      return { state, tools: [], said: new Map() };
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
  ): Promise<McpAuthProvider | undefined> {
    const home = this.services.home;
    if (
      !home ||
      !connection.url ||
      (connection.transport !== 'streamable_http' &&
        connection.transport !== 'sse') ||
      Object.keys(connection.headers ?? {}).some(credentialHeader)
    )
      return undefined;
    const server = new URL(connection.url).href;
    return new McpAuthProvider(home, server, await redirectPort(home, server));
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
      redirect.code.catch(() => {});
      await redirect.ready;
      await (this.services.openUrl ?? openInBrowser)(url).catch(() => {});
      const code = await redirect.code;
      const exchange = transportFor(
        connection,
        this.workspace,
        {},
        requestFetch(this.services.sessionId),
        provider,
      ) as StreamableHTTPClientTransport | SSEClientTransport;
      try {
        await exchange.finishAuth(code);
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
   * A server's tools as it lists them now, page by page. Listed by Circle itself: the SDK's listTools would also compile
   * every output schema for its own checks of results, and fail the whole server on one it cannot compile. One
   * validator per listing: a schema with an $id is kept by it, and a server that changed has new schemas.
   */
  private async listServerTools(
    connection: McpConnection,
    client: Client,
    filled: Map<string, string>,
    taken: (name: string) => boolean,
    signal: AbortSignal,
  ): Promise<{ registered: Tool[]; said: Map<string, ToolHint> }> {
    const registered: Tool[] = [];
    const said = new Map<string, ToolHint>();
    const validator = new AjvJsonSchemaValidator();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const listed = await client.request(
        { method: 'tools/list', params: cursor ? { cursor } : undefined },
        ListToolsResultSchema,
        { signal, timeout: this.timeout },
      );
      for (const spec of listed.tools) {
        const name = mcpToolName(connection.name, spec.name);
        if (taken(name) || registered.some((tool) => tool.name === name))
          throw new Error(`tool '${name}' already exists`);
        const hints = toolHints(
          spec.annotations,
          connection.trustAnnotations !== false,
        );
        if (hints.destructive) said.set(name, 'destructive');
        else if (hints.readOnly) said.set(name, 'read-only');
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
    return { registered, said };
  }
  /** A server said its tools changed: they are listed again a moment later, once for several notices in a row. */
  private toolsChanged(server: Connected, filled: Map<string, string>): void {
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
      own.running = this.listAgain(server, filled).finally(() => {
        own.running = undefined;
        if (own.again) {
          own.again = false;
          this.toolsChanged(server, filled);
        } else if (this.relisting.get(server) === own)
          this.relisting.delete(server);
      });
    }, TOOLS_CHANGED_WAIT_MS);
    own.wait.unref?.();
  }
  /**
   * The server's tools, status and kept results replaced by what it lists now, all at once. When the listing fails, its
   * earlier tools stay and its status says so.
   */
  private async listAgain(
    server: Connected,
    filled: Map<string, string>,
  ): Promise<void> {
    const current = () => server.open && this.servers.includes(server);
    if (!current()) return;
    const state = this.status.find((item) => item.name === server.name);
    const own = new Set(state?.tools ?? []);
    try {
      const { registered, said } = await this.listServerTools(
        server.connection,
        server.client,
        filled,
        (name) =>
          this.reserved.has(name) ||
          this.tools.some((tool) => tool.name === name && !own.has(name)),
        AbortSignal.any([
          AbortSignal.timeout(this.timeout),
          this.lifetime.signal,
        ]),
      );
      if (!current()) return;
      this.tools = [
        ...this.tools.filter((tool) => !own.has(tool.name)),
        ...registered,
      ];
      for (const name of own) this.hinted.delete(name);
      for (const [name, hint] of said) this.hinted.set(name, hint);
      if (state) {
        state.tools = registered.map((tool) => tool.name);
        if (state.error === TOOLS_NOT_LISTED_AGAIN) state.error = '';
      }
    } catch {
      if (!current()) return;
      if (state) state.error = TOOLS_NOT_LISTED_AGAIN;
    }
    // What a tool of the server returned before may not hold for the tools it has now
    this.results.forget(server.name);
    this.services.onChange?.();
  }
  /**
   * A tool call as a task (2025-11-25, #554): the server makes the task and answers at once; Circle asks how it stands
   * as often as the server says to and shows it on the call's row, then reads the call's result. esc cancels the task.
   * Once the task is made the call has reached the server, so a failure to follow it is never one that left nothing
   * sent (#555).
   */
  private async callAsTask(
    client: Client,
    params: { name: string; arguments: Record<string, unknown> },
    options: RequestOptions,
    show: (text: string) => void,
  ): Promise<ToolResult> {
    const signal = options.signal!;
    const created = await client.request(
      { method: 'tools/call', params },
      CreateTaskResultSchema,
      { ...options, task: {} },
    );
    let task: {
      taskId: string;
      status: string;
      statusMessage?: string;
      pollInterval?: number;
    } = created.task;
    const taskId = task.taskId;
    const cancel = (): void => {
      void client
        .request(
          { method: 'tasks/cancel', params: { taskId } },
          CancelTaskResultSchema,
          { timeout: this.timeout },
        )
        .catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    const follow = async <T>(request: () => Promise<T>): Promise<T> => {
      for (let tries = 0; ; tries++) {
        try {
          return await request();
        } catch (error) {
          if (signal.aborted) throw error;
          if (notSent(error) && tries < this.retryWaitsMs.length) {
            await this.wait(this.retryWaitsMs[tries]!, signal);
            continue;
          }
          if (notSent(error) || droppedAfterSending(error, client))
            throw new Lost(
              `the server made task ${taskId} for the call, and following it failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          throw error;
        }
      }
    };
    try {
      for (;;) {
        show(taskText(task));
        if (TASK_ENDS.has(task.status)) break;
        const interval = Math.min(
          Math.max(task.pollInterval ?? 1000, 50),
          30_000,
        );
        await delay(interval, undefined, { signal });
        task = await follow(() =>
          client.request(
            { method: 'tasks/get', params: { taskId } },
            GetTaskResultSchema,
            { signal, timeout: this.timeout },
          ),
        );
      }
      if (task.status === 'cancelled')
        throw new Error(
          `the server cancelled task ${taskId}${task.statusMessage ? `: ${task.statusMessage}` : ''}`,
        );
      // The call's result or error. A task that waits on input is asked for it while this waits.
      try {
        return await follow(() =>
          client.request(
            { method: 'tasks/result', params: { taskId } },
            CallToolResultSchema,
            {
              signal,
              timeout: options.timeout,
              maxTotalTimeout: options.maxTotalTimeout,
            },
          ),
        );
      } catch (error) {
        if (task.status !== 'failed' || signal.aborted) throw error;
        throw new Error(
          `task ${taskId} failed${task.statusMessage ? `: ${task.statusMessage}` : ''} (${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      }
    } finally {
      signal.removeEventListener('abort', cancel);
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
   * A server's question in the middle of a call (form mode, #556), in the question panel: a question for each field,
   * then whether to send the answers. Answers that do not fit the form are asked for again; closing the panel, esc on
   * the call, or the server's own cancellation cancels it. Without a panel (print, line and RPC mode) it is cancelled.
   */
  private async elicit(
    server: string,
    params: { message: string; requestedSchema?: unknown },
    cancelled: AbortSignal,
  ): Promise<ElicitResult> {
    const ask = this.services.ask;
    if (!ask) return { action: 'cancel' };
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
    const fields = elicitationFields(params.requestedSchema);
    let problems: string[] = [];
    for (;;) {
      let reply: string;
      try {
        reply = await ask(
          {
            questions: elicitationQuestions(
              server,
              params.message,
              fields,
              problems,
            ),
          },
          signal,
        );
      } catch (error) {
        if (signal.aborted) return { action: 'cancel' };
        throw error;
      }
      if (signal.aborted) return { action: 'cancel' };
      const outcome = elicitationOutcome(fields, reply);
      if (outcome.action !== 'again') return outcome;
      problems = outcome.problems;
    }
  }
  /**
   * Where a call cut after it was sent goes once more: the server's connection when it is still open, as an HTTP one
   * is after one request's socket was cut, so the other calls on it go on; otherwise the server connected again.
   * Nothing, when the server is gone.
   */
  private async resendTarget(
    connection: McpConnection,
  ): Promise<Client | undefined> {
    const live = this.servers.find((item) => item.name === connection.name);
    if (!live) return undefined;
    return live.open ? live.client : this.connectedAgain(live.connection);
  }
  private reconnects = new Map<string, Promise<Client | undefined>>();
  /**
   * Connects a server again for calls to be sent on, and gives its new client, or nothing if it is not back: once for
   * all the calls that need it at the same time. It runs outside the call that asked, since the connection outlives
   * that call: its requests and its streams carry no call's trace or identity.
   */
  private connectedAgain(
    connection: McpConnection,
  ): Promise<Client | undefined> {
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
    entries: Record<string, unknown>[],
  ): Promise<void> {
    // The whole list, so a server named by its id or its place is named as when it connected
    const { connections, skipped } = buildMcpConnections(entries);
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
    if (!server || this.hint(mcpToolName(serverName, toolName)) !== 'read-only')
      throw new Error('read-only MCP tool unavailable');
    const response = await callServerTool(
      server.client,
      { name: toolName, arguments: args },
      { signal, timeout: this.timeout },
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
    if (this.services.home && server.connection.url) {
      const auth = keptFor(
        this.services.home,
        new URL(server.connection.url).href,
      );
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
  describe(): string {
    if (!this.status.length)
      return 'No MCP servers. Add mcp_servers to settings.json.';
    return (
      `MCP servers (${this.status.length}):\n` +
      this.status
        .map(
          (server) =>
            `  · ${server.name}  ${server.connection}${server.headers?.length ? '\n    headers: ' + server.headers.join(', ') : ''}${server.notSent?.length ? '\n    not sent, Circle sets them: ' + server.notSent.join(', ') : ''}${server.authorize ? '\n    ' + server.error + ': ' + server.authorize : server.error === 'disabled' ? '\n    disabled' : server.error === TOOLS_NOT_LISTED_AGAIN ? '\n    ' + server.tools.join(', ') + '\n    ' + server.error : server.error ? '\n    failed: ' + server.error : '\n    ' + server.tools.join(', ')}`,
        )
        .join('\n')
    );
  }
  /** What the server of a tool, by its name here, says of it, when trusted with it. */
  hint(tool: string): ToolHint | undefined {
    return this.hinted.get(tool);
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
  if (
    !connection.url ||
    !['streamable_http', 'sse'].includes(connection.transport)
  )
    throw new Error('select an HTTP MCP connection');
  const server = new URL(connection.url).href;
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
