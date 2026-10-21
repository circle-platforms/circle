import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  Tool,
  ToolContext,
  MediaAttachment,
  PreparedRun,
} from './types.js';
import { attachmentFromBase64 } from './media.js';
import { isRecord } from './settings.js';
import { Sandbox, shellEnvironment } from './sandbox.js';
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
}
/** What the manager needs from the runtime it serves. */
export interface McpServices {
  /** The saved secrets, read on each connect for `${secret:NAME}` in headers. */
  secrets?: () => Record<string, string>;
  /** A server's connection ended on its own: what the model is told of it changed. */
  onChange?: () => void;
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
 * other control character and the bidirectional controls taken out, and the first 8 KiB
 * kept with a mark where the rest was cut. Nothing for a server that gave none.
 */
export function serverInstructions(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(
      /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g,
      '',
    )
    .trim();
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
      if (isRecord(item.headers))
        connection.headers = Object.fromEntries(
          Object.entries(item.headers).map(([key, value]) => [
            key,
            String(value),
          ]),
        );
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
function fillHeaders(
  headers: Record<string, string> = {},
  env: NodeJS.ProcessEnv,
  secrets: Record<string, string>,
): { headers: Record<string, string>; filled: Map<string, string> } {
  const resolved: Record<string, string> = {};
  // Each value put in, with what is shown in its place: `%NAME%` for a secret, as everywhere a
  // secret's value is hidden, and the reference as written for an environment variable
  const filled = new Map<string, string>();
  for (const [name, template] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
      throw new Error(`invalid header name '${name}'`);
    const value = template.replace(
      /\$\{(env|secret):([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (reference: string, kind: string, variable: string) => {
        const found =
          kind === 'env'
            ? env[variable]
            : Object.hasOwn(secrets, variable)
              ? secrets[variable]
              : undefined;
        if (!found)
          throw new Error(
            kind === 'env'
              ? `header ${name} needs the environment variable ${variable}, which is not set`
              : `header ${name} needs the secret ${variable}, which is not saved; save it with /secrets ${variable}`,
          );
        filled.set(found, kind === 'env' ? reference : `%${variable}%`);
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
 * Shows the name in place of each value Circle filled into a header, longest first: what a
 * server answers can quote the request it got.
 */
function hideFilled(filled: Map<string, string>): (text: string) => string {
  const values = [...filled].sort(([a], [b]) => b.length - a.length);
  return (text) => {
    let shown = text;
    for (const [value, reference] of values)
      shown = shown.split(value).join(reference);
    return shown;
  };
}
/** An error whose message says no filled-in value. */
function hiddenError(error: unknown, hide: (text: string) => string): unknown {
  if (!(error instanceof Error)) return error;
  const message = hide(error.message);
  return message === error.message ? error : new Error(message);
}
function transportFor(
  connection: McpConnection,
  workspace: string,
  headers: Record<string, string>,
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
    return new StreamableHTTPClientTransport(url, { requestInit });
  if (connection.transport === 'websocket') {
    if (requestInit)
      throw new Error('a websocket server cannot be sent headers');
    return new WebSocketClientTransport(url);
  }
  return new SSEClientTransport(url, { requestInit });
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
 */
function toolHints(
  annotations: unknown,
  trusted: boolean,
): { readOnly: boolean; destructive: boolean } {
  const hints = trusted && isRecord(annotations) ? annotations : {};
  const destructive = hints.destructiveHint === true;
  return { readOnly: hints.readOnlyHint === true && !destructive, destructive };
}
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
  // The tools whose server says they can destroy data
  private destructive = new Set<string>();
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
    readOnly: boolean,
    hide: (text: string) => string,
  ): Tool {
    const files = fileParameters(spec.inputSchema);
    const limit = connection.maxFileBytes ?? MAX_FILE_BYTES;
    // The server is sent each file's bytes; Circle shows the file by path, size and digest
    const call = async (
      args: Record<string, unknown>,
      context: ToolContext,
      sent: SentFile[] = [],
    ): Promise<string> => {
      context.signal.throwIfAborted();
      const sending = { ...args };
      const encoded = sent.map((file) => {
        const base64 = file.bytes.toString('base64');
        sending[file.name] = base64;
        return [base64, file.label] as const;
      });
      const shown = (text: string): string => {
        let out = hide(text);
        for (const [base64, label] of encoded)
          if (base64) out = out.split(base64).join(label);
        return out;
      };
      let result: Awaited<ReturnType<Client['callTool']>>;
      try {
        result = await client.callTool(
          { name: spec.name, arguments: sending },
          undefined,
          {
            signal: context.signal,
            timeout: this.callTimeout ?? NO_LIMIT,
            maxTotalTimeout: this.callTimeout,
          },
        );
      } catch (error) {
        throw hiddenError(error, shown);
      }
      const { text, attachments } = resultText(result, spec.name, context);
      const header = sent
        .map((file) => `${file.name}: sent ${file.label}`)
        .join('\n');
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
      const run: PreparedRun = (given, runContext) => {
        for (const file of sent)
          if (given[file.name] !== file.path)
            throw new Error(`${file.name} is not the file Circle read`);
        return call(given, runContext, sent);
      };
      if (sent.length)
        run.shown = Object.fromEntries(
          sent.map((file) => [file.name, file.label]),
        );
      return run;
    };
    return {
      name,
      description: hide(spec.description || name),
      parameters: modelSchema(spec.inputSchema, files),
      effect: readOnly ? 'read' : 'unknown',
      ...(files.length
        ? {
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
    const destructive = new Set<string>();
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
        // What the server sends back names a header's secret or variable, never its value
        let hide = (text: string): string => text;
        try {
          const filled = fillHeaders(
            connection.headers,
            process.env,
            this.services.secrets?.() ?? {},
          );
          hide = hideFilled(filled.filled);
          transport = transportFor(connection, this.workspace, filled.headers);
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
          const destroys = new Set<string>();
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
              if (hints.destructive) destroys.add(name);
              registered.push(
                this.serverTool(
                  connection,
                  client,
                  spec,
                  name,
                  hints.readOnly,
                  hide,
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
            instructions: serverInstructions(
              hide(client.getInstructions() ?? ''),
            ),
            open: true,
          };
          // The server went away: its instructions leave the prompt, and /mcp says so
          client.onclose = () => {
            if (!server.open) return;
            server.open = false;
            state.error = 'the connection ended; reload to connect again';
            this.services.onChange?.();
          };
          connected.push(server);
          tools.push(...registered);
          for (const name of destroys) destructive.add(name);
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
      this.destructive = destructive;
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
            `  · ${server.name}  ${server.connection}${server.headers?.length ? '\n    headers: ' + server.headers.join(', ') : ''}${server.error === 'disabled' ? '\n    disabled' : server.error ? '\n    failed: ' + server.error : '\n    ' + server.tools.join(', ')}`,
        )
        .join('\n')
    );
  }
  /** Whether the server of a tool, by its name here, says the tool can destroy data. */
  isDestructive(tool: string): boolean {
    return this.destructive.has(tool);
  }
  async close(): Promise<void> {
    const servers = this.servers.splice(0);
    this.tools = [];
    this.destructive = new Set();
    await McpManager.disconnect(servers);
  }
}
