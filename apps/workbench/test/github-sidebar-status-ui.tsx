import { Tooltip } from 'radix-ui';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { RuntimeProvider } from '../src/app/context';
import { PluginProvider } from '../src/plugins/context';
import { Sidebar } from '../src/components/Sidebar';
import { PreviewRuntime } from '../src/model/state';
import { setLanguage, useLocale } from '../src/i18n';
import { applyTheme } from '../src/theme';
import type { RuntimeExtension } from '../src/model/types';
import '../src/styles/app.css';
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
applyTheme(query.get('theme') === 'dark' ? 'dark' : 'light');
const runtime = new PreviewRuntime();
const row = (
  id: string,
  name: string,
  scope: RuntimeExtension['scope'],
  text: string,
): RuntimeExtension => ({
  id,
  name,
  scope,
  status: { text, lamp: 'none' },
  view: { provider: 'github', state: text },
  enabled: true,
  version: '0.1.0',
  tools: [],
  commands: [],
  events: [],
});
runtime.change((state) => {
  state.extensions = [
    row('github', 'github', 'bundled', 'disconnected'),
    row('project', 'github', 'project', 'disconnected'),
    row('thirdparty', 'thirdparty', 'user', 'disconnected'),
    row('custom', 'github', 'bundled', 'custom operation 中文'),
    row('future', 'github', 'bundled', 'future-state'),
  ];
  state.interactions = [];
  state.requests = [];
});
Object.assign(window, {
  sidebarStatusFixture: {
    state: (value: string) =>
      runtime.change((snapshot) => {
        snapshot.extensions[0].status = {
          text: value,
          lamp: value === 'connected' ? 'ok' : 'none',
        };
        snapshot.extensions[0].view = { provider: 'github', state: value };
      }),
    language: setLanguage,
    snapshot: () => runtime.getSnapshot(),
  },
});
function LocalizedSidebar() {
  useLocale();
  return <Sidebar onSearch={() => {}} />;
}
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider runtime={runtime}>
    <PluginProvider plugins={[]} services={{}}>
      <MemoryRouter>
        <Tooltip.Provider>
          <div style={{ height: 850, width: 272 }}>
            <LocalizedSidebar />
          </div>
        </Tooltip.Provider>
      </MemoryRouter>
    </PluginProvider>
  </RuntimeProvider>,
);
