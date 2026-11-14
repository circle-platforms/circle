import type { ExtensionAPI, McpServerState } from '../../extensions.js';
import { findHub, hubEntry } from '../../hub_connection.js';
// The Hub extension: given a Hub's address, it finds the Hub's MCP endpoint and saves the MCP entry named Hub
// (src/hub_connection.ts), in the desktop from its page and in the terminal from /hub. The sign-in is the MCP
// authorization of any server. No Hub address is built in.
const HUB_HINT =
  "Connect a Circle Hub: /hub <its IP address or URL>. Circle finds the Hub's MCP endpoint, saves the MCP entry named Hub and connects it. Sign in on the page it then shows: with the invite code the Hub's administrator gave you, or after signing in to the Hub's console in that browser. Circle keeps the sign-in in mcp-auth.json in its data folder. /mcp shows the entry and its tools; in the desktop the same is under Settings → Capabilities → Extensions → Hub (设置 → 能力 → 扩展 → Hub).";

function stateLine(state: McpServerState, endpoint: string): string {
  if (state.state === 'signing-in')
    return [
      `Hub saved: ${endpoint}. Sign in on this page: ${state.signIn}`,
      ...(state.code ? [`and type this code there: ${state.code}`] : []),
      "Use the invite code from the Hub's administrator, or sign in to the Hub's console in that browser first. /mcp shows the Hub's tools once you have signed in.",
    ].join('\n');
  if (state.state === 'failed')
    return `Hub saved: ${endpoint}, but it could not connect: ${state.error ?? 'no reason given'}. Fix that, then /mcp reload ${state.name}.`;
  return `Hub connected: ${endpoint} · ${state.tools} tools.`;
}

export function register(api: ExtensionAPI) {
  api.registerCommand(
    'hub',
    'connect a circle hub: /hub <IP address or URL>',
    async (args, context) => {
      const typed = args.trim();
      if (!typed) {
        context.append(HUB_HINT);
        return;
      }
      let endpoint: string;
      try {
        endpoint = await findHub(typed);
      } catch (error) {
        context.append(
          `No Circle Hub found at ${typed}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      context.append(
        stateLine(await api.saveMcpServer(hubEntry(endpoint)), endpoint),
      );
    },
  );
}
