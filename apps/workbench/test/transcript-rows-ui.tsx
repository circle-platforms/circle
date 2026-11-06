import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { LiveRuntime } from '../src/model/live';
import { setLanguage } from '../src/i18n';
import { createFixtures } from '../src/preview/fixtures';
import type {
  AgentRecord,
  Interaction,
  Message,
  ToolCall,
} from '../src/model/types';
import { HistoryCompactor } from '../../desktop/src/runtime-history-wire';
import type { DesktopBridge } from '../../desktop/src/contracts';
import type { RuntimeUpdate } from '../../desktop/src/runtime-protocol';

// The window as it runs: every publication goes through the worker's compactor and a
// structured copy, as IPC makes, into the real LiveRuntime and the real component tree.
setLanguage('en');
const at = new Date('2026-11-06T09:30:00').toISOString();
const row = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  parentId: null,
  role: 'assistant',
  text: '',
  at,
  ...extra,
});
const tool = (id: string, extra: Partial<ToolCall> = {}): Message =>
  row(id, {
    role: 'tool',
    tool: {
      id,
      name: 'read_file',
      input: { file_path: `src/${id}.ts` },
      output: `output of ${id}`,
      status: 'success',
      ...extra,
    },
  });
let messages: Message[] = [];
for (let turn = 0; turn < 40; turn++)
  messages.push(
    row(`prompt-${turn}`, { role: 'user', text: `prompt ${turn}` }),
    tool(`call-${turn}`),
    row(`answer-${turn}`, {
      text: `**answer** ${turn}`,
      thinking: `thought ${turn}`,
      usage: { input: 1, output: 1, elapsed: '1s' },
    }),
  );
messages.push(
  row('last-prompt', { role: 'user', text: 'the last prompt' }),
  tool('task-call', { name: 'task', agentIds: ['child'] }),
  tool('running-call', { status: 'running', output: '' }),
);
const fixtures = createFixtures();
const session = fixtures.sessions[0]!;
fixtures.sessions = [session];
Object.assign(session, {
  title: 'publication 0',
  todos: [],
  queue: [],
  attachments: [],
  draft: '',
  hiddenIds: [],
  state: 'idle',
  fileUndoTurns: [],
  showThinking: true,
  presentation: { scroll: { top: 0, follow: false } },
});
fixtures.activeSessionId = session.id;
fixtures.jobs = [];
fixtures.requests = [];
const child = {
  ...fixtures.agents[0],
  id: 'child',
  sessionId: session.id,
  name: 'the child agent',
  status: 'running',
  messages: [],
} as AgentRecord;
const state = {
  title: 'publication 0',
  agent: child,
  interactions: [] as Interaction[],
  turn: undefined as (typeof session)['turn'],
};
const compactor = new HistoryCompactor();
const listeners = new Set<(update: RuntimeUpdate) => void>();
let seq = 0;
const nextUpdate = (): RuntimeUpdate =>
  structuredClone(
    compactor.compact({
      seq: ++seq,
      connected: true,
      tokenStream: { epoch: 'test', seq: 0 },
      snapshot: {
        ...fixtures,
        agents: [state.agent],
        interactions: state.interactions,
        sessions: [
          {
            ...session,
            title: state.title,
            turn: state.turn,
            messages,
            leafId: messages.at(-1)!.id,
            branchIds: messages.map((message) => message.id),
          },
        ],
        runtime: {
          connected: true,
          observedAt: new Date().toISOString(),
        } as (typeof fixtures)['runtime'],
      },
    }),
  );
const publish = () => {
  const update = nextUpdate();
  for (const listener of listeners) listener(update);
};
const replace = (id: string, change: (row: Message) => Message) => {
  messages = messages.map((item) => (item.id === id ? change(item) : item));
};
Object.assign(window, {
  rowsFixture: {
    title(text: string) {
      state.title = text;
      publish();
    },
    finishRunning() {
      replace('running-call', (item) => ({
        ...item,
        tool: { ...item.tool!, status: 'success', output: 'finished output' },
      }));
      publish();
    },
    append() {
      messages = [
        ...messages,
        row('appended', { role: 'user', text: 'a prompt that came later' }),
      ];
      publish();
    },
    agent(change: Partial<AgentRecord>) {
      state.agent = { ...state.agent, ...change };
      publish();
    },
    ask() {
      state.interactions = [
        {
          id: 'approval',
          sessionId: session.id,
          kind: 'approval',
          status: 'pending',
          revision: 1,
          callId: 'running-call',
          tool: 'read_file',
          title: 'a request for approval',
          command: 'src/running-call.ts',
        } as unknown as Interaction,
      ];
      publish();
    },
    answer() {
      state.interactions = [];
      publish();
    },
    publish,
    setLanguage,
  },
});
const runtime = new LiveRuntime(
  {
    onRuntime: (listener: (update: RuntimeUpdate) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onRuntimeDelta: () => () => {},
    onRuntimeWait: () => () => {},
    runtimeState: async () => nextUpdate(),
  } as unknown as DesktopBridge,
  nextUpdate(),
);
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={[]} />,
);
