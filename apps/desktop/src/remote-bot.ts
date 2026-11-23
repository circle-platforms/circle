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
  const send = async (token: string) => {
    port.assertActive();
    return fetcher(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'circle-version': VERSION,
      },
      body: JSON.stringify(op),
    });
  };
  const token = await port.token(signal);
  let response = await send(token);
  if (response.status === 401) {
    await response.body?.cancel();
    response = await send(await port.token(signal, token));
  }
  const result = await response.json();
  port.assertActive();
  if (!response.ok)
    throw new Error(
      typeof result?.message === 'string'
        ? result.message
        : 'remote bot unavailable',
    );
  return { ...result, binding: port.binding };
}
