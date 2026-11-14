// An MCP server on loopback for tests, written by hand so a test sees what reaches the wire:
// every HTTP request with its headers and raw body. It answers JSON-RPC over streamable HTTP
// (`url`, one JSON answer per POST) and over the older HTTP+SSE transport (`sseUrl`).
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { ServerResponse } from 'node:http';
import { cleanupServer } from './helpers.js';

interface TestContext {
  after(fn: () => void | Promise<void>): void;
}
export interface StubTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** How it may be run, such as `{ taskSupport: 'required' }`. */
  execution?: Record<string, unknown>;
}
export interface StubResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
}
/** One HTTP request as it arrived, and the JSON-RPC message in its body, if any. */
export interface StubRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  message?: {
    jsonrpc: string;
    id?: number | string;
    method: string;
    params?: Record<string, any>;
  };
  /** The client's answer to the request the stub sent it during this call (`serverRequest`). */
  reply?: { result?: Record<string, any>; error?: Record<string, any> };
}
export interface StubOptions {
  name?: string;
  tools?: StubTool[];
  /** The tools listed a page at a time instead of `tools`, the next page's index as each page's cursor. */
  pages?: StubTool[][];
  /** The initialize result's `instructions`, read at each initialize. */
  instructions?: () => string | undefined;
  /** Answers tools/call; by default the text names the tool. */
  call?: (
    request: StubRequest,
  ) => StubResult | Record<string, unknown> | Promise<StubResult>;
  /**
   * Declares that its tools can change (`tools.listChanged`) and keeps the stream a streamable HTTP client opens with
   * GET, so `notify` reaches it. `tools` is read again at each tools/list: change it, then notify.
   */
  listChanged?: boolean;
  /** More server capabilities to declare, such as `resources` or `tasks`. */
  capabilities?: Record<string, unknown>;
  /** Answers a method the stub has no answer of its own for; undefined falls back to an empty result. */
  answer?: (request: StubRequest) => unknown;
  /** Answers a GET of another path with JSON, such as a discovery document; undefined is a 405. */
  get?: (path: string, origin: string) => unknown;
  /** Closes each connection after its answer, so a client opens a new one for each request. */
  connectionClose?: boolean;
  /** Cuts the connection once a request arrived, before any answer. */
  drop?: (request: StubRequest) => boolean;
  /**
   * A request the stub sends the client during a tools/call, on the call's event stream, such as
   * `elicitation/create`; it answers the call once the client answered, with that answer as the call's `reply`.
   */
  serverRequest?: (
    request: StubRequest,
  ) => { method: string; params: Record<string, unknown> } | undefined;
  /** Messages sent on an event stream before the answer to a request, such as progress notices. */
  before?: (request: StubRequest) => Record<string, unknown>[] | undefined;
  /** Answers a request with an event stream that ends without the answer. */
  endStream?: (request: StubRequest) => boolean;
  /** An HTTP status to refuse a request with, such as 401, with this body. */
  refuse?: (
    request: StubRequest,
  ) => { status: number; body: string } | undefined;
}
export interface McpStub {
  /** The streamable HTTP endpoint. */
  url: string;
  /** The HTTP+SSE endpoint. */
  sseUrl: string;
  /** Every request, in order. */
  requests: StubRequest[];
  /** The tools/call requests, in order. */
  calls(): StubRequest[];
  /** Sends a notification on every stream a client holds open. */
  notify(method: string): void;
  /** Stops listening, so a connection is refused, until `resume`. */
  pause(): Promise<void>;
  /** Listens again, on the same port. */
  resume(): Promise<void>;
}
export async function mcpStub(
  t: TestContext,
  options: StubOptions = {},
): Promise<McpStub> {
  const requests: StubRequest[] = [];
  // Requests the stub sent a client, by id, waiting for its answer
  const asked = new Map<string, (reply: StubRequest['reply']) => void>();
  let sent = 0;
  let stream: ServerResponse | undefined;
  const pushed: ServerResponse[] = [];
  const answer = async (request: StubRequest): Promise<unknown> => {
    const message = request.message!;
    if (message.method === 'initialize') {
      const instructions = options.instructions?.();
      return {
        protocolVersion: message.params?.protocolVersion,
        capabilities: {
          tools: options.listChanged ? { listChanged: true } : {},
          ...options.capabilities,
        },
        serverInfo: { name: options.name ?? 'files-server', version: '1' },
        ...(instructions === undefined ? {} : { instructions }),
      };
    }
    if (message.method === 'tools/list') {
      if (!options.pages) return { tools: options.tools ?? [] };
      const page = Number(message.params?.cursor ?? 0);
      return {
        tools: options.pages[page] ?? [],
        ...(page + 1 < options.pages.length
          ? { nextCursor: String(page + 1) }
          : {}),
      };
    }
    if (message.method === 'tools/call')
      return options.call
        ? options.call(request)
        : {
            content: [
              {
                type: 'text',
                text: request.reply
                  ? `asked: ${JSON.stringify(request.reply)}`
                  : `ran ${String(message.params?.name)}`,
              },
            ],
          };
    return (await options.answer?.(request)) ?? {};
  };
  const server = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    const request: StubRequest = {
      method: incoming.method ?? '',
      path: incoming.url ?? '',
      headers: incoming.headers,
      body,
    };
    if (body)
      try {
        request.message = JSON.parse(body) as StubRequest['message'];
      } catch {
        /* Not JSON-RPC: kept as it came. */
      }
    requests.push(request);
    if (options.connectionClose) response.setHeader('Connection', 'close');
    if (options.drop?.(request)) {
      incoming.socket.destroy();
      return;
    }
    const refused = options.refuse?.(request);
    if (refused) {
      response.writeHead(refused.status).end(refused.body);
      return;
    }
    if (request.method === 'GET' && request.path === '/sse') {
      stream = response;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: endpoint\ndata: /messages\n\n');
      return;
    }
    if (
      options.listChanged &&
      request.method === 'GET' &&
      request.path === '/mcp'
    ) {
      pushed.push(response);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      return;
    }
    if (request.method === 'GET' && options.get) {
      const found = options.get(
        request.path,
        `http://${String(incoming.headers.host)}`,
      );
      if (found !== undefined) {
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(found));
        return;
      }
    }
    if (request.method !== 'POST' || !request.message) {
      response.writeHead(405).end();
      return;
    }
    // The client's answer to a request the stub sent it
    if (
      request.message.method === undefined &&
      request.message.id !== undefined
    ) {
      asked.get(String(request.message.id))?.(
        request.message as StubRequest['reply'] & object,
      );
      response.writeHead(202).end();
      return;
    }
    if (request.message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    if (options.endStream?.(request)) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end();
      return;
    }
    // Messages that go before the answer are sent at once, so a client reads them while the answer is made
    const first =
      request.path === '/messages' ? undefined : options.before?.(request);
    const ask =
      request.path !== '/messages' && request.message.method === 'tools/call'
        ? options.serverRequest?.(request)
        : undefined;
    if (first?.length || ask)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const message of first ?? [])
      response.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', ...message })}\n\n`,
      );
    if (ask) {
      const id = `server-${++sent}`;
      const answered = new Promise<StubRequest['reply']>((resolve) =>
        asked.set(id, resolve),
      );
      response.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, ...ask })}\n\n`,
      );
      request.reply = await answered;
    }
    const reply = JSON.stringify({
      jsonrpc: '2.0',
      id: request.message.id,
      result: await answer(request),
    });
    if (first?.length || ask) {
      response.end(`event: message\ndata: ${reply}\n\n`);
      return;
    }
    if (request.path === '/messages') {
      stream?.write(`event: message\ndata: ${reply}\n\n`);
      response.writeHead(202).end();
    } else
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(reply);
  });
  cleanupServer(t, server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw Error('no stub address');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    url: `${base}/mcp`,
    sseUrl: `${base}/sse`,
    requests,
    calls: () =>
      requests.filter((request) => request.message?.method === 'tools/call'),
    notify: (method) => {
      const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method })}\n\n`;
      for (const open of [...pushed, ...(stream ? [stream] : [])])
        open.write(event);
    },
    pause: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    resume: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(address.port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      }),
  };
}
