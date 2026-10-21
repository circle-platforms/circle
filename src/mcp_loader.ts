import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
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
} from './types.js';
import { attachmentFromBase64 } from './media.js';
import { isRecord } from './settings.js';
import { Sandbox, secretLookingName, shellEnvironment } from './sandbox.js';
import { readFileBytes } from './file_access.js';
import { abortable } from './watch.js';

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
}
/** The headers Circle sends of its own; lowercase, as compared. */
const OWN_HEADERS = new Set(['circle-session-id', 'traceparent']);
/** What the manager needs from the runtime it serves. */
export interface McpServices {
  /** The saved secrets, read on each connect for `${secret:NAME}` in headers. */
  secrets?: () => Record<string, string>;
  /** A server's connection ended on its own: what the model is told of it changed. */
  onChange?: () => void;
  /** The Circle session the runtime is in now; it can change while the runtime lives. */
  sessionId?: () => string;
  /**
   * Reads the file a file parameter names, under read_file's rules; at most `limit` bytes.
   * Without it, the terminal's rules for the workspace apply.
   */
  readFile?: (
    path: string,
    context: ToolContext,
    limit: number,
  ) => Promise<{ path: string; bytes: Buffer }>;
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
/**
 * Each occurrence of a needle in `text` replaced, the longest needles first, and none looked
 * for inside the occurrence of a longer one or in what replaced it: a file's base64 that holds
 * a hidden value is swapped whole for its label, and of two files whose encodings start alike
 * each is shown as itself.
 */
export function replaceLongest(
  text: string,
  pairs: Iterable<readonly [string, string]>,
): string {
  const needles = [...pairs]
    .filter(([needle]) => needle && text.includes(needle))
    .sort(([a], [b]) => b.length - a.length);
  if (!needles.length) return text;
  const taken = new Uint8Array(text.length);
  const found: [number, number, string][] = [];
  for (const [needle, replacement] of needles)
    for (let at = text.indexOf(needle); at !== -1;) {
      const end = at + needle.length;
      if (taken.subarray(at, end).includes(1)) {
        at = text.indexOf(needle, at + 1);
        continue;
      }
      taken.fill(1, at, end);
      found.push([at, end, replacement]);
      at = text.indexOf(needle, end);
    }
  found.sort(([a], [b]) => a - b);
  let shown = '';
  let from = 0;
  for (const [start, end, replacement] of found) {
    shown += text.slice(from, start) + replacement;
    from = end;
  }
  return shown + text.slice(from);
}
/**
 * Shows the name in place of each secret value Circle filled into a header: what a server
 * answers can quote the request it got.
 */
function hideFilled(filled: Map<string, string>): (text: string) => string {
  return (text) => replaceLongest(text, filled);
}
/** An error whose message says no filled-in value. */
function hiddenError(error: unknown, hide: (text: string) => string): unknown {
  if (!(error instanceof Error)) return error;
  const message = hide(error.message);
  return message === error.message ? error : new Error(message);
}
/** The tool call a request is made for, while the call is under way. */
const toolCalls = new AsyncLocalStorage<{ traceparent: string }>();
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
    headers.delete('traceparent');
    const session = sessionId?.();
    if (session) headers.set('Circle-Session-Id', session);
    const call = toolCalls.getStore();
    if (call) headers.set('traceparent', call.traceparent);
    return fetch(url, { ...init, headers });
  };
}
function transportFor(
  connection: McpConnection,
  workspace: string,
  headers: Record<string, string>,
  fetch: FetchLike,
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
    return new StreamableHTTPClientTransport(url, { requestInit, fetch });
  if (connection.transport === 'websocket') {
    if (requestInit)
      throw new Error('a websocket server cannot be sent headers');
    return new WebSocketClientTransport(url);
  }
  // A `url` entry without a known transport is reached over HTTP with server-sent events
  return new SSEClientTransport(url, { requestInit, fetch });
}
/** A tool result as the model reads it: its text, and the pictures and PDFs it carries. */
function resultText(
  result: Awaited<ReturnType<Client['callTool']>>,
  tool: string,
  context: ToolContext,
): { text: string; attachments: MediaAttachment[] } {
  const content = Array.isArray(result.content) ? result.content : [];
  const attachments: MediaAttachment[] = [];
  const text = content
    .map((block) => {
      if (!isRecord(block)) return JSON.stringify(block);
      if (block.type === 'text') return String(block.text || '');
      const resource =
        block.type === 'resource' && isRecord(block.resource)
          ? block.resource
          : undefined;
      const data = block.type === 'image' ? block.data : resource?.blob;
      const mime = block.type === 'image' ? block.mimeType : resource?.mimeType;
      if (
        context.emitAttachments &&
        typeof data === 'string' &&
        typeof mime === 'string' &&
        [
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/webp',
          'application/pdf',
        ].includes(mime)
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
/** JSON with every object's keys in order, so equal arguments read the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
type ToolResult = Awaited<ReturnType<Client['callTool']>>;
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
/** What the card adds to a file the call will not send, since it gets its earlier result. */
export const NOT_SENT =
  'not sent: the same call earlier in this session got its result, which is given again';
/** A server Circle is connected to. */
interface Connected {
  name: string;
  client: Client;
  instructions?: string;
  /** False once the connection ended, closed by Circle or by the server. */
  open: boolean;
}
type ServerTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
export class McpManager {
  tools: Tool[] = [];
  status: McpStatus[] = [];
  private servers: Connected[] = [];
  // What each tool's server says of it, when trusted with it: destructive or read-only
  private hinted = new Map<string, ToolHint>();
  private results = new SentResults();
  // For file parameters when the runtime gives no reader: the workspace, as the terminal reads
  private files?: Sandbox;
  // `timeout` bounds connecting and listing tools. A tool call has no limit unless `callTimeout`
  // is given: a tool may wait minutes (a login), and an interrupt cancels it.
  constructor(
    readonly workspace: string,
    readonly timeout = 30000,
    readonly callTimeout?: number,
    private readonly services: McpServices = {},
  ) {}
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
  ): Tool {
    const hide = hideFilled(filled);
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
          canonicalJson([
            this.services.sessionId?.() ?? context.sessionId,
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
          // A new trace for each call, on the requests made for it
          result = await toolCalls.run(
            { traceparent: traceparent() },
            async () => {
              // The SDK sends the cancellation from a listener on the signal, which runs
              // where the abort came from, such as a key press: a signal of this call's own,
              // aborted from within the call, keeps the trace on that request too
              const own = new AbortController();
              const forward = AsyncLocalStorage.bind(() =>
                own.abort(context.signal.reason),
              );
              context.signal.addEventListener('abort', forward, { once: true });
              if (context.signal.aborted) forward();
              try {
                return await client.callTool(
                  { name: spec.name, arguments: sending },
                  undefined,
                  {
                    signal: own.signal,
                    timeout: this.callTimeout ?? NO_LIMIT,
                    maxTotalTimeout: this.callTimeout,
                  },
                );
              } finally {
                context.signal.removeEventListener('abort', forward);
              }
            },
          );
        } catch (error) {
          throw hiddenError(error, shown);
        }
        if (key && !result.isError)
          this.results.set(key, connection.name, result);
      }
      const { text, attachments } = resultText(result, spec.name, context);
      const header = [
        ...(cached ? [CACHED_RESULT] : []),
        ...sent.map(
          (file) => `${file.name}: ${cached ? '' : 'sent '}${file.label}`,
        ),
      ].join('\n');
      const framed = (body: string) => (header ? `${header}\n\n${body}` : body);
      if (result.isError)
        throw new Error(framed(shown(text || 'MCP tool failed')));
      context.signal.throwIfAborted();
      if (attachments.length) context.emitAttachments!(attachments);
      return framed(
        shown(text || JSON.stringify(result.structuredContent ?? {})),
      );
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
      for (const connection of connections) {
        signal?.throwIfAborted();
        const headerNames = Object.keys(connection.headers ?? {});
        const state: McpStatus = {
          name: connection.name,
          connection: connection.command || connection.url || '',
          tools: [],
          error: '',
          ...(headerNames.length ? { headers: headerNames } : {}),
          ...(connection.notSent ? { notSent: connection.notSent } : {}),
        };
        status.push(state);
        const client = new Client({
          name: 'circle',
          version: '0.1.0-dev',
        });
        let transport: Transport | undefined;
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
          transport = transportFor(
            connection,
            this.workspace,
            filled.headers,
            requestFetch(this.services.sessionId),
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
          const registered: Tool[] = [];
          const said = new Map<string, ToolHint>();
          let cursor: string | undefined;
          const cursors = new Set<string>();
          do {
            const listed = await client.listTools(
              cursor ? { cursor } : undefined,
              { signal: combined, timeout: this.timeout },
            );
            for (const spec of listed.tools) {
              const name = mcpToolName(connection.name, spec.name);
              if (
                reserved.has(name) ||
                tools.some((tool) => tool.name === name) ||
                registered.some((tool) => tool.name === name)
              )
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
                  filled.filled,
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
          combined.throwIfAborted();
          const server: Connected = {
            name: connection.name,
            client,
            instructions: serverInstructions(client.getInstructions(), hide),
            open: true,
          };
          // The server went away: its instructions leave the prompt, /mcp says so, and no
          // result it gave earlier is given again
          client.onclose = () => {
            if (!server.open) return;
            server.open = false;
            state.error = 'the connection ended; reload to connect again';
            this.results.forget(connection.name);
            this.services.onChange?.();
          };
          connected.push(server);
          tools.push(...registered);
          for (const [name, hint] of said) hinted.set(name, hint);
          state.tools = registered.map((tool) => tool.name);
        } catch (error) {
          state.error = hide(
            error instanceof Error ? error.message : String(error),
          );
          await client.close().catch(() => {});
          await transport?.close().catch(() => {});
          if (signal?.aborted) throw signal.reason;
        } finally {
          combined.removeEventListener('abort', stop);
        }
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
  private static async disconnect(servers: Connected[]): Promise<void> {
    for (const server of servers) server.open = false;
    await Promise.all(
      servers.map((server) => server.client.close().catch(() => {})),
    );
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
            `  · ${server.name}  ${server.connection}${server.headers?.length ? '\n    headers: ' + server.headers.join(', ') : ''}${server.notSent?.length ? '\n    not sent, Circle sets them: ' + server.notSent.join(', ') : ''}${server.error === 'disabled' ? '\n    disabled' : server.error ? '\n    failed: ' + server.error : '\n    ' + server.tools.join(', ')}`,
        )
        .join('\n')
    );
  }
  /** What the server of a tool, by its name here, says of it, when trusted with it. */
  hint(tool: string): ToolHint | undefined {
    return this.hinted.get(tool);
  }
  async close(): Promise<void> {
    const servers = this.servers.splice(0);
    this.tools = [];
    this.hinted = new Map();
    this.results.clear();
    await McpManager.disconnect(servers);
  }
}
