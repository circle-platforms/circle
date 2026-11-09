import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { createFixtures } from '../src/preview/fixtures';
import { setLanguage } from '../src/i18n';
import type { DesktopBridge } from '../../desktop/src/contracts';

// A conversation with a plan, whose answer links its plan, another file the model wrote in
// the plan folder and one that is not there, behind a desktop host that records what the
// window asks and reads the plan folder as the controller does.
const query = new URLSearchParams(location.search);
const data = createFixtures();
data.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
data.requests = [];
const session = data.sessions[0]!;
session.state = 'idle';
const plan = `/session_plans/${session.id}.md`;
session.plan = {
  file: plan,
  text: '# The plan\n\nSYNTHETIC-PLAN\n',
  updatedAt: '2026-11-09T10:00:00.000Z',
};
const last = session.messages.at(-1)!;
session.messages.push({
  id: 'plan-folder-links',
  parentId: last.id,
  role: 'assistant',
  at: '10:40',
  text: `See [the review](/session_plans/proposal-review.md), [the plan](${plan}) and [the draft](/session_plans/missing.md).`,
});
session.leafId = 'plan-folder-links';
session.branchIds = [...(session.branchIds ?? []), 'plan-folder-links'];
const runtime = new PreviewRuntime({
  getItem: () => JSON.stringify(data),
  setItem: () => {},
  removeItem: () => {},
});
const calls: { call: string; params: unknown }[] = [];
const noop = async () => {};
window.circleDesktop = new Proxy(
  {
    setTheme: noop,
    popouts: async () => [],
    runtimeCommand: async (command: any) => {
      const { service, method, params } = command.payload ?? {};
      calls.push({ call: `${service}.${method}`, params });
      if (service === 'documents' && method === 'readPlanFolder')
        return params.path === '/session_plans/proposal-review.md'
          ? {
              ok: true,
              data: {
                file: params.path,
                text: '# Review\n\nSYNTHETIC-REVIEW\n',
                updatedAt: '2026-11-09T10:30:00.000Z',
              },
            }
          : { ok: false, error: `${params.path} does not exist` };
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
Object.assign(window, { planFolderFixture: { calls, plan } });
setLanguage(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en');
location.hash = `/session/${session.id}`;
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
