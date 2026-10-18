import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { LiveRuntime } from '../src/model/live';
import { createFixtures } from '../src/preview/fixtures';
import { circlePlugins } from '../src/plugins/builtins';
import { setLanguage } from '../src/i18n';
import type { DesktopBridge } from '../../desktop/src/contracts';
const setup = await fetch('/owner-fixture').then((r) => r.json());
setLanguage('en');
const snapshot = createFixtures();
snapshot.workspaces = setup.workspaces;
snapshot.sessions = ['a', 'b'].map((id, index) => ({
  ...snapshot.sessions[0]!,
  id,
  title: 'owner ' + id,
  workspaceId: id,
  messages: [],
  branchIds: [],
  leafId: null,
  state: 'idle',
  draft: 'composer ' + id,
  hiddenIds: [],
}));
snapshot.activeSessionId = 'a';
snapshot.runtime = { connected: true, configured: true };
snapshot.interactions = [];
snapshot.requests = [];
// Synthetic connection view only; all delivery traffic stays on the local fixture.
snapshot.extensions = [
  {
    id: 'bundled:github',
    scope: 'bundled',
    name: 'github',
    enabled: true,
    tools: ['github_connection'],
    commands: [],
    events: [],
    view: {
      provider: 'github',
      client: 'GitHub CLI',
      state: 'connected',
      epoch: 1,
      repositories: ['fixture/repo'],
    },
  } as any,
];
let update: any = { seq: 0, connected: true, snapshot };
let listener: any;
const host = {
  setTheme: async () => {},
  // Device consoles: none in this fixture.
  onTerminalEvent: () => () => {},
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  browserState: async () => ({ tabs: [], dialogs: [], downloads: [] }),
  runtimeState: async () => structuredClone(update),
  onRuntime: (cb: any) => {
    listener = cb;
    return () => {};
  },
  runtimeCommand: async (command: any) => {
    if (command.name === 'workspace-service')
      return fetch('/owner-command', {
        method: 'POST',
        body: JSON.stringify(command),
      }).then((r) => r.json());
    if (command.name === 'select-session') {
      update = {
        ...update,
        seq: update.seq + 1,
        snapshot: { ...update.snapshot, activeSessionId: command.payload.id },
      };
      listener?.(structuredClone(update));
      return {
        id: command.id,
        ok: true,
        data: { sessionId: command.payload.id },
      };
    }
    return { id: command.id, ok: true };
  },
} as unknown as DesktopBridge;
const runtime = new LiveRuntime(host, update);
Object.assign(window, { circleDesktop: host, ownerFixture: { runtime } });
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
