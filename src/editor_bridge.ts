import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { dirname, join } from 'node:path';
import { loadToolPrompt } from './system_prompt.js';
import type { Sandbox } from './sandbox.js';
import type { Tool } from './types.js';

/**
 * The editor bridge: a localhost MCP server that Circle starts when the person
 * asks for it. An editor plugin connects to it as a client and says what it has
 * open and what is selected; the model reads that state and can ask for a diff
 * to be shown. Nothing reaches disk until the person accepts in the editor, and
 * the accept comes from the editor, never from the model.
 *
 * It answers JSON-RPC 2.0 in the shape MCP clients use, stateless: the bridge
 * has nothing to push, so a GET for a server-to-client stream is refused.
 */

export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_PATH = '/mcp';
export const BRIDGE_TOKEN_HEADER = 'x-circle-bridge-token';
/** A selection older than this is not context, it is a leftover. */
export const SELECTION_MAX_AGE_SECONDS = 600;
/** A diff nobody answered is dropped after this. */
export const DIFF_MAX_AGE_SECONDS = 3600;
export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'circle-editor-bridge', version: '1' };

export interface BridgeSelection {
  path: string;
  text: string;
  lineStart: number;
  lineEnd: number;
  at: number;
}

export interface BridgeDiff {
  id: string;
  path: string;
  proposed: string;
  madeAt: number;
  decided?: 'accept' | 'reject';
  result?: string;
}

export interface BridgeInfo {
  url: string;
  token: string;
  file: string;
}

let seconds = (): number => Math.floor(Date.now() / 1000);

/** Whether an address belongs to this machine, as a socket reports it. */
export function loopbackAddress(value: string | undefined): boolean {
  const address = (value ?? '').replace(/^::ffff:/i, '').toLowerCase();
  return address === '::1' || address === '1' || address.startsWith('127.');
}

/** The name in a Host header has to be this machine, so rebinding cannot reach it. */
export function allowedHost(value: string | undefined): boolean {
  const name = (value ?? '').trim().toLowerCase();
  if (!name) return false;
  // A bracketed IPv6 name keeps its colons: only a v4 or plain name
  // has a port to take off after the brackets are gone.
  const bracketed = name.match(/^\[([^\]]+)\](?::\d+)?$/);
  const host = bracketed ? bracketed[1]! : name.replace(/^(.*):\d+$/, '$1');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/** Where a browser page would come from: only this machine, or no Origin at all. */
export function allowedOrigin(value: string | undefined): boolean {
  if (!value || value === 'null') return true;
  try {
    return allowedHost(new URL(value).host);
  } catch {
    return false;
  }
}

const tokenMatches = (given: string, wanted: string): boolean => {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(wanted, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

export class EditorBridge {
  private server: Server | undefined;
  private token = '';
  private port = 0;
  private activeFile: { path: string; at: number } | undefined;
  private selection: BridgeSelection | undefined;
  private diffs = new Map<string, BridgeDiff>();
  /** Where the editor looks for a running bridge. */
  readonly file: string;

  /** Seconds, or whatever a test says they are: an age must be checkable. */
  clock(): number {
    return seconds();
  }

  constructor(
    private readonly home: string,
    private readonly workspace: string,
    private readonly sandbox: Sandbox,
    private readonly at: () => number = () => seconds(),
  ) {
    this.file = join(home, 'bridge.json');
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  get info(): BridgeInfo | undefined {
    if (!this.server) return undefined;
    return {
      url: `http://${BRIDGE_HOST}:${this.port}${BRIDGE_PATH}`,
      token: this.token,
      file: this.file,
    };
  }

  /** Start on the loopback interface only, on a free port, with a fresh token. */
  async start(): Promise<BridgeInfo> {
    if (this.server) throw new Error('the bridge is already running');
    this.token = randomBytes(24).toString('hex');
    this.port = 0;
    this.activeFile = undefined;
    this.selection = undefined;
    this.diffs = new Map();
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, BRIDGE_HOST, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    const info = this.info!;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(
      this.file,
      JSON.stringify({ url: info.url, token: this.token, pid: process.pid }),
    );
    return info;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    rmSync(this.file, { force: true });
    this.diffs = new Map();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** What `/bridge` shows: the state of the run, never the whole token. */
  statusText(): string {
    if (!this.server)
      return 'bridge: not running \u00b7 /bridge start opens it';
    const info = this.info!;
    const seen = this.selection ?? this.activeFile;
    return [
      `bridge: running at ${info.url}`,
      `token: ${this.token.slice(0, 6)}\u2026 (${this.token.length} characters) \u00b7 /bridge token shows it`,
      `the editor writes to: ${this.file}`,
      seen
        ? `last heard from the editor ${this.at() - seen.at}s ago`
        : 'no editor has reported anything yet',
      `${this.pendingDiffs().length} diff requests waiting, ${this.diffs.size} made this run`,
    ].join('\n');
  }

  private pendingDiffs(): BridgeDiff[] {
    const age = this.at();
    return [...this.diffs.values()].filter(
      (diff) => !diff.decided && age - diff.madeAt <= DIFF_MAX_AGE_SECONDS,
    );
  }

  /** Every tool the bridge offers, with what each is for. */
  private definitions(): {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    /** Whether the model may call it, or only the editor. */
    forModel: boolean;
  }[] {
    const string = (description: string) => ({ type: 'string', description });
    const number = (description: string) => ({
      type: 'integer',
      minimum: 0,
      description,
    });
    return [
      {
        name: 'editor_status',
        description:
          'What the editor has told the bridge: the file it has open and the selection it reported, with how old each is. Call this before asking the person where they are.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        forModel: true,
      },
      {
        name: 'editor_active_file',
        description:
          'The path of the file the editor has open. Nothing when no editor has reported one.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        forModel: true,
      },
      {
        name: 'editor_selection',
        description:
          'The text the person selected, its file and its line range. The bridge refuses a selection older than ten minutes: a leftover is not context.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        forModel: true,
      },
      {
        name: 'editor_open_diff',
        description:
          'Ask the editor to show a diff of a file against the text you propose. It does not change the file: the person accepts or rejects in the editor, and only an accept writes. Answer with the request id and say what happens next.',
        inputSchema: {
          type: 'object',
          properties: {
            path: string('The file to show, inside the workspace'),
            proposed: string('The whole text the file would hold'),
            note: string('One line for the person about what changes'),
          },
          required: ['path', 'proposed'],
          additionalProperties: false,
        },
        forModel: true,
      },
      {
        name: 'editor_report_file',
        description:
          'For the editor: say which file is open now. Call this when the active file changes.',
        inputSchema: {
          type: 'object',
          properties: { path: string('The path the editor has open') },
          required: ['path'],
          additionalProperties: false,
        },
        forModel: false,
      },
      {
        name: 'editor_report_selection',
        description:
          'For the editor: report the current selection, or an empty text to say there is none.',
        inputSchema: {
          type: 'object',
          properties: {
            path: string('The file the selection is in'),
            text: string('The selected text; empty means none'),
            lineStart: number('First line of the selection, 1 based'),
            lineEnd: number('Last line of the selection, 1 based'),
          },
          required: ['path', 'text'],
          additionalProperties: false,
        },
        forModel: false,
      },
      {
        name: 'editor_pending_diffs',
        description:
          'For the editor: the diff requests waiting for a decision, oldest first.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        forModel: false,
      },
      {
        name: 'editor_diff_decision',
        description:
          'For the editor: report what the person chose. accept writes the proposed text to the file; reject leaves it alone.',
        inputSchema: {
          type: 'object',
          properties: {
            id: string('The request id the bridge gave'),
            accept: { type: 'boolean', description: 'What the person chose' },
            reason: string('For a reject: what they said, if anything'),
          },
          required: ['id', 'accept'],
          additionalProperties: false,
        },
        forModel: false,
      },
    ];
  }

  /** The four the model may call; the rest belong to the editor. */
  modelTools(): Tool[] {
    return this.definitions()
      .filter((tool) => tool.forModel)
      .map((tool) => ({
        name: tool.name,
        description: loadToolPrompt(tool.name) || tool.description,
        parameters: tool.inputSchema,
        effect: tool.name === 'editor_open_diff' ? 'unknown' : 'read',
        run: async (args) => this.resultText(tool.name, args),
      }));
  }

  private resultText(name: string, args: Record<string, unknown>): string {
    const out = this.callTool(name, args);
    return typeof out === 'string' ? out : JSON.stringify(out, null, 1);
  }

  /** One tool, as both paths reach it. An error is a message, never a throw. */
  private callTool(name: string, args: Record<string, unknown>): unknown {
    // The four the model may call answer from the state the editor pushed; with
    // no listener there is no state, and the way to say that is the way to say it.
    if (
      !this.running &&
      this.definitions().some((tool) => tool.forModel && tool.name === name)
    )
      return 'the bridge is not open \u00b7 ask the person to run /bridge start';
    if (name === 'editor_status')
      return {
        running: this.running,
        activeFile: this.activeFile?.path ?? null,
        activeAge: this.activeFile ? this.at() - this.activeFile.at : null,
        selection: this.selection
          ? {
              path: this.selection.path,
              lines: [this.selection.lineStart, this.selection.lineEnd],
              age: this.at() - this.selection.at,
              characters: this.selection.text.length,
            }
          : null,
        pendingDiffs: this.pendingDiffs().length,
      };
    if (name === 'editor_active_file')
      return this.activeFile
        ? `${this.activeFile.path} (${this.at() - this.activeFile.at}s ago)`
        : 'no editor has reported a file';
    if (name === 'editor_selection') {
      const found = this.selection;
      if (!found) return 'no selection reported';
      const age = this.at() - found.at;
      if (age > SELECTION_MAX_AGE_SECONDS)
        return `the selection is ${age}s old, past the ${SELECTION_MAX_AGE_SECONDS}s it counts as context: ask the person to select it again`;
      if (!found.text) return 'nothing is selected';
      return `${found.path}:${found.lineStart}-${found.lineEnd}\n${found.text}`;
    }
    if (name === 'editor_open_diff') {
      if (!this.running) return 'the bridge is not running';
      const path = String(args.path ?? '').trim();
      const proposed = String(args.proposed ?? '');
      if (!path || !proposed) return 'path and proposed are both needed';
      if (!this.sandbox.isInside(path))
        return `refused: ${path} is outside the workspace, and the bridge writes only inside it`;
      let target: string;
      try {
        target = this.sandbox.resolvePath(path);
        this.sandbox.checkMutablePath(target);
      } catch (error) {
        return `refused: ${(error as Error).message}`;
      }
      const id = randomBytes(6).toString('hex');
      this.diffs.set(id, { id, path: target, proposed, madeAt: this.at() });
      return `diff request ${id} is waiting for the person in the editor: ${String(args.note ?? path)} \u00b7 nothing was written; the file changes only if they accept`;
    }
    if (name === 'editor_report_file') {
      const path = String(args.path ?? '').trim();
      if (!path) return 'path is needed';
      this.activeFile = { path, at: this.at() };
      return `ok: ${path}`;
    }
    if (name === 'editor_report_selection') {
      const path = String(args.path ?? '').trim();
      const textValue = String(args.text ?? '');
      if (!path) return 'path is needed';
      this.selection = {
        path,
        text: textValue,
        lineStart: Number(args.lineStart ?? 0),
        lineEnd: Number(args.lineEnd ?? args.lineStart ?? 0),
        at: this.at(),
      };
      return `ok: ${textValue.length} characters`;
    }
    if (name === 'editor_pending_diffs')
      return this.pendingDiffs().map((diff) => ({
        id: diff.id,
        path: diff.path,
        age: this.at() - diff.madeAt,
        proposed: diff.proposed,
      }));
    if (name === 'editor_diff_decision') {
      const id = String(args.id ?? '');
      const diff = this.diffs.get(id);
      if (!diff) return `no diff request ${id}`;
      if (diff.decided) return `diff ${id} was already ${diff.decided}`;
      if (!args.accept) {
        diff.decided = 'reject';
        diff.result = String(args.reason ?? 'rejected in the editor');
        return `rejected: ${diff.path} is unchanged`;
      }
      try {
        if (!this.sandbox.isInside(diff.path))
          throw Error('outside the workspace');
        this.sandbox.checkMutablePath(diff.path);
        mkdirSync(dirname(diff.path), { recursive: true });
        writeFileSync(diff.path, diff.proposed);
        diff.decided = 'accept';
        diff.result = `wrote ${Buffer.byteLength(diff.proposed)} bytes`;
        return `accepted: ${diff.path} ${diff.result}`;
      } catch (error) {
        diff.decided = 'reject';
        diff.result = (error as Error).message;
        return `refused on the way to disk: ${(error as Error).message}`;
      }
    }
    return `unknown tool ${name}`;
  }

  /** The JSON-RPC layer: guards first, then one message at a time. */
  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const refuse = (code: number, why: string): void => {
      response.writeHead(code, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: why }));
    };
    // Only this machine, only under this machine's own name, and only with the
    // token the bridge gave when it started.
    if (!loopbackAddress(request.socket.remoteAddress))
      return refuse(403, 'the bridge answers only this machine');
    if (!allowedHost(request.headers.host))
      return refuse(400, 'Host must name this machine');
    if (!allowedOrigin(request.headers.origin))
      return refuse(403, 'Origin must name this machine or be absent');
    if (
      !this.token ||
      !tokenMatches(
        String(request.headers[BRIDGE_TOKEN_HEADER] ?? ''),
        this.token,
      )
    )
      return refuse(401, 'no bridge token, or the wrong one');
    if (request.method === 'GET')
      return refuse(
        405,
        'the bridge has nothing to push: a client sends POST ' + BRIDGE_PATH,
      );
    if (request.method !== 'POST')
      return refuse(405, 'only POST reaches the bridge');
    if ((request.url ?? '').split('?')[0] !== BRIDGE_PATH)
      return refuse(404, 'the bridge answers on ' + BRIDGE_PATH);
    let raw = '';
    request.setEncoding('utf8');
    for await (const chunk of request) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 4_000_000)
        return refuse(413, 'a bridge message is at most 4 MB');
    }
    let message: {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      message = JSON.parse(raw || '{}');
    } catch {
      return refuse(400, 'the bridge reads JSON only');
    }
    if (typeof message?.method !== 'string')
      return refuse(400, 'a JSON-RPC message needs a method');
    let answer: unknown;
    try {
      answer = this.rpc(message.method, message.params ?? {});
    } catch (error) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: { code: -32601, message: (error as Error).message },
        }),
      );
      return;
    }
    // A notification wants no body of its own, only a yes.
    if (answer === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        message.id === undefined
          ? answer
          : { jsonrpc: '2.0', id: message.id, result: answer },
      ),
    );
  }

  private rpc(method: string, params: Record<string, unknown>): unknown {
    if (method === 'initialize')
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    if (method === 'ping') return {};
    if (method.startsWith('notifications/')) return undefined;
    if (method === 'tools/list')
      return {
        tools: this.definitions().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    if (method === 'tools/call') {
      const name = String(params.name ?? '');
      const known = this.definitions().some((tool) => tool.name === name);
      if (!known)
        return {
          isError: true,
          content: [{ type: 'text', text: `unknown tool ${name}` }],
        };
      const text = this.resultText(
        name,
        (params.arguments as Record<string, unknown>) ?? {},
      );
      return { content: [{ type: 'text', text }] };
    }
    throw new Error('unknown method ' + method);
  }
}
