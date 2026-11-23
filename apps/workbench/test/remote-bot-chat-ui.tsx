import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { LiveRuntime } from '../src/model/live';
import { circlePlugins } from '../src/plugins/builtins';
import { createFixtures } from '../src/preview/fixtures';
import { setLanguage } from '../src/i18n';
import type { ChatFile } from '../../../src/remote_bot_protocol';
import type { McpServer } from '../src/model/types';
import type { DesktopBridge } from '../../desktop/src/contracts';
import type {
  RuntimeCommand,
  RuntimeReply,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol';

const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
const snapshot = createFixtures();
snapshot.runtime = { connected: true, configured: true };
snapshot.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
snapshot.interactions = [];
snapshot.requests = [];
const hub: McpServer = {
  id: 'Hub',
  name: 'Hub',
  transport: 'streamable_http',
  command: '',
  args: '',
  url: 'http://127.0.0.1:7420/mcp',
  enabled: true,
  status: 'connected',
  tools: [],
};
snapshot.mcp = [hub];

let discoverCalls = 0;
let nextFailure:
  { error: string; errorStatus?: number; errorCode?: string } | undefined = {
  error: 'remote bot unavailable',
  errorStatus: 502,
};
let attachOutcome:
  | { kind: 'files'; files: ChatFile[] }
  | { kind: 'cancel' }
  | { kind: 'error'; message: string } = {
  kind: 'files',
  files: [],
};

const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
const host = {
  runtimeState: async () => structuredClone(update),
  onRuntime: () => () => {},
  onTerminalEvent: () => () => {},
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  setTheme: async () => {},
  browserState: async () => ({ sessionId: 'none' }),
  terminalState: async (sessionId: string) => ({
    sessionId: 'terminal:' + sessionId,
    tabs: [],
    activeId: null,
  }),
  attachBotFiles: async () => {
    if (attachOutcome.kind === 'cancel') return null;
    if (attachOutcome.kind === 'error') throw new Error(attachOutcome.message);
    return attachOutcome.files;
  },
  saveBotFile: async () => true,
  runtimeCommand: async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.name === 'remote-bot') {
      const action = String(command.payload.action ?? '');
      if (action === 'discover') {
        discoverCalls++;
        if (nextFailure) {
          return {
            id: command.id,
            ok: false,
            error: nextFailure.error,
            ...(nextFailure.errorStatus !== undefined
              ? { errorStatus: nextFailure.errorStatus }
              : {}),
            ...(nextFailure.errorCode !== undefined
              ? { errorCode: nextFailure.errorCode }
              : {}),
          };
        }
        return {
          id: command.id,
          ok: true,
          data: {
            id: 'bot-1',
            name: 'Synth Bot',
            current: 'conv-1',
            binding: 'binding-1',
          },
        };
      }
      if (action === 'history') {
        if (nextFailure) {
          return {
            id: command.id,
            ok: false,
            error: nextFailure.error,
            ...(nextFailure.errorStatus !== undefined
              ? { errorStatus: nextFailure.errorStatus }
              : {}),
            ...(nextFailure.errorCode !== undefined
              ? { errorCode: nextFailure.errorCode }
              : {}),
          };
        }
        return {
          id: command.id,
          ok: true,
          data: {
            events: [],
            queued: [],
            deliveries: [],
            fileDeliveries: [],
            active: null,
            question: null,
          },
        };
      }
    }
    return { id: command.id, ok: true };
  },
} as unknown as DesktopBridge;
window.circleDesktop = host;
const runtime = new LiveRuntime(host, update);

Object.assign(window, {
  remoteBotUiFixture: {
    discoverCalls: () => discoverCalls,
    resetDiscoverCalls: () => {
      discoverCalls = 0;
    },
    setFailure: (failure?: {
      error: string;
      errorStatus?: number;
      errorCode?: string;
    }) => {
      nextFailure = failure;
    },
    setAttachFiles: (files: ChatFile[]) => {
      attachOutcome = { kind: 'files', files };
    },
    setAttachCancel: () => {
      attachOutcome = { kind: 'cancel' };
    },
    setAttachError: (message: string) => {
      attachOutcome = { kind: 'error', message };
    },
  },
});

location.hash = '/page/remote-bot';
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
