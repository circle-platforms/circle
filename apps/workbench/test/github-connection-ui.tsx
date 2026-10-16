import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime } from '../src/model/state';
import { GitHubConnectionCard } from '../src/components/GitHubConnectionCard';
import { DeliveryPanel } from '../src/components/DeliveryPanel';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
import '../src/styles/app.css';
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
applyTheme(query.get('theme') === 'dark' ? 'dark' : 'light');
const runtime = new PreviewRuntime();
Object.defineProperty(runtime, 'mode', { value: 'live' });
const calls: Array<{ name: string; args?: string }> = [];
const copies: string[] = [];
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: async (value: string) => {
      copies.push(value);
    },
  },
});
runtime.command = (name, args) => {
  calls.push({ name, args });
  throw Error('secure credential storage is unavailable');
};
function setView(state = 'disconnected', epoch = 7) {
  runtime.change((snapshot) => {
    snapshot.extensions = [
      {
        id: 'github',
        name: 'github',
        scope: 'bundled',
        version: 'test',
        enabled: true,
        tools: [],
        commands: ['github'],
        events: [],
        view: {
          provider: 'github',
          client: 'GitHub CLI',
          epoch,
          state,
          repositories: [],
          remoteRevocation: 'not-requested',
          ...(state === 'authorizing'
            ? {
                authorization: {
                  id: 'a',
                  code: 'CODE-TEST',
                  status: 'waiting',
                },
              }
            : {}),
        },
      },
    ];
  });
}
Object.assign(window, {
  githubFixture: {
    calls,
    copies,
    setView,
    unavailable: () =>
      runtime.change((s) => {
        s.extensions = [];
      }),
  },
});
setView();
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <RuntimeProvider runtime={runtime}>
      <main className="page">
        <GitHubConnectionCard />
        <DeliveryPanel sessionId="test" />
      </main>
    </RuntimeProvider>
  </MemoryRouter>,
);
