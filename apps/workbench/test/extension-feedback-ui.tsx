import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { LiveRuntime } from '../src/model/live';
import { circlePlugins } from '../src/plugins/builtins';
import { createFixtures } from '../src/preview/fixtures';
import { setLanguage, t } from '../src/i18n';
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
    enabled: false,
    tools: [],
    commands: [],
    events: [],
  },
  {
    id: 'observer',
    name: 'observer',
    version: '1',
    scope: 'project',
    enabled: true,
    tools: [],
    commands: [],
    events: [],
  },
];
let update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
let listener: ((value: RuntimeUpdate) => void) | undefined;
const commands: RuntimeCommand[] = [];
const pending = new Map<number, (reply: unknown) => void>();
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
  // Device consoles: none in this fixture.
  onTerminalEvent: () => () => {},
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  setTheme: async () => {},
  browserState: async () => ({ sessionId: 'none' }),
  runtimeCommand: async (command: RuntimeCommand) => {
    // The conversation behind the settings dialog asks for its folder's state. This
    // fixture counts the settings it is asked to save, not those questions.
    if (command.name !== 'workspace-service') commands.push(command);
    if (command.name === 'save-settings')
      return await new Promise((resolve) =>
        pending.set(commands.length - 1, resolve),
      );
    return { id: command.id, ok: true };
  },
} as unknown as DesktopBridge;
window.circleDesktop = host;
const runtime = new LiveRuntime(host, update);
Object.assign(window, {
  extensionFeedbackFixture: {
    commands,
    reply: (index: number, failure = false) => {
      const command = commands[index],
        reply = pending.get(index);
      if (!reply) throw Error('save is not pending');
      pending.delete(index);
      if (!failure) {
        const rows = command.payload.extensions as Array<{
          name: string;
          enabled: boolean;
        }>;
        for (const row of rows) {
          const item = snapshot.extensions.find(
            (item) => item.name === row.name,
          )!;
          item.enabled = row.enabled;
          delete item.view;
          delete item.error;
        }
        emit();
      }
      reply({
        id: command.id,
        ok: !failure,
        ...(failure ? { error: 'synthetic local settings write failure' } : {}),
      });
    },
    load: (failure = false) => {
      const extension = snapshot.extensions[0];
      if (!extension.enabled) return;
      if (failure) extension.error = 'synthetic module initialization failure';
      else {
        extension.view = {
          provider: 'github',
          client: 'GitHub CLI',
          epoch: 1,
          state: 'disconnected',
          repositories: [],
          remoteRevocation: 'not-requested',
        };
        extension.commands = ['github'];
      }
      emit();
    },
    // An enabled snapshot that arrives after the switch was turned off.
    stale: () => {
      const extension = snapshot.extensions[0];
      extension.enabled = true;
      extension.view = {
        provider: 'github',
        client: 'GitHub CLI',
        epoch: 1,
        state: 'disconnected',
        repositories: [],
        remoteRevocation: 'not-requested',
      };
      emit();
    },
    settle: () => {
      const extension = snapshot.extensions[0];
      extension.enabled = false;
      delete extension.view;
      delete extension.error;
      emit();
    },
    labels: {
      savingOn: t('saving extension enable request'),
      savingOff: t('saving extension disable request'),
      loading: t('enabling extension'),
      disabled: t('extension disabled'),
      enabled: t('extension enabled'),
      saveError: t('extension setting could not be saved'),
      loadError: t('extension could not be loaded'),
      reload: t('extension setting saved; reload required'),
      disabling: t('disabling extension'),
      interface: t('interface components'),
      runtime: t('runtime extensions'),
      reloadButton: t('reload'),
    },
    snapshot: () => runtime.getSnapshot(),
  },
});
location.hash = '/page/extensions';
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
