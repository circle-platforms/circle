import '../src/styles/app.css';
import { Tooltip } from 'radix-ui';
import { createRoot } from 'react-dom/client';
import { RuntimeProvider } from '../src/app/context';
import { Overview } from '../src/features/Overview';
import { setLanguage } from '../src/i18n';
import { PreviewRuntime } from '../src/model/state';
import { applyTheme } from '../src/theme';
import type { DesktopBridge } from '../../desktop/src/contracts';
import type { PullRequestOverview } from '../../desktop/src/workspace/pulls-types';

// The overview in the live app, behind a workspace whose pull request reader answers what
// the test sets: what GitHub said, then that it did not answer, as when the computer goes
// offline.
const query = new URLSearchParams(location.search);
applyTheme(query.get('theme') === 'dark' ? 'dark' : 'light');
setLanguage('en');

let answer: PullRequestOverview | undefined;
let reads = 0;
const runtime = new PreviewRuntime();
runtime.change((state) => {
  state.sessions[0]!.state = 'idle';
  state.interactions = [];
});
Object.defineProperty(runtime, 'mode', { value: 'live' });
window.circleDesktop = {
  runtimeCommand: async (command: {
    payload?: { service?: string; method?: string };
  }) => {
    const { service, method } = command.payload ?? {};
    if (service === 'pulls' && method === 'overview') {
      reads++;
      return answer
        ? { ok: true, data: structuredClone(answer) }
        : { ok: false, error: 'no answer set' };
    }
    if (service === 'operations') return { ok: true, data: [] };
    return { ok: false, error: `unsupported ${service}.${method}` };
  },
} as unknown as DesktopBridge;
Object.assign(window, {
  pullsFixture: {
    /** What the reader answers from now on. */
    answer: (next: PullRequestOverview) => {
      answer = next;
    },
    reads: () => reads,
  },
});
const none = () => {};
createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider>
    <RuntimeProvider runtime={runtime}>
      <div style={{ width: 380, height: 900, display: 'flex' }}>
        <Overview onPanel={none} onSession={none} onStartPullRequest={none} />
      </div>
    </RuntimeProvider>
  </Tooltip.Provider>,
);
