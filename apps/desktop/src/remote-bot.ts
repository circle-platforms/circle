import {
  buildMcpConnections,
  backgroundMcpConnection,
} from '../../../src/mcp_loader.js';
import { loadSettings } from '../../../src/settings.js';
import { loadSecrets } from '../../../src/secrets.js';
import { HUB_SERVER } from '../../../src/hub_connection.js';
import { VERSION } from '../../../src/version.js';
import type { McpBearerConnection } from '../../../src/mcp_loader.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const BOT_CODE_FALLBACKS: Readonly<Record<string, string>> = {
  BOT_VERSION_MISMATCH: 'client version outdated',
  BOT_VERSION_INVALID: 'invalid bot client version',
  BOT_DISABLED: 'remote bot disabled',
  BOT_CLIENT_FORBIDDEN: 'oauth client token rejected',
  BOT_UNAUTHENTICATED: 'bot sign-in expired',
  BOT_NOT_FOUND: 'remote bot resource not found',
  BOT_CONFLICT: 'remote bot state conflict',
  BOT_QUOTA_EXCEEDED: 'bot attachment quota exceeded',
  BOT_INVALID_REQUEST: 'invalid remote bot request',
  BOT_BUSY: 'remote bot busy',
  BOT_REQUEST_TIMEOUT: 'remote bot request timed out',
  BOT_UPSTREAM_UNAVAILABLE: 'remote bot unavailable',
};

export class RemoteBotError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly remoteMessage?: string;

  constructor(
    message: string,
    options?: { status?: number; code?: string; remoteMessage?: string },
  ) {
    super(message);
    this.name = 'RemoteBotError';
    if (options?.status !== undefined) this.status = options.status;
    if (options?.code !== undefined) this.code = options.code;
    if (options?.remoteMessage !== undefined)
      this.remoteMessage = options.remoteMessage;
  }
}

/** Reject plain HTTP endpoints beyond loopback before sending Bearer tokens or files. */
export function botServerUrl(server: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(path, server);
  } catch {
    throw new Error('invalid remote bot server');
  }
  const protocol = url.protocol.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(hostname);
  if (protocol !== 'https:' && !(protocol === 'http:' && isLoopback)) {
    throw new Error('remote bot requires https or loopback http');
  }
  return url;
}

export async function parseRemoteBotError(
  response: Response,
  fallbackMessage: string,
): Promise<RemoteBotError> {
  let code: string | undefined;
  let remoteMessage: string | undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (/json/i.test(contentType)) {
    try {
      const text = await response.text();
      const parsed = JSON.parse(text) as {
        code?: unknown;
        message?: unknown;
      } | null;
      if (typeof parsed?.code === 'string' && parsed.code) code = parsed.code;
      if (typeof parsed?.message === 'string' && parsed.message)
        remoteMessage = parsed.message;
    } catch {
      // Ignore malformed JSON payloads and fall back to status/generic message.
    }
  } else {
    await response.body?.cancel();
  }
  const message =
    remoteMessage ??
    (code ? BOT_CODE_FALLBACKS[code] : undefined) ??
    fallbackMessage;
  return new RemoteBotError(message, {
    status: response.status,
    code,
    remoteMessage,
  });
}

export function remoteBotPort(home: string, binding?: string) {
  const connection = buildMcpConnections(
    loadSettings(home).mcpServers,
  ).connections.find((c) => c.name === HUB_SERVER);
  if (!connection) throw new Error('remote bot unavailable');
  const port = backgroundMcpConnection(home, connection, () =>
    loadSecrets(home),
  );
  if (binding !== undefined && port.binding !== binding)
    throw new Error('remote bot connection changed');
  return port;
}

export async function fetchWithRefresh(
  port: McpBearerConnection,
  signal: AbortSignal,
  attempt: (token: string) => Promise<Response>,
) {
  const send = (token: string) => {
    port.assertActive();
    return attempt(token);
  };
  const token = await port.token(signal);
  let response = await send(token);
  if (response.status === 401) {
    await response.body?.cancel();
    response = await send(await port.token(signal, token));
  }
  port.assertActive();
  return response;
}

export async function remoteBotRequest(
  port: McpBearerConnection,
  payload: Record<string, unknown>,
  fetcher = fetch,
) {
  const { binding, ...op } = payload;
  if (op.action !== 'discover' && binding !== port.binding)
    throw new Error('remote bot connection changed');
  if (
    !['discover', 'history', 'send', 'stop', 'new'].includes(String(op.action))
  )
    throw new Error('unknown remote bot operation');
  const url = botServerUrl(port.server, '/api/bot/v1');
  const signal = AbortSignal.timeout(25000);
  const response = await fetchWithRefresh(port, signal, (token) =>
    fetcher(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'bot-client-version': VERSION,
      },
      body: JSON.stringify(op),
    }),
  );
  if (!response.ok) {
    throw await parseRemoteBotError(response, 'remote bot unavailable');
  }
  const result = await response.json();
  return { ...result, binding: port.binding };
}
