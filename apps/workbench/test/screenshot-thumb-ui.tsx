import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { createFixtures } from '../src/preview/fixtures';
import { setLanguage } from '../src/i18n';

// A conversation in which Circle took a screenshot of a page, behind a fake desktop host
// that records the picture handed to the clipboard and to a file.
const query = new URLSearchParams(location.search),
  data = createFixtures();
data.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const picture =
  'data:image/png;base64,' +
  btoa(
    String.fromCharCode(
      ...[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
        0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ],
    ),
  );
const session = data.sessions[0]!;
session.messages = [
  {
    id: 'u1',
    parentId: null,
    role: 'user',
    at: '12:03',
    text: 'Check that the login page renders after the fix',
  },
  {
    id: 't1',
    parentId: 'u1',
    role: 'tool',
    at: '12:04',
    text: 'screenshot of the login page',
    tool: {
      id: 'call-shot',
      name: 'browser_screenshot',
      input: {},
      output: 'tab 1 · Orbit · login · https://app.example.test/login',
      status: 'success',
    },
    attachments: [
      {
        id: 'shot-1',
        name: 'app.example.test 12:04.png',
        kind: 'image',
        content: picture,
        mime: 'image/png',
      },
    ],
  },
  {
    id: 'a1',
    parentId: 't1',
    role: 'assistant',
    at: '12:04',
    text: 'The login page renders and both fields are present.',
  },
];
session.leafId = 'a1';
session.todos = [];
session.changes = [];
data.interactions = [];
data.requests = [];
data.agents = [];
data.jobs = [];
const runtime = new PreviewRuntime({
  getItem: () => JSON.stringify(data),
  setItem: () => {},
  removeItem: () => {},
});
const calls: Array<{ call: string; args: unknown[] }> = [];
window.circleDesktop = {
  setTheme: async () => {},
  onBrowserEvent: () => () => {},
  onTerminalEvent: () => () => {},
  onAction: () => () => {},
  onWorkspaceEvent: () => () => {},
  browserState: async () => ({ sessionId: 'none' }),
  copyImage: async (dataUrl: string) => {
    calls.push({ call: 'copyImage', args: [dataUrl] });
  },
  saveImage: async (options: { name: string; dataUrl: string }) => {
    calls.push({ call: 'saveImage', args: [options.name, options.dataUrl] });
    return { saved: true, name: options.name };
  },
  runtimeCommand: async () => ({ ok: true, data: [] }),
} as unknown as NonNullable<Window['circleDesktop']>;
Object.assign(window, { screenshotThumbFixture: { calls, picture } });
setLanguage(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en');
location.hash = `/session/${session.id}`;
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={[]} />,
);
