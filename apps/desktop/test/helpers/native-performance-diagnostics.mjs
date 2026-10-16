/** Serialized into the owned test renderer. Metadata only; never edits metric eligibility. */
export function installRendererPerformanceDiagnostics({ limit = 20000 } = {}) {
  const records = [];
  let dropped = 0,
    stopped = false,
    frame,
    previous;
  const flags = () => ({
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  });
  const add = (record) => {
    if (records.length >= limit) {
      dropped++;
      return;
    }
    records.push(record);
  };
  const state = (event) =>
    add({ phase: 'renderer-state', event, at: Date.now(), ...flags() });
  const unsubscribe = window.circleDesktop.onWorkspaceEvent?.((event) =>
    add({
      phase: 'workspace-event-received',
      at: Date.now(),
      workspaceId: event.workspaceId,
      sessionId: event.sessionId,
      service: event.service,
      resourceId: event.resourceId,
      epoch: event.epoch,
      seq: event.seq,
      sourceEpoch: event.sourceEpoch,
      sourceSeq: event.sourceSeq,
      sourceAt: event.at,
      ...flags(),
    }),
  );
  const focus = () => state('focus'),
    blur = () => state('blur'),
    visibility = () => state('visibilitychange');
  window.addEventListener('focus', focus);
  window.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', visibility);
  const longTaskSupported =
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes?.includes('longtask');
  const observer = longTaskSupported
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          add({
            phase: 'longtask',
            at: Date.now(),
            startAt: performance.timeOrigin + entry.startTime,
            duration: entry.duration,
            ...flags(),
          });
      })
    : undefined;
  observer?.observe({ type: 'longtask', buffered: false });
  const tick = (now) => {
    if (stopped) return;
    if (previous !== undefined && now - previous >= 50)
      add({
        phase: 'frame-gap',
        at: Date.now(),
        startAt: performance.timeOrigin + previous,
        duration: now - previous,
        ...flags(),
      });
    previous = now;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  state('installed');
  window.__circleNativePerfDiagnostics = {
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      unsubscribe?.();
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
      return {
        records,
        dropped,
        longTaskSupported: Boolean(longTaskSupported),
        workspaceSubscriptionAvailable: Boolean(unsubscribe),
        finalState: flags(),
        interpretation:
          'Frame gaps and two RAF timestamps are paint opportunities, not compositor pixels. Focus/visibility do not prove absence of macOS occlusion.',
      };
    },
  };
}

/** Serialized into the owned Electron main process; uses documented APIs only. */
export function installMainPerformanceDiagnostics({ BrowserWindow }) {
  const records = [];
  let dropped = 0;
  const sample = () => {
    const at = Date.now();
    for (const window of BrowserWindow.getAllWindows()) {
      if (records.length >= 10000) {
        dropped++;
        continue;
      }
      if (window.isDestroyed()) continue;
      records.push({
        at,
        windowId: window.id,
        focused: window.isFocused(),
        visible: window.isVisible(),
        minimized: window.isMinimized(),
        webContentsFocused: window.webContents.isFocused(),
        occluded: 'unknown-no-documented-BrowserWindow-query',
      });
    }
  };
  sample();
  const timer = setInterval(sample, 250);
  globalThis.__circleNativePerfMainDiagnostics = {
    stop() {
      clearInterval(timer);
      sample();
      return { records, dropped, intervalMs: 250 };
    },
  };
}
