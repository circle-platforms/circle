// The Hub and GitHub extensions on the extensions page, the MCP servers page and the Hub's own page, with a synthetic
// runtime: the Hub is an MCP server entry named Hub that the bundled hub extension keeps.
import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { LiveRuntime } from '../src/model/live';
import { circlePlugins } from '../src/plugins/builtins';
import { createFixtures } from '../src/preview/fixtures';
import { setLanguage } from '../src/i18n';
import type { McpServer } from '../src/model/types';
import type { DesktopBridge } from '../../desktop/src/contracts';
import type {
  RuntimeCommand,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol';
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
const snapshot = createFixtures();
snapshot.runtime = { connected: true, configured: true };
snapshot.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
snapshot.interactions = [];
snapshot.requests = [];
snapshot.extensions = [
  {
    id: 'github',
    name: 'github',
    version: '0.1.0',
    scope: 'bundled',
    enabled: true,
    tools: ['github_connection'],
    commands: ['github'],
    events: [],
  },
  {
    id: 'hub',
    name: 'hub',
    version: '0.1.0',
    scope: 'bundled',
    enabled: true,
    tools: [],
    commands: ['hub'],
    events: [],
  },
];
const tool = (name: string) => ({
  name,
  description: 'synthetic Hub tool',
  schema: { type: 'object' },
});
const hub: McpServer = {
  id: 'Hub',
  name: 'Hub',
  transport: 'streamable_http',
  command: '',
  args: '',
  url: 'http://192.0.2.10:7420/mcp',
  enabled: true,
  status: 'connected',
  tools: [
    tool('Hub_get_nodes'),
    tool('Hub_start_run'),
    tool('Hub_submit_result'),
  ],
};
const other: McpServer = {
  id: 'files-server',
  name: 'files-server',
  transport: 'stdio',
  command: 'synthetic-files-server',
  args: '',
  url: '',
  enabled: true,
  status: 'connected',
  tools: [tool('files-server_read')],
};
snapshot.mcp = [hub, other];
let update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
let listener: ((value: RuntimeUpdate) => void) | undefined;
const commands: RuntimeCommand[] = [];
function emit() {
  update = {
    seq: update.seq + 1,
    connected: true,
    snapshot: structuredClone(snapshot),
  };
  listener?.(update);
}
const host = {
  runtimeState: async () => structuredClone(update),
  onRuntime: (callback: (value: RuntimeUpdate) => void) => {
    listener = callback;
    return () => {
      listener = undefined;
    };
  },
  onTerminalEvent: () => () => {},
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  setTheme: async () => {},
  browserState: async () => ({ sessionId: 'none' }),
  runtimeCommand: async (command: RuntimeCommand) => {
    if (command.name !== 'workspace-service') commands.push(command);
    // No Hub answers at the address typed: what findHub says when every candidate is silent
    if (command.name === 'hub-connect')
      return {
        id: command.id,
        ok: false,
        error:
          'no Circle Hub answers at https://192.0.2.10, http://192.0.2.10, https://192.0.2.10:7420 or http://192.0.2.10:7420',
      };
    return { id: command.id, ok: true };
  },
} as unknown as DesktopBridge;
window.circleDesktop = host;
const runtime = new LiveRuntime(host, update);
Object.assign(window, {
  hubExtensionFixture: {
    commands,
    snapshot: () => runtime.getSnapshot(),
    // No Hub yet: its page asks for the IP address
    removeHub: () => {
      snapshot.mcp = [other];
      emit();
    },
    // A Hub entry whose sign-in is under way, by the browser or with a code to type
    signingIn: (code?: string) => {
      snapshot.mcp = [
        {
          ...hub,
          status: 'not connected',
          tools: [],
          signIn: {
            url: 'http://192.0.2.10:7420/oauth/authorize',
            ...(code ? { code } : {}),
          },
        },
        other,
      ];
      emit();
    },
  },
});
location.hash = query.get('route') ?? '/page/extensions';
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
