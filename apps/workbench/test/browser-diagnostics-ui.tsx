import { Tooltip } from 'radix-ui';
import { useLocale } from '../src/i18n';
import { createRoot } from 'react-dom/client';
import { BrowserDiagnostics } from '../src/features/BrowserDiagnostics';
import '../src/styles/app.css';
import type {
  BrowserDiagnosticState,
  BrowserDiagnosticEvent,
} from '../../desktop/src/browser-diagnostics-contracts';
let variableRequests = 0;
let pausedState = true;
let deferStep = false;
let releaseStep: (() => void) | undefined;
let deferEvaluation = false;
let pause = 1,
  sequence = 0,
  defer = false,
  release: (() => void) | undefined;
const listeners = new Set<(event: BrowserDiagnosticEvent) => void>();
const state = (): BrowserDiagnosticState => ({
  owner: 'circle',
  console: [],
  network: [],
  debugger: {
    paused: pausedState,
    pauseEpoch: pause,
    breakpoints: [],
    stackFrames: pausedState
      ? [
          {
            id: 'same-frame-id',
            name: 'fixture-' + pause,
            line: pause,
            column: 1,
            source: { path: 'http://localhost/fixture.js' },
            scopes: [{ name: 'local', variablesReference: 'scope-' + pause }],
          },
        ]
      : [],
  },
});
const response = () => ({
  state: state(),
  stream: { epoch: 'fixture', sequence },
});
const variables = (epoch: number) => ({
  name: 'count',
  value: String(epoch),
  variablesReference: undefined,
});
const notify = () => {
  for (const listener of listeners)
    listener({
      sessionId: 'fixture',
      tab: 't1',
      epoch: 'fixture',
      sequence: ++sequence,
      domains: ['debug'],
      at: Date.now(),
      emittedAt: Date.now(),
    });
};
(window as any).circleDesktop = {
  copyText: async (text: string) => {
    (window as any).__copiedBrowserLog = text;
  },
  onBrowserDiagnosticEvent: (listener: any) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  browserDiagnostics: async (_id: string, request: any) => {
    const status = new URLSearchParams(location.search).get('status');
    if (request.action === 'log') {
      const start = request.cursor?.seq ?? 0;
      const end = Math.min(620, start + request.limit);
      return {
        ...response(),
        log: {
          domain: request.domain,
          entries: Array.from({ length: end - start }, (_, i) => ({
            seq: start + i + 1,
            at: 'fixture',
            epoch: 'fixture',
            data: { text: `日志 ${start + i + 1}\n完整原文` },
          })),
          cursor: { offset: end, seq: end },
          hasMore: end < 620,
        },
      };
    }

    if (request.action === 'read' && status === 'pending')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (request.action === 'read' && status === 'error')
      throw new Error('synthetic diagnostics unavailable');
    if (request.action === 'debug' && request.command === 'evaluate') {
      if (
        request.frameId !== 'same-frame-id' ||
        request.expectedPauseEpoch !== pause ||
        request.expectedConnectionEpoch !== 'fixture'
      )
        throw Error('stale evaluation target');
      const captured = {
        ...response(),
        evaluation: {
          frameId: request.frameId,
          value: request.expression.match(/=\s*(\d+)/)?.[1] ?? '7',
          type: 'number',
        },
      };
      if (deferEvaluation) {
        deferEvaluation = false;
        return new Promise((resolve) => {
          release = () => resolve(captured);
        });
      }
      return captured;
    }
    if (request.action === 'debug' && request.command === 'variables') {
      variableRequests++;
      const captured = response(),
        epoch = pause;
      if (defer) {
        defer = false;
        return new Promise((resolve) => {
          release = () =>
            resolve({ ...captured, variables: [variables(epoch)] });
        });
      }
      return { ...captured, variables: [variables(epoch)] };
    }
    if (request.action === 'debug' && request.command === 'stepOver') {
      if (deferStep) {
        deferStep = false;
        pausedState = false;
        pause++;
        notify();
        const running = response();
        return new Promise((resolve) => {
          releaseStep = () => resolve(running);
        });
      }
      pause++;
      notify();
    }
    return response();
  },
};
(window as any).__browserFixture = {
  requests: () => variableRequests,
  deferStep: () => {
    deferStep = true;
  },
  releaseStep: () => releaseStep?.(),
  paused: () => {
    pausedState = true;
    pause++;
    notify();
  },
  deferEvaluation: () => {
    deferEvaluation = true;
  },
  defer: () => {
    defer = true;
  },
  next: () => {
    pause++;
    notify();
  },
  release: () => release?.(),
};
function DiagnosticFixture() {
  useLocale();
  return (
    <BrowserDiagnostics
      sessionId="fixture"
      tab="t1"
      url="http://localhost/fixture"
    />
  );
}
const diagnostics = (
  <Tooltip.Provider>
    <DiagnosticFixture />
  </Tooltip.Provider>
);
createRoot(document.getElementById('root')!).render(
  location.search.includes('layout') ? (
    <div
      style={{
        height: 700,
        width: 500,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div className="inspector-body">
        <div className="native-browser">
          <div style={{ height: 40, flexShrink: 0 }}>browser address</div>
          <div className="native-browser-viewport" />
          <div
            className="native-browser-footer"
            style={{ height: 32, flexShrink: 0 }}
          >
            native browser
          </div>
          {diagnostics}
        </div>
      </div>
    </div>
  ) : (
    <div className="native-browser" style={{ height: 700, width: 500 }}>
      {diagnostics}
    </div>
  ),
);
