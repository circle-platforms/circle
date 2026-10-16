import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  terminalAxDiagnosticRequired,
  appendNativeEditorText,
  armNativeFeedback,
  captureNativeTranscriptAnchor,
  terminalObservationRows,
  terminalVisibilityCohorts,
} from './helpers/native-performance-observation.mjs';

function renderer() {
  let runtimeListener,
    inputListener,
    now = 0,
    unsubscribed = 0,
    timeoutCallback;
  const frames = [];
  const message = {
    dataset: { messageId: 'message-middle' },
    textContent: 'persisted history123',
    closest: () => null,
    getBoundingClientRect: () => ({
      width: 500,
      height: 80,
      top: 110,
      bottom: 190,
    }),
  };
  const transcript = {
    scrollTop: 500,
    closest: () => null,
    getBoundingClientRect: () => ({
      width: 500,
      height: 600,
      top: 100,
      bottom: 700,
    }),
    querySelectorAll: () => [message],
  };
  const header = { textContent: 'target conversation' };
  const document = {
    querySelector: (selector) =>
      selector === '.transcript'
        ? transcript
        : selector === '.session-title'
          ? header
          : null,
    addEventListener: (_, listener) => {
      inputListener = listener;
    },
    removeEventListener: () => {
      inputListener = undefined;
    },
  };
  const window = {
    circleDesktop: {
      onRuntime: (listener) => {
        runtimeListener = listener;
        return () => {
          unsubscribed++;
        };
      },
    },
  };
  const location = { hash: '#/session/target' };
  const context = {
    window,
    document,
    location,
    performance: { now: () => now },
    setTimeout: (callback) => {
      timeoutCallback = callback;
      return 1;
    },
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => frames.push(fn),
  };
  return {
    window,
    document,
    header,
    message,
    location,
    get unsubscribed() {
      return unsubscribed;
    },
    install: (condition, selector = '#target') =>
      runInNewContext(
        '(' + armNativeFeedback.toString() + ')',
        context,
      )({ kind: 'click', selector, condition }),
    click: (target) =>
      inputListener({ target: target ?? { closest: () => true } }),
    timeout: () => timeoutCallback(),
    backend: (id) => runtimeListener({ snapshot: { activeSessionId: id } }),
    frame: () => {
      now += 16;
      frames.shift()?.();
    },
    anchor: () =>
      runInNewContext(
        '(' + captureNativeTranscriptAnchor.toString() + ')',
        context,
      )(),
  };
}

test('session feedback requires real backend, route, header and visible body, without a tail marker', async () => {
  const r = renderer();
  r.install({
    session: {
      id: 'target',
      title: 'target conversation',
      content: 'persisted history',
    },
  });
  let finished = false;
  r.window.__circleNativePerfPending.then(() => {
    finished = true;
  });
  r.click();
  r.backend('other');
  r.frame();
  r.frame();
  await Promise.resolve();
  assert.equal(finished, false);
  r.backend('target');
  r.location.hash = '#/session/other';
  r.frame();
  r.frame();
  await Promise.resolve();
  assert.equal(finished, false);
  r.location.hash = '#/session/target';
  r.header.textContent = 'wrong owner';
  r.frame();
  r.frame();
  await Promise.resolve();
  assert.equal(finished, false);
  r.header.textContent = 'target conversation';
  r.message.getBoundingClientRect = () => ({
    width: 500,
    height: 80,
    top: -100,
    bottom: -20,
  });
  r.frame();
  r.frame();
  await Promise.resolve();
  assert.equal(finished, false);
  r.message.getBoundingClientRect = () => ({
    width: 500,
    height: 80,
    top: 110,
    bottom: 190,
  });
  r.frame();
  r.frame();
  assert.ok((await r.window.__circleNativePerfPending) > 0);
  assert.equal(r.unsubscribed, 1);
});

test('scroll anchor records the actual visible stable message and pixel offset', () => {
  const r = renderer();
  const anchor = r.anchor();
  assert.equal(anchor.id, 'message-middle');
  assert.equal(anchor.offset, 10);
  assert.equal(anchor.scrollTop, 500);
  r.message.getBoundingClientRect = () => ({
    width: 500,
    height: 80,
    top: -100,
    bottom: -20,
  });
  assert.throws(() => r.anchor(), /no visible message/);
});

test('actual UI parse/frame and AX observations remain distinct; missing hooks never borrow raw-read timing', () => {
  const producer = 1700000000000,
    event = {
      terminalId: 'pty',
      sequence: 42,
      kind: 'data',
      at: new Date(producer + 3).toISOString(),
      data: `NATIVE_PERF ${producer} 1\r\n`,
    };
  const timing = [
    {
      terminalId: 'pty',
      phase: 'replay-response',
      afterSequence: 40,
      cursor: 45,
      at: producer + 7,
    },
    {
      terminalId: 'pty',
      eventSequence: 42,
      phase: 'write-enqueued',
      at: producer + 8,
    },
    {
      terminalId: 'pty',
      eventSequence: 42,
      phase: 'write-parsed',
      at: producer + 10,
    },
    {
      terminalId: 'pty',
      eventSequence: 42,
      phase: 'write-frame',
      at: producer + 45,
    },
  ];
  const [row] = terminalObservationRows([event], timing, [
    { sourceAt: producer, sampleAt: producer + 1000 },
  ]);
  assert.equal(row.producerToRuntimeMs, 3);
  assert.equal(row.replayResponseAt, producer + 7);
  assert.equal(row.producerToParsedMs, 10);
  assert.equal(row.producerToFrameMs, 45);
  assert.equal(row.producerToAxMs, 1000);
  const [missing] = terminalObservationRows(
    [event],
    [timing[0]],
    [{ sourceAt: producer, sampleAt: producer + 1000 }],
  );
  assert.equal(missing.frameAt, undefined);
  assert.equal('producerToFrameMs' in missing, false);
});

test('visibility eligibility preserves mixed raw and distinguishes reveal recovery', () => {
  const rows = [
    { terminalId: 't', producerAt: 20, frameAt: 40, producerToFrameMs: 20 },
    { terminalId: 't', producerAt: 60, frameAt: 110, producerToFrameMs: 50 },
    { terminalId: 't', producerAt: 120, frameAt: 150, producerToFrameMs: 30 },
    { terminalId: 'other', producerAt: 120, frameAt: 150 },
  ];
  const copy = structuredClone(rows);
  const result = terminalVisibilityCohorts(rows, [
    { terminalId: 't', phase: 'view-active', at: 10, visibilityEpoch: 1 },
    { terminalId: 't', phase: 'view-inactive', at: 50, visibilityEpoch: 2 },
    { terminalId: 't', phase: 'view-active', at: 100, visibilityEpoch: 3 },
  ]);
  assert.deepEqual(rows, copy);
  assert.deepEqual(
    result.map((r) => r.visibilityCohort),
    [
      'continuously-visible',
      'hidden-recovery',
      'continuously-visible',
      'unknown',
    ],
  );
  assert.equal(result[1].revealToFrameMs, 10);
  assert.equal(result[1].producerToFrameMs, 50);
  assert.equal(result[2].visibilityEpoch, 3);
});

test('file feedback targets the unique visible expected file and workspace, ignoring hidden Monaco first matches', async () => {
  const r = renderer();
  const node = (textContent, hidden = false) => ({
    textContent,
    closest: () => (hidden ? {} : null),
    getBoundingClientRect: () => ({
      width: hidden ? 0 : 500,
      height: hidden ? 0 : 80,
    }),
  });
  const hiddenEditor = node('PERF_SECOND', true);
  const liveEditor = node('PERF_README');
  let directory = '/wrong-owner';
  const view = {
    ...node(''),
    querySelector: (selector) =>
      selector === '.file-view-filename strong'
        ? node('README.md')
        : { getAttribute: () => 'workspace source: workspace: ' + directory },
    querySelectorAll: () => [hiddenEditor, liveEditor],
  };
  r.document.querySelectorAll = () => [{ ...view, closest: () => ({}) }, view];
  r.document.querySelector = () => hiddenEditor;
  r.install({
    selector: '.monaco-editor .view-lines',
    file: { path: 'README.md', sourceDirectory: '/actual-owner' },
    text: 'PERF_README',
  });
  let finished = false;
  r.window.__circleNativePerfPending.then(() => (finished = true));
  r.click();
  r.frame();
  r.frame();
  await Promise.resolve();
  assert.equal(
    finished,
    false,
    'same content in a different workspace cannot satisfy the metric',
  );
  directory = '/actual-owner';
  r.frame();
  r.frame();
  await Promise.resolve();
  assert.equal(
    finished,
    true,
    'visible matching resource succeeds despite stale hidden editor first',
  );
});

test('file save feedback cannot use a hidden matched toolbar while visible buffer remains unsaved', async () => {
  const r = renderer();
  const toolbar = {
    textContent: 'unsaved buffer',
    closest: () => null,
    getBoundingClientRect: () => ({ width: 500, height: 40 }),
  };
  const view = {
    closest: () => null,
    getBoundingClientRect: () => ({ width: 500, height: 800 }),
    querySelector: (selector) =>
      selector === '.file-view-filename strong'
        ? { textContent: 'README.md' }
        : { getAttribute: () => 'workspace source: workspace: /actual-owner' },
    querySelectorAll: () => [
      { ...toolbar, textContent: 'disk and buffer match', closest: () => ({}) },
      toolbar,
    ],
  };
  r.document.querySelectorAll = () => [view];
  r.install({
    selector: '.file-view-toolbar',
    file: { path: 'README.md', sourceDirectory: '/actual-owner' },
    text: 'disk and buffer match',
  });
  let finished = false;
  r.window.__circleNativePerfPending.then(() => (finished = true));
  r.click();
  r.frame();
  r.frame();
  await Promise.resolve();
  assert.equal(finished, false);
  toolbar.textContent = 'disk and buffer match';
  r.frame();
  r.frame();
  await Promise.resolve();
  assert.equal(finished, true);
});

test('timeout evidence distinguishes a replaced link that opens the file without starting the metric clock', async () => {
  const r = renderer();
  const armed = {
    isConnected: false,
    getAttribute: (name) => (name === 'href' ? 'SECOND.md#L1' : 'file'),
  };
  const clicked = {
    isConnected: true,
    getAttribute: (name) => (name === 'href' ? 'SECOND.md#L1' : null),
  };
  const node = {
    textContent: 'PERF_SECOND',
    closest: () => null,
    getBoundingClientRect: () => ({ width: 500, height: 80 }),
  };
  const view = {
    ...node,
    querySelector: (selector) =>
      selector === '.file-view-filename strong'
        ? { textContent: 'SECOND.md' }
        : { getAttribute: () => 'workspace source: workspace: /actual-owner' },
    querySelectorAll: () => [node],
  };
  r.document.querySelector = () => armed;
  r.document.querySelectorAll = (selector) =>
    selector === '.file-view'
      ? [view]
      : selector === '[data-perf-target="file"]'
        ? []
        : [];
  r.install({
    selector: '.monaco-editor .view-lines',
    file: { path: 'SECOND.md', sourceDirectory: '/actual-owner' },
    text: 'PERF_SECOND',
  });
  const rejected = assert.rejects(
    r.window.__circleNativePerfPending,
    /timed out/,
  );
  // The browser target is the replacement real anchor without test-only attributes.
  r.click({ closest: (selector) => (selector === 'a' ? clicked : null) });
  r.timeout();
  await rejected;
  const record = r.window.__circleNativePerfFeedbackDiagnostics[0];
  assert.equal(record.started, false);
  assert.equal(record.armedConnected, false);
  assert.equal(record.clicks[0].href, 'SECOND.md#L1');
  assert.equal(record.clicks[0].dataFlag, null);
  assert.equal(record.clicks[0].matchesSelector, false);
  assert.equal(record.fileState[0].targets[0].text, 'PERF_SECOND');
});

test('natural source href starts feedback after React replaces the armed anchor', async () => {
  const r = renderer();
  const selector = '.transcript a[href="SECOND.md#L1"]';
  const old = { isConnected: false };
  const replacement = {
    isConnected: true,
    getAttribute: (name) => (name === 'href' ? 'SECOND.md#L1' : null),
  };
  const node = {
    textContent: 'PERF_SECOND',
    closest: () => null,
    getBoundingClientRect: () => ({ width: 500, height: 80 }),
  };
  const view = {
    ...node,
    querySelector: (query) =>
      query === '.file-view-filename strong'
        ? { textContent: 'SECOND.md' }
        : { getAttribute: () => 'workspace source: workspace: /actual-owner' },
    querySelectorAll: () => [node],
  };
  r.document.querySelector = () => old;
  r.document.querySelectorAll = (query) =>
    query === '.file-view' ? [view] : [replacement];
  r.install(
    {
      selector: '.monaco-editor .view-lines',
      file: { path: 'SECOND.md', sourceDirectory: '/actual-owner' },
      text: 'PERF_SECOND',
    },
    selector,
  );
  r.click({
    closest: (query) =>
      query === selector || query === 'a' ? replacement : null,
  });
  r.frame();
  r.frame();
  await r.window.__circleNativePerfPending;
  const record = r.window.__circleNativePerfFeedbackDiagnostics[0];
  assert.equal(record.started, true);
  assert.equal(record.clicks[0].sameArmed, false);
  assert.equal(record.clicks[0].dataFlag, null);
  assert.equal(record.clicks[0].matchesSelector, true);
  assert.equal(record.frames, 2);
});

test('editor append clicks the visible Monaco surface and uses native keyboard input, never a readonly IME textarea', async () => {
  const calls = [];
  const file = {
    locator: (selector) => {
      assert.equal(selector, '.monaco-editor:visible .view-lines');
      return { click: async () => calls.push('surface-click') };
    },
  };
  const page = {
    keyboard: {
      press: async (key) => calls.push(key),
      insertText: async (text) => calls.push(['insert', text]),
    },
  };
  await appendNativeEditorText(page, file, 'saved performance 0', 'darwin');
  assert.deepEqual(calls, [
    'surface-click',
    'Meta+End',
    'Enter',
    ['insert', 'saved performance 0'],
  ]);
  calls.length = 0;
  await appendNativeEditorText(page, file, 'saved performance 1', 'win32');
  assert.deepEqual(calls, [
    'surface-click',
    'Control+End',
    'Enter',
    ['insert', 'saved performance 1'],
  ]);
});

test('AX diagnostics only opt out for actual supported host OFF, not unknown or ON states', () => {
  assert.equal(
    terminalAxDiagnosticRequired({ supported: true, enabled: false }),
    false,
  );
  assert.equal(
    terminalAxDiagnosticRequired({ supported: true, enabled: true }),
    true,
  );
  assert.equal(
    terminalAxDiagnosticRequired({ supported: false, enabled: false }),
    true,
  );
  assert.equal(terminalAxDiagnosticRequired(null), true);
  assert.equal(terminalAxDiagnosticRequired({ supported: true }), true);
});
