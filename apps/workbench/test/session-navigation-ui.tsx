import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { LiveRuntime } from '../src/model/live';
import { circlePlugins } from '../src/plugins/builtins';
import { createFixtures } from '../src/preview/fixtures';
import { setLanguage } from '../src/i18n';
import type { DesktopBridge } from '../../desktop/src/contracts';
import type {
  RuntimeCommand,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol';
setLanguage('en');
const snapshot = createFixtures();
snapshot.sessions = snapshot.sessions.slice(0, 3);
for (const [index, session] of snapshot.sessions.entries()) {
  session.id = [
    'navigation-history',
    'navigation-alternate',
    'navigation-third',
  ][index]!;
  session.title = [
    'navigation history',
    'navigation alternate',
    'navigation third',
  ][index]!;
  session.messages = [
    {
      id: `body-${index}`,
      parentId: null,
      role: 'assistant',
      text: `ACTUAL_VISIBLE_NAVIGATION_${index}`,
      at: '2026-10-16T00:00:00Z',
    },
  ];
  session.leafId = `body-${index}`;
  session.branchIds = [`body-${index}`];
  session.state = 'idle';
  session.hiddenIds = [];
  session.draft = 'retained navigation draft';
}
snapshot.activeSessionId = 'navigation-history';
snapshot.runtime = { connected: true, configured: true };
snapshot.settings.theme = 'dark';
snapshot.interactions = [];
snapshot.requests = [];
let update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
let listener: ((value: RuntimeUpdate) => void) | undefined;
const commands: RuntimeCommand[] = [];
const pending = new Map<string, (reply: any) => void>();
const host = {
  runtimeCommand: async (command: RuntimeCommand) => {
    commands.push(command);
    if (command.name === 'select-session')
      return await new Promise((resolve) =>
        pending.set(String(command.payload.id), resolve),
      );
    return { id: command.id, ok: true };
  },
  runtimeState: async () => structuredClone(update),
  onRuntime: (callback: (value: RuntimeUpdate) => void) => {
    listener = callback;
    return () => {
      listener = undefined;
    };
  },
} as unknown as DesktopBridge;
const runtime = new LiveRuntime(host, update);
Object.assign(window, {
  navigationFixture: {
    runtime,
    commands,
    pending,
    publish(id: string) {
      update = {
        seq: update.seq + 1,
        connected: true,
        snapshot: { ...structuredClone(update.snapshot), activeSessionId: id },
      };
      listener?.(structuredClone(update));
    },
    resolve(id: string) {
      const command = commands.findLast(
        (command) =>
          command.name === 'select-session' && command.payload.id === id,
      )!;
      pending.get(id)?.({ id: command.id, ok: true, data: { sessionId: id } });
      pending.delete(id);
    },
  },
});
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
