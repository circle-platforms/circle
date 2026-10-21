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
  annotations?: Record<string, unknown>;
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
}
export interface StubOptions {
  name?: string;
  tools?: StubTool[];
  /** The initialize result's `instructions`, read at each initialize. */
  instructions?: () => string | undefined;
  /** Answers tools/call; by default the text names the tool. */
  call?: (request: StubRequest) => StubResult | Promise<StubResult>;
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
}
export async function mcpStub(
  t: TestContext,
  options: StubOptions = {},
): Promise<McpStub> {
  const requests: StubRequest[] = [];
  let stream: ServerResponse | undefined;
  const answer = async (request: StubRequest): Promise<unknown> => {
    const message = request.message!;
    if (message.method === 'initialize') {
      const instructions = options.instructions?.();
      return {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: options.name ?? 'files-server', version: '1' },
        ...(instructions === undefined ? {} : { instructions }),
      };
    }
    if (message.method === 'tools/list') return { tools: options.tools ?? [] };
    if (message.method === 'tools/call')
      return options.call
        ? options.call(request)
        : {
            content: [
              { type: 'text', text: `ran ${String(message.params?.name)}` },
            ],
          };
    return {};
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
    if (request.method !== 'POST' || !request.message) {
      response.writeHead(405).end();
      return;
    }
    if (request.message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const reply = JSON.stringify({
      jsonrpc: '2.0',
      id: request.message.id,
      result: await answer(request),
    });
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
  };
}
