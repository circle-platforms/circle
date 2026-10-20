import { createRoot } from 'react-dom/client';
import { RuntimeProvider } from '../src/app/context';
import { MIN_CONVERSATION } from '../src/app/workspace-layout';
import { PreviewRuntime } from '../src/model/state';
import { ToolGroup } from '../src/components/ToolGroup';
import { setLanguage } from '../src/i18n';
import type { Message } from '../src/model/types';
import '../src/styles/app.css';

// The tools of a turn under way, folded to their row in the transcript's column: a failed
// command, ten reads, a listing, two searches, a failed and a cancelled call, and the
// turn's clock. `short` leaves a row that fits; `pane=min` is the narrowest conversation,
// and the test sets #pane to sweep the widths between.
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
const short = query.get('short') === '1';
const tool = (
  index: number,
  name: string,
  status: NonNullable<Message['tool']>['status'],
  input: Record<string, unknown>,
): Message => ({
  id: `row-${index}`,
  parentId: null,
  role: 'tool',
  text: '',
  at: '2026-10-20T00:00:00Z',
  tool: { id: `call-${index}`, name, status, input, output: '' },
});
const rows = [
  tool(0, 'execute', 'error', { command: 'npm run missing' }),
  ...Array.from({ length: short ? 1 : 10 }, (_, index) =>
    tool(index + 1, 'read_file', 'success', {
      file_path: `src/file-${index}.ts`,
    }),
  ),
  ...(short
    ? []
    : [
        tool(11, 'ls', 'success', { path: 'src' }),
        tool(12, 'glob', 'success', { pattern: '**/*.md' }),
        tool(13, 'grep', 'success', { pattern: 'plan_exit' }),
        tool(14, 'webfetch', 'error', { url: 'https://example.invalid' }),
        tool(15, 'websearch', 'cancelled', { query: 'plan mode' }),
      ]),
];
const turn = {
  verb: 'considering',
  startedAt: Date.now() - 83_000,
  waited: 0,
  tokens: 1800,
  ...(query.get('retry') ? { retry: query.get('retry')! } : {}),
};
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider runtime={new PreviewRuntime()}>
    <div
      id="pane"
      style={{
        width: query.get('pane') === 'min' ? MIN_CONVERSATION : 1000,
      }}
    >
      <div className="transcript-column">
        <ToolGroup
          rows={rows}
          expanded={false}
          onFile={() => {}}
          onAgent={() => {}}
          turn={turn}
        />
      </div>
    </div>
  </RuntimeProvider>,
);
