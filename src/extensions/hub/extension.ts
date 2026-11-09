import type { ExtensionAPI } from '../../extensions.js';
// The Hub extension: in the desktop application its page takes a Hub's address and keeps the MCP entry named Hub
// (src/hub_connection.ts); the sign-in is the MCP authorization of any server, by a one-time code where the Hub
// offers it. Here it only says where that is done. No Hub address is built in.
const HUB_HINT =
  'Connect a Circle Hub in Settings → Capabilities → Extensions → Hub (设置 → 能力 → 扩展 → Hub): type its address, then enter the code Circle shows on the page that opens. In the terminal, add the Hub to mcp_servers in settings.json as {"name": "Hub", "url": "<address>/mcp", "transport": "streamable_http"}; /mcp then shows the code and the page.';
export function register(api: ExtensionAPI) {
  api.registerCommand(
    'hub',
    'how to connect a circle hub',
    async (_args, context) => {
      context.append(HUB_HINT);
    },
  );
}
