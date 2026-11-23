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

const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
const snapshot = createFixtures();
snapshot.runtime = { connected: true, configured: true };
snapshot.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
snapshot.interactions = [];
snapshot.requests = [];
snapshot.skills = [
  {
    id: 'project:demo-skill',
    name: 'demo-skill',
    scope: 'project',
    description: 'Synthetic skill verifying tool restriction warnings.',
    path: '/workspace/.circle/skills/demo-skill/SKILL.md',
    content: '# Demo Skill\n\nCheck tool warnings.',
    allowedTools: ['Read', 'Bash(git status)'],
    disallowedTools: ['Write'],
    toolProblems: [
      'demo-skill allowed-tools BadTool(): not a tool name · not applied',
      'demo-skill names tools that do not exist in allowed-tools: FakeTool · not applied',
      'demo-skill allowed-tools Write(/tmp): only execute takes a pattern · not applied',
      'demo-skill disallowed-tools Bash(rm): a whole tool is withheld, never part of its calls · not applied',
      'demo-skill disallowed-tools compact_conversation: always offered · not applied',
    ],
  },
];

const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
const host = {
  runtimeState: async () => structuredClone(update),
  onRuntime: () => () => {},
  onTerminalEvent: () => () => {},
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  setTheme: async () => {},
  browserState: async () => ({ sessionId: 'none' }),
  terminalState: async (sessionId: string) => ({
    sessionId: 'terminal:' + sessionId,
    tabs: [],
    activeId: null,
  }),
  runtimeCommand: async (command: RuntimeCommand) => ({
    id: command.id,
    ok: true,
  }),
} as unknown as DesktopBridge;
window.circleDesktop = host;
const runtime = new LiveRuntime(host, update);
location.hash = '/page/skills';
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
