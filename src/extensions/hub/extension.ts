import type { ExtensionAPI } from '../../extensions.js';
// The Hub extension: in the desktop application its page takes a Hub's address and keeps the MCP entry named Hub
// (src/hub_connection.ts); the sign-in is the MCP authorization of any server, by a one-time code where the Hub
// offers it. Here it only says where that is done. No Hub address is built in.
const HUB_HINT =
  'Connect a Circle Hub in Settings → Capabilities → Extensions → Hub (设置 → 能力 → 扩展 → Hub): type its IP address, then sign in on the page that opens with your Hub user name and password, and enter the code Circle shows if it shows one. In the terminal, add the Hub to mcp_servers in settings.json as {"name": "Hub", "url": "http://<IP address>:7420/mcp", "transport": "streamable_http", "placeholders": {"url": "HUB_URL", "token": "HUB_TOKEN"}}; /mcp then shows the page to sign in on, and the placeholders give the commands of a Hub skill the address and token of the Hub.';
export function register(api: ExtensionAPI) {
  api.registerCommand(
    'hub',
    'how to connect a circle hub',
    async (_args, context) => {
      context.append(HUB_HINT);
    },
  );
}
