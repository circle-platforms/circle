import { StrictMode } from 'react';
import { applyTheme } from '../src/theme';
import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { LiveRuntime } from '../src/model/live';
import { circlePlugins } from '../src/plugins/builtins';
import { setLanguage } from '../src/i18n';
import type { DesktopBridge } from '../../desktop/src/contracts';
import type { RuntimeUpdate } from '../../desktop/src/runtime-protocol';
setLanguage('en');
const listeners = {
  update: new Set<(value: any) => void>(),
  delta: new Set<(value: any) => void>(),
  workspace: new Set<(value: any) => void>(),
};
const channel = new EventSource('/reading-pressure-events');
channel.onmessage = (event) => {
  const record = JSON.parse(event.data);
  for (const listener of listeners[record.type as keyof typeof listeners] ?? [])
    listener(record.value);
};
const subscribe =
  (type: keyof typeof listeners) => (listener: (value: any) => void) => {
    listeners[type].add(listener);
    return () => listeners[type].delete(listener);
  };
const host = {
  runtimeCommand: async (command: unknown) =>
    (
      await fetch('/reading-pressure-command', {
        method: 'POST',
        body: JSON.stringify(command),
      })
    ).json(),
  runtimeState: async () => (await fetch('/reading-pressure-state')).json(),
  onRuntime: subscribe('update'),
  onRuntimeDelta: subscribe('delta'),
  onWorkspaceEvent: subscribe('workspace'),
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  setTheme: async () => {},
  setLanguage: async () => {},
  browserState: async () => ({ sessionId: 'inactive' }),
  listWorkspace: async () => null,
} as unknown as DesktopBridge;
window.circleDesktop = host;
const initial: RuntimeUpdate = await host.runtimeState();
const runtime = new LiveRuntime(host, initial, localStorage);
applyTheme(initial.snapshot.settings.theme, initial.snapshot.settings.textSize);
document.documentElement.dataset.desktop = 'darwin';
document.documentElement.dataset.host = 'desktop';
location.hash = '#/session/perf-history';
Object.assign(window, {
  readingPressure: { runtime, frames: [], stop: false },
});
const sample = () => {
  const target = (window as any).readingPressure;
  if (target.stop) return;
  const scroller = document.querySelector('.transcript');
  if (scroller) {
    const bounds = scroller.getBoundingClientRect();
    const rows = [...scroller.querySelectorAll('[data-message-id]')].map(
      (node) => ({
        id: node.getAttribute('data-message-id'),
        top: node.getBoundingClientRect().top - bounds.top,
        bottom: node.getBoundingClientRect().bottom - bounds.top,
      }),
    );
    if (target.frames.length >= 1500) target.frames.shift();
    target.frames.push({
      at: Date.now(),
      active: runtime.getSnapshot().activeSessionId,
      top: scroller.scrollTop,
      height: scroller.scrollHeight,
      width: bounds.width,
      client: scroller.clientHeight,
      rows,
      presentation: runtime
        .getSnapshot()
        .sessions.find(
          (session) => session.id === runtime.getSnapshot().activeSessionId,
        )?.presentation,
      draftLength: runtime
        .getSnapshot()
        .sessions.find(
          (session) => session.id === runtime.getSnapshot().activeSessionId,
        )?.draft.length,
    });
  }
  requestAnimationFrame(sample);
};
requestAnimationFrame(sample);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CircleWorkbench runtime={runtime} plugins={circlePlugins} />
  </StrictMode>,
);
