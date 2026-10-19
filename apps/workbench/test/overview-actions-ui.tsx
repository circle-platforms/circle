import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { createFixtures } from '../src/preview/fixtures';
import { setLanguage } from '../src/i18n';
import type { DesktopBridge } from '../../desktop/src/contracts';

// The preview's conversation with its overview, changes and files, behind a desktop host
// that records what the window hands it: links opened, text copied, a CI log read.
const query = new URLSearchParams(location.search);
const data = createFixtures();
data.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
data.sessions[0]!.state = 'idle';
data.requests = [];
const runtime = new PreviewRuntime({
  getItem: () => JSON.stringify(data),
  setItem: () => {},
  removeItem: () => {},
});
const calls: { call: string; args: unknown[] }[] = [];
const noop = async () => {};
window.circleDesktop = new Proxy(
  {
    setTheme: noop,
    copyText: async (text: string) => {
      calls.push({ call: 'copyText', args: [text] });
    },
    openExternal: async (url: string) => {
      calls.push({ call: 'openExternal', args: [url] });
    },
    popouts: async () => [],
    runtimeCommand: async (command: any) => {
      const { service, method, params } = command.payload ?? {};
      calls.push({ call: `${service}.${method}`, args: [params] });
      if (service === 'pulls' && method === 'failedLog')
        return {
          ok: true,
          data: { text: 'FAIL test/reconnect.test.ts', truncated: false },
        };
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
Object.assign(window, {
  overviewFixture: {
    calls,
    requests: () =>
      runtime.getSnapshot().requests.map((request) => ({
        kind: request.kind,
        payload: request.payload,
      })),
  },
});
setLanguage(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en');
location.hash = `/session/${data.sessions[0]!.id}`;
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
