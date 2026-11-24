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
  hasAuthorizationHeader: false,
  settingsPath: '/tmp/circle-ui/runtime-home/settings.json',
  status: 'connected',
  tools: [],
};
snapshot.mcp = [hub];

let discoverCalls = 0;
let reloadCalls = 0;
let reauthorizePayloads: Array<{ name?: unknown; scope?: unknown }> = [];
let currentEvents: Array<{
  id: string;
  at: string;
  role: 'notice' | 'user' | 'assistant';
  text: string;
  code?: string;
  cursor: number;
}> = [];
let nextFailure:
  | {
      error: string;
      errorStatus?: number;
      errorCode?: string;
      errorDetail?: string;
      errorScope?: string;
    }
  | undefined = {
  error: 'remote bot unavailable',
  errorStatus: 502,
};
let attachOutcome:
  | { kind: 'files'; files: ChatFile[] }
  | { kind: 'cancel' }
  | {
      kind: 'error';
      message: string;
      status?: number;
      code?: string;
      detail?: string;
      errorUploaded?: number;
      errorTotal?: number;
      errorFileName?: string;
      errorReason?: string;
    } = {
  kind: 'files',
  files: [],
};

const listeners = new Set<(update: RuntimeUpdate) => void>();
let seq = 0;
const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
function emitSnapshot() {
  seq += 1;
  const next: RuntimeUpdate = {
    seq,
    connected: true,
    snapshot: structuredClone(snapshot),
  };
  for (const listener of listeners) listener(next);
}

const host = {
  runtimeState: async () => structuredClone({ ...update, seq, snapshot }),
  onRuntime: (listener: (u: RuntimeUpdate) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
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
    if (attachOutcome.kind === 'error') {
      throw Object.assign(new Error(attachOutcome.message), {
        ...(attachOutcome.status !== undefined
          ? { status: attachOutcome.status }
          : {}),
        ...(attachOutcome.code !== undefined
          ? { code: attachOutcome.code }
          : {}),
        ...(attachOutcome.detail !== undefined
          ? { detail: attachOutcome.detail }
          : {}),
        ...(attachOutcome.errorUploaded !== undefined
          ? { errorUploaded: attachOutcome.errorUploaded }
          : {}),
        ...(attachOutcome.errorTotal !== undefined
          ? { errorTotal: attachOutcome.errorTotal }
          : {}),
        ...(attachOutcome.errorFileName !== undefined
          ? { errorFileName: attachOutcome.errorFileName }
          : {}),
        ...(attachOutcome.errorReason !== undefined
          ? { errorReason: attachOutcome.errorReason }
          : {}),
      });
    }
    return attachOutcome.files;
  },
  saveBotFile: async () => true,
  runtimeCommand: async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.name === 'mcp-reload-server' || command.name === 'reload') {
      reloadCalls += 1;
      return { id: command.id, ok: true };
    }
    if (command.name === 'mcp-reauthorize-server') {
      reauthorizePayloads.push({
        name: command.payload.name,
        scope: command.payload.scope,
      });
      return { id: command.id, ok: true };
    }
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
            ...(nextFailure.errorDetail !== undefined
              ? { errorDetail: nextFailure.errorDetail }
              : {}),
            ...(nextFailure.errorScope !== undefined
              ? { errorScope: nextFailure.errorScope }
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
            ...(nextFailure.errorDetail !== undefined
              ? { errorDetail: nextFailure.errorDetail }
              : {}),
            ...(nextFailure.errorScope !== undefined
              ? { errorScope: nextFailure.errorScope }
              : {}),
          };
        }
        const after = Number(command.payload.after ?? 0);
        return {
          id: command.id,
          ok: true,
          data: {
            events: currentEvents.filter((event) => event.cursor > after),
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
    reloadCalls: () => reloadCalls,
    reauthorizeCalls: () => reauthorizePayloads.length,
    reauthorizePayloads: () => reauthorizePayloads,
    resetDiscoverCalls: () => {
      discoverCalls = 0;
    },
    resetReloadCalls: () => {
      reloadCalls = 0;
    },
    resetReauthorizeCalls: () => {
      reauthorizePayloads = [];
    },
    setHubStatus: (status: McpServer['status'], error?: string) => {
      hub.status = status;
      hub.error = error;
      emitSnapshot();
    },
    setHubSignIn: (signIn?: McpServer['signIn']) => {
      hub.signIn = signIn;
      emitSnapshot();
    },
    setHubConfig: (config: {
      hasAuthorizationHeader?: boolean;
      settingsPath?: string;
    }) => {
      hub.hasAuthorizationHeader = config.hasAuthorizationHeader;
      hub.settingsPath = config.settingsPath;
      emitSnapshot();
    },
    setEvents: (events: typeof currentEvents) => {
      currentEvents = events;
    },
    setFailure: (failure?: {
      error: string;
      errorStatus?: number;
      errorCode?: string;
      errorDetail?: string;
      errorScope?: string;
    }) => {
      nextFailure = failure;
    },
    setAttachFiles: (files: ChatFile[]) => {
      attachOutcome = { kind: 'files', files };
    },
    setAttachCancel: () => {
      attachOutcome = { kind: 'cancel' };
    },
    setAttachError: (
      input:
        | string
        | {
            message: string;
            status?: number;
            code?: string;
            detail?: string;
            errorUploaded?: number;
            errorTotal?: number;
            errorFileName?: string;
            errorReason?: string;
          },
    ) => {
      attachOutcome =
        typeof input === 'string'
          ? { kind: 'error', message: input }
          : { kind: 'error', ...input };
    },
  },
});

location.hash = '/page/remote-bot';
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
