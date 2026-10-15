import { createRoot } from 'react-dom/client';
import { BrowserDiagnostics } from '../src/features/BrowserDiagnostics';
import '../src/styles/app.css';
import type {
  BrowserDiagnosticState,
  BrowserDiagnosticEvent,
} from '../../desktop/src/browser-diagnostics-contracts';
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
    paused: true,
    pauseEpoch: pause,
    breakpoints: [],
    stackFrames: [
      {
        id: 'same-frame-id',
        name: 'fixture-' + pause,
        line: pause,
        column: 1,
        source: { path: 'http://localhost/fixture.js' },
        scopes: [{ name: 'local', variablesReference: 'scope-' + pause }],
      },
    ],
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
  onBrowserDiagnosticEvent: (listener: any) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  browserDiagnostics: async (_id: string, request: any) => {
    if (request.action === 'debug' && request.command === 'variables') {
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
      pause++;
      notify();
    }
    return response();
  },
};
(window as any).__browserFixture = {
  defer: () => {
    defer = true;
  },
  next: () => {
    pause++;
    notify();
  },
  release: () => release?.(),
};
const diagnostics = (
  <BrowserDiagnostics
    sessionId="fixture"
    tab="t1"
    url="http://localhost/fixture"
  />
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
