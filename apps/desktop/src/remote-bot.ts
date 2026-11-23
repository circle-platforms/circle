import {
  buildMcpConnections,
  backgroundMcpConnection,
} from '../../../src/mcp_loader.js';
import { loadSettings } from '../../../src/settings.js';
import { loadSecrets } from '../../../src/secrets.js';
import { HUB_SERVER } from '../../../src/hub_connection.js';
import { VERSION } from '../../../src/version.js';
import type { McpBearerConnection } from '../../../src/mcp_loader.js';

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
  const url = new URL('/api/bot/v1', port.server);
  const signal = AbortSignal.timeout(25000);
  const response = await fetchWithRefresh(port, signal, (token) =>
    fetcher(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'circle-version': VERSION,
      },
      body: JSON.stringify(op),
    }),
  );
  if (!response.ok) {
    let message: unknown;
    try {
      const text = await response.text();
      message = (JSON.parse(text) as { message?: unknown } | null)?.message;
    } catch {
      message = undefined;
    }
    throw new Error(
      typeof message === 'string' ? message : 'remote bot unavailable',
    );
  }
  const result = await response.json();
  return { ...result, binding: port.binding };
}
