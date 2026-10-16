import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  installRendererPerformanceDiagnostics,
  installMainPerformanceDiagnostics,
} from './helpers/native-performance-diagnostics.mjs';

test('renderer records metadata receive/longtask/frame/state, bounds evidence and cleans every subscription', () => {
  let receive,
    observe,
    unsubscribed = 0,
    removed = 0,
    cancelled = 0;
  const raf = [];
  class Observer {
    static supportedEntryTypes = ['longtask'];
    constructor(callback) {
      observe = callback;
    }
    observe() {}
    disconnect() {
      removed++;
    }
  }
  const window = {
    circleDesktop: {
      onWorkspaceEvent(fn) {
        receive = fn;
        return () => unsubscribed++;
      },
    },
    addEventListener() {},
    removeEventListener() {
      removed++;
    },
  };
  const context = {
    window,
    document: {
      visibilityState: 'visible',
      hasFocus: () => true,
      addEventListener() {},
      removeEventListener() {
        removed++;
      },
    },
    PerformanceObserver: Observer,
    performance: { timeOrigin: 1000 },
    Date,
    requestAnimationFrame: (fn) => (raf.push(fn), raf.length),
    cancelAnimationFrame: () => cancelled++,
  };
  runInNewContext(
    '(' + installRendererPerformanceDiagnostics.toString() + ')',
    context,
  )({ limit: 4 });
  receive({
    service: 'terminal',
    resourceId: 't',
    epoch: 'e',
    seq: 1,
    sourceSeq: 4,
    data: { private: 'must-not-copy' },
  });
  observe({
    getEntries: () => [{ startTime: 1, duration: 70, name: 'secret-not-copy' }],
  });
  raf.shift()(1);
  raf.shift()(100);
  receive({ service: 'terminal', resourceId: 'overflow' });
  const result = window.__circleNativePerfDiagnostics.stop();
  assert.equal(result.records.length, 4);
  assert.equal(result.dropped, 1);
  assert.deepEqual(
    Array.from(result.records, (r) => r.phase),
    ['renderer-state', 'workspace-event-received', 'longtask', 'frame-gap'],
  );
  assert.ok(!JSON.stringify(result).includes('must-not-copy'));
  assert.ok(!JSON.stringify(result).includes('secret-not-copy'));
  assert.equal(unsubscribed, 1);
  assert.equal(removed, 4);
  assert.equal(cancelled, 1);
});
test('main foreground flags remain documented observations and occlusion stays unknown', () => {
  let interval,
    cleared = 0;
  const context = {
    Date,
    setInterval: (fn) => ((interval = fn), 1),
    clearInterval: () => cleared++,
  };
  runInNewContext(
    '(' + installMainPerformanceDiagnostics.toString() + ')',
    context,
  )({
    BrowserWindow: {
      getAllWindows: () => [
        {
          id: 1,
          isDestroyed: () => false,
          isFocused: () => true,
          isVisible: () => true,
          isMinimized: () => false,
          webContents: { isFocused: () => true },
        },
      ],
    },
  });
  interval();
  const result = context.__circleNativePerfMainDiagnostics.stop();
  assert.equal(result.records.length, 3);
  assert.equal(cleared, 1);
  assert.equal(
    result.records[0].occluded,
    'unknown-no-documented-BrowserWindow-query',
  );
});
