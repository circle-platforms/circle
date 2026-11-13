// What MCP server entries give the `%NAME%` placeholders of tool calls. An entry reached over HTTP may name, in its
// `placeholders`, a plain variable for its endpoint (`url`) and a secret for the Bearer token its connection sends
// (`token`): its Authorization header's, or else the one its sign-in keeps (mcp_auth.ts). A program a skill runs then
// reaches the same server as the person's connection, without a token being saved twice. Nothing is given unless the
// entry names it.
import { keptFor } from './mcp_auth.js';
import { buildMcpConnections, resolveHeaders } from './mcp_loader.js';
import { isRecord, VARIABLE_NAME, type CircleSettings } from './settings.js';

/**
 * The variables and secrets the enabled HTTP MCP entries name in `placeholders`. A name the person keeps a variable or a
 * secret under is theirs and is left out, as is a name an earlier entry took. A kept token past its expiry, or none, is
 * not given: the name then stays as written.
 */
export function mcpPlaceholders(
  home: string,
  settings: CircleSettings,
  saved: { variables: Record<string, string>; secrets: Record<string, string> },
): {
  variables: Record<string, string>;
  secrets: Record<string, string>;
  /** When the first kept token given expires, after which it is no longer given; Infinity when none expires. */
  until: number;
} {
  const variables: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  let until = Infinity;
  const free = (name: unknown): name is string =>
    typeof name === 'string' &&
    VARIABLE_NAME.test(name) &&
    ![saved.variables, saved.secrets, variables, secrets].some((values) =>
      Object.hasOwn(values, name),
    );
  const entries = settings.mcp_servers.filter(isRecord);
  // As the connections are made: an entry turned off, or an earlier one of the same name, gives nothing
  for (const connection of buildMcpConnections(settings.mcp_servers)
    .connections) {
    if (
      !connection.url ||
      !['streamable_http', 'sse'].includes(connection.transport)
    )
      continue;
    const entry = entries
      .filter((row) => row.name === connection.name && row.enabled !== false)
      .at(-1);
    const named = isRecord(entry?.placeholders) ? entry.placeholders : {};
    let server: URL;
    try {
      server = new URL(connection.url);
    } catch {
      continue;
    }
    if (server.protocol !== 'http:' && server.protocol !== 'https:') continue;
    if (free(named.url)) variables[named.url] = connection.url;
    if (free(named.token)) {
      const token = bearer(
        home,
        connection.headers,
        server.href,
        saved.secrets,
      );
      if (token) {
        secrets[named.token] = token.value;
        until = Math.min(until, token.until);
      }
    }
  }
  return { variables, secrets, until };
}

/** The Bearer token a connection sends: its Authorization header's, or else the one its sign-in keeps, and its expiry. */
function bearer(
  home: string,
  headers: Record<string, string> | undefined,
  server: string,
  secrets: Record<string, string>,
): { value: string; until: number } | undefined {
  let header: string | undefined;
  try {
    header = Object.entries(resolveHeaders(headers, process.env, secrets)).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )?.[1];
  } catch {
    // A header that names a secret or variable not set: the connection sends nothing
    return undefined;
  }
  if (header !== undefined) {
    const value = /^Bearer (\S+)$/i.exec(header)?.[1];
    return value ? { value, until: Infinity } : undefined;
  }
  const kept = keptFor(home, server);
  return kept.tokens?.access_token &&
    kept.tokens.token_type?.toLowerCase() === 'bearer' &&
    (kept.expires_at === undefined || kept.expires_at > Date.now())
    ? { value: kept.tokens.access_token, until: kept.expires_at ?? Infinity }
    : undefined;
}
