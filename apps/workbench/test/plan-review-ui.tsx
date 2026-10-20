import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { setLanguage } from '../src/i18n';

// Plan mode's plan and its card over the preview runtime. The test writes the plan and
// asks about it as the core does, through the snapshot, and reads back the answer.
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
const runtime = new PreviewRuntime();
runtime.change((state) => {
  const session = state.sessions[0]!;
  state.sessions = [session];
  state.activeSessionId = session.id;
  state.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
  session.messages = [];
  session.leafId = null;
  session.branchIds = [];
  session.state = 'idle';
  session.todos = [];
  session.draft = '';
  session.readOnly = true;
  session.mode = 'plan';
  state.interactions = [];
  state.agents = [];
  state.jobs = [];
  state.requests = [];
});
const file = `/session_plans/${runtime.getSnapshot().activeSessionId}.md`;
// A turn under way while Circle writes the plan, then the card that asks about it
const write = (text: string, updatedAt: string) =>
  runtime.change((state) => {
    const session = state.sessions[0]!;
    session.turn ??= {
      verb: 'thinking',
      startedAt: Date.now(),
      waited: 0,
      tokens: 0,
    };
    session.plan = { file, text, updatedAt };
  });
const endTurn = () =>
  runtime.change((state) => {
    state.sessions[0]!.turn = undefined;
  });
const ask = (id: string) =>
  runtime.change((state) => {
    state.interactions.push({
      id,
      sessionId: state.activeSessionId,
      kind: 'plan-exit',
      title: `The plan is ready: ~/.circle/plan.md\nHow should Circle go on?`,
      target: file,
      choices: [
        'implement in auto mode',
        'implement with manual approval',
        'change the plan',
        'save the plan only',
      ],
      multiple: false,
      status: 'pending',
      revision: 1,
    });
  });
const decision = (id: string) =>
  runtime.getSnapshot().interactions.find((item) => item.id === id)?.decision;
Object.assign(window, { planFixture: { write, endTurn, ask, decision } });
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
