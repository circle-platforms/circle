import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { RuntimeProvider } from '../src/app/context';
import { PreviewRuntime } from '../src/model/state';
import { applyTheme } from '../src/theme';
import { ToolGroup } from '../src/components/ToolGroup';
import { InlineRequest } from '../src/features/InlineRequest';
import type { Interaction } from '../src/model/types';
import '../src/styles/app.css';
applyTheme(
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light',
);
const runtime = new PreviewRuntime();
const sessionId = runtime.getSnapshot().activeSessionId;
const calls: unknown[] = [];
let resolveAnswer: (() => void) | undefined;
let rejectAnswer: ((error: Error) => void) | undefined;
let settled = 0;
const opened: string[] = [];
runtime.answer = async (...args) => {
  calls.push(args);
  await new Promise<void>((resolve, reject) => {
    resolveAnswer = resolve;
    rejectAnswer = reject;
  });
};
const kind = new URLSearchParams(location.search).get('kind');
const question = kind === 'question';
const item: Interaction =
  kind === 'hooks'
    ? {
        id: 'hooks-local',
        sessionId,
        revision: 2,
        kind: 'hooks',
        status: 'pending',
        title: 'project hooks need approval',
        target: '/work/app/.circle/hooks.json',
        hooks: [
          {
            name: 'lint',
            event: 'after_tool',
            command: 'npm run lint',
            mark: 'changed',
          },
          {
            name: 'guard',
            event: 'before_tool',
            command: 'node .circle/guard.mjs',
            mark: 'new',
          },
          {
            name: 'fmt',
            event: 'after_tool',
            command: 'prettier --write .',
            mark: 'unchanged',
          },
        ],
        choices: ['approve', 'skip'],
      }
    : {
        id: 'approval-local',
        sessionId,
        revision: 4,
        kind: question ? 'question' : 'approval',
        status: 'pending',
        title: 'update source',
        tool: 'edit_file',
        target: 'src/example.ts',
        command: 'node local-only.js',
        choices: question
          ? ['small patch', 'full rewrite']
          : ['approve', 'always'],
        multiple: question,
      };
function Fixture() {
  const [show, setShow] = useState(true);
  return (
    <RuntimeProvider runtime={runtime}>
      <ToolGroup
        rows={[
          {
            id: 'waiting-tool',
            parentId: null,
            role: 'tool',
            text: '',
            at: 'now',
            tool: {
              id: 'call1',
              name: 'execute',
              status: 'waiting',
              input: { command: 'node local-only.js' },
              output: '',
            },
          },
        ]}
        expanded={false}
        onFile={(path) => opened.push(path)}
        onAgent={() => {}}
      />
      <textarea aria-label="draft" defaultValue="keep this draft" />
      {show && (
        <InlineRequest
          item={item}
          onSecret={() => {}}
          onFile={(path) => opened.push(path)}
          onSettled={() => {
            settled++;
            setShow(false);
          }}
        />
      )}
    </RuntimeProvider>
  );
}
Object.assign(window, {
  fixture: {
    calls,
    opened,
    runtime,
    reject: () => rejectAnswer?.(new Error('controlled answer failure')),
    resolve: () => resolveAnswer?.(),
    settled: () => settled,
    switchAway: () =>
      runtime.change((state) => {
        state.sessions.push({ ...state.sessions[0]!, id: 'another-session' });
        state.activeSessionId = 'another-session';
      }),
    snapshot: () => JSON.stringify(runtime.getSnapshot()),
  },
});
createRoot(document.getElementById('root')!).render(<Fixture />);
