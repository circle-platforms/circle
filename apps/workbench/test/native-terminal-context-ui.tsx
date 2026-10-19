import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
import type { DesktopBridge } from '../../desktop/src/contracts';
const query = new URLSearchParams(location.search);
applyTheme(query.get('theme') === 'dark' ? 'dark' : 'light');
setLanguage('en');
const runtime = new PreviewRuntime(localStorage);
runtime.change((state) => {
  state.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
  state.sessions = state.sessions.slice(0, 2).map((session, index) => ({
    ...session,
    id: index ? 'B' : 'A',
    title: index ? 'context B' : 'context A',
    draft: index ? 'unsent B draft' : 'unsent A draft',
    attachments: [],
    messages: [],
    state: 'idle',
  }));
  state.activeSessionId = 'A';
});
const selectedText = 'CIRCLE_SELECTED_中文';
let closeCalls = 0,
  sends = 0,
  hold = false,
  pending = false;
let release: (() => void) | undefined;
const snapshot = (sessionId: string) => ({
  id: sessionId + '-terminal',
  owner: sessionId,
  sessionId,
  epoch: 'fixture-epoch',
  cwd: '/synthetic/workspace',
  shell: 'synthetic',
  args: [],
  label: 'fixture terminal',
  pid: 12345,
  cols: 120,
  rows: 24,
  status: 'running',
  startedAt: new Date(0).toISOString(),
  lastSequence: 1,
  logPath: '/synthetic/log',
  kind: 'shell',
});
const noop = async () => {};
window.circleDesktop = new Proxy(
  {
    setTheme: noop,
    onWorkspaceEvent: () => () => {},
    onBrowserEvent: () => () => {},
    browserState: async () => ({ sessionId: 'none' }),
    // No mode is in a window of its own, and no device console is open.
    popouts: async () => [],
    terminalState: async (sessionId: string) => ({
      sessionId: 'terminal:' + sessionId,
      conversation: sessionId,
      sessions: [],
      profiles: [],
    }),
    runtimeCommand: async (command: any) => {
      if (command.name !== 'workspace-service') {
        sends++;
        return { ok: true };
      }
      const { service, method, params } = command.payload;
      if (service !== 'terminal') throw Error('unexpected service ' + service);
      const item = snapshot(command.sessionId);
      if (method === 'list') return { ok: true, data: [item] };
      if (method === 'close' || method === 'stop') {
        closeCalls++;
        return { ok: true };
      }
      if (method === 'resize' || method === 'write') return { ok: true };
      if (method === 'replay') {
        if (hold && params.afterSequence === 1 && params.limit === 1) {
          hold = false;
          pending = true;
          await new Promise<void>((resolve) => {
            release = () => {
              pending = false;
              resolve();
            };
          });
        }
        return {
          ok: true,
          data: {
            snapshot: item,
            nextSequence: 1,
            events:
              params.afterSequence < 1
                ? [
                    {
                      terminalId: item.id,
                      sessionId: item.sessionId,
                      owner: item.owner,
                      epoch: item.epoch,
                      kind: 'data',
                      sequence: 1,
                      at: new Date(0).toISOString(),
                      data: selectedText + '\r\nsecond terminal line\r\n',
                    },
                  ]
                : [],
            hasMore: false,
          },
        };
      }
      throw Error('unexpected terminal operation ' + method);
    },
  },
  {
    get: (target, key) =>
      key in target
        ? (target as any)[key]
        : key.toString().startsWith('on')
          ? () => () => {}
          : noop,
  },
) as unknown as DesktopBridge;
(window as any).__terminalContextFixture = {
  selectedText,
  observe: () => ({
    activeSessionId: runtime.getSnapshot().activeSessionId,
    closeCalls,
    sends,
    pending,
    sessions: runtime
      .getSnapshot()
      .sessions.map(({ id, draft, attachments, messages }) => ({
        id,
        draft,
        attachments,
        messages,
      })),
  }),
  deferSelectionReplay: () => {
    hold = true;
  },
  release: () => release?.(),
  switchSession: (id: string) =>
    runtime.change((state) => {
      state.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
      state.activeSessionId = id;
    }),
};
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
