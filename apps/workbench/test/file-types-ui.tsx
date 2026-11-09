import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { LiveRuntime } from '../src/model/live';
import { setLanguage } from '../src/i18n';
import { createFixtures } from '../src/preview/fixtures';
import type { Message } from '../src/model/types';
import type { DesktopBridge } from '../../desktop/src/contracts';
import type { RuntimeUpdate } from '../../desktop/src/runtime-protocol';

// The window as it runs, whose answer links a picture and a file that is not text, behind
// a desktop host that finds both, reads the picture's bytes, refuses the other file as the
// desktop's documents do, and records what the window asks of it.
const query = new URLSearchParams(location.search);
setLanguage(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en');
const fixtures = createFixtures();
fixtures.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const session = fixtures.sessions[0]!;
fixtures.sessions = [session];
fixtures.activeSessionId = session.id;
fixtures.requests = [];
fixtures.interactions = [];
const at = new Date('2026-11-09T10:00:00').toISOString();
const messages: Message[] = [
  { id: 'ask', parentId: null, role: 'user', text: 'make the designs', at },
  {
    id: 'links',
    parentId: 'ask',
    role: 'assistant',
    at,
    text: 'See [the picture](.tmp/designs/a-light.png) and [the data](data/blob.bin).',
  },
];
Object.assign(session, {
  state: 'idle',
  messages,
  leafId: 'links',
  branchIds: ['ask', 'links'],
  todos: [],
  queue: [],
  attachments: [],
  hiddenIds: [],
});
// A picture two pixels wide and one high
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=';
const update = (): RuntimeUpdate => ({
  seq: 1,
  connected: true,
  tokenStream: { epoch: 'test', seq: 0 },
  snapshot: {
    ...fixtures,
    runtime: {
      connected: true,
      observedAt: at,
    } as (typeof fixtures)['runtime'],
  },
});
const calls: { call: string; params: unknown }[] = [];
const noop = async () => {};
const host = new Proxy(
  {
    setTheme: noop,
    popouts: async () => [],
    runtimeState: async () => update(),
    onRuntime: () => () => {},
    onRuntimeDelta: () => () => {},
    onRuntimeWait: () => () => {},
    listWorkspace: async () => null,
    revealWorkspace: async (workspaceId: string, path?: string) => {
      calls.push({ call: 'revealWorkspace', params: { workspaceId, path } });
    },
    runtimeCommand: async (command: any) => {
      const { service, method, params } = command.payload ?? {};
      calls.push({ call: `${service}.${method}`, params });
      if (service === 'documents' && method === 'resolveSource')
        return { ok: true, data: { path: params.path } };
      if (service === 'documents' && method === 'readImage')
        return {
          ok: true,
          data: {
            path: params.path,
            mime: 'image/png',
            data: PNG,
            size: 71,
          },
        };
      if (service === 'documents' && method === 'read')
        return { ok: false, error: 'binary files cannot be edited as text' };
      if (service === 'inputs')
        return { ok: true, data: { version: 0, items: [] } };
      if (service === 'events')
        return {
          ok: true,
          data: { events: [], cursor: { offset: 0, seq: 0 }, hasMore: false },
        };
      return { ok: true, data: [] };
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
window.circleDesktop = host;
Object.assign(window, {
  fileTypesFixture: { calls, workspaceId: session.workspaceId },
});
location.hash = `/session/${session.id}`;
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={new LiveRuntime(host, update())} plugins={[]} />,
);
