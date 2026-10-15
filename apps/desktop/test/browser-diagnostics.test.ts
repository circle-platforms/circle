import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserDiagnostics } from '../src/browser-diagnostics';
import { validateBrowserDiagnosticRequest } from '../src/browser-diagnostics-contracts';

test('network records redirect hops, failures and console stack source coordinates', async () => {
  const d = new BrowserDiagnostics(async () => ({}));
  d.event('Network.requestWillBeSent', {
    requestId: 'r1',
    timestamp: 1,
    request: { url: 'http://localhost/a', method: 'GET' },
  });
  d.event('Network.requestWillBeSent', {
    requestId: 'r1',
    timestamp: 1.2,
    request: { url: 'http://localhost/b', method: 'GET' },
    redirectResponse: { status: 302 },
  });
  d.event('Network.responseReceived', {
    requestId: 'r1',
    response: { status: 500, mimeType: 'text/plain' },
  });
  d.event('Network.loadingFinished', { requestId: 'r1', timestamp: 1.7 });
  d.event('Runtime.consoleAPICalled', {
    type: 'error',
    args: [{ value: 'failed' }],
    stackTrace: {
      callFrames: [
        {
          url: 'http://localhost/app.js',
          lineNumber: 2,
          columnNumber: 3,
          functionName: 'start',
        },
      ],
    },
  });
  assert.equal(d.state.network[0].status, 302);
  assert.equal(d.state.network[1].status, 500);
  assert.equal(d.state.network[1].duration, 500);
  assert.deepEqual(d.state.console[0].stack, [
    { url: 'http://localhost/app.js', line: 3, column: 4, name: 'start' },
  ]);
  for (let i = 0; i < 510; i++)
    d.event('Runtime.consoleAPICalled', { type: 'log', args: [{ value: i }] });
  assert.equal(d.state.console.length, 500);
});
test('storage writes use exact current origin and selected storage kind', async () => {
  const calls: { method: string; args: unknown }[] = [];
  const d = new BrowserDiagnostics(async (method, args) => {
    calls.push({ method, args });
    return { entries: [['test', 'new']] };
  });
  const result = await d.request(
    {
      action: 'storage',
      kind: 'session',
      origin: 'http://localhost:5199',
      operation: 'set',
      key: 'test',
      value: 'new',
    },
    'http://localhost:5199/page',
  );
  assert.deepEqual(calls[0], {
    method: 'DOMStorage.setDOMStorageItem',
    args: {
      storageId: {
        securityOrigin: 'http://localhost:5199',
        isLocalStorage: false,
      },
      key: 'test',
      value: 'new',
    },
  });
  assert.deepEqual(result.storage, [['test', 'new']]);
  await assert.rejects(
    d.request(
      {
        action: 'storage',
        kind: 'local',
        origin: 'http://old.invalid',
        operation: 'remove',
        key: 'test',
      },
      'http://localhost:5199/page',
    ),
    /origin/,
  );
  assert.equal(calls.length, 2);
});
test('viewport validates dimensions and reset removes emulation; handoff prevents commands', async () => {
  const calls: string[] = [];
  const d = new BrowserDiagnostics(async (method) => {
    calls.push(method);
    return {};
  });
  await assert.rejects(
    d.request(
      { action: 'viewport', width: 0, height: 812 },
      'http://localhost',
    ),
    /dimensions/,
  );
  await d.request(
    { action: 'viewport', width: 375, height: 812, mobile: true },
    'http://localhost',
  );
  await d.request({ action: 'viewport' }, 'http://localhost');
  assert.deepEqual(calls, [
    'Emulation.setDeviceMetricsOverride',
    'Emulation.clearDeviceMetricsOverride',
  ]);
  d.state.owner = 'devtools';
  await assert.rejects(
    d.request({ action: 'debug', command: 'pause' }, 'http://localhost'),
    /handed/,
  );
});
test('debug pause maps real CDP frames and scopes and refuses stale variable references', async () => {
  const calls: string[] = [];
  const d = new BrowserDiagnostics(async (method) => {
    calls.push(method);
    return { result: [{ name: 'count', value: { value: 3, type: 'number' } }] };
  });
  d.event('Debugger.paused', {
    callFrames: [
      {
        callFrameId: 'frame1',
        functionName: 'work',
        url: 'http://localhost/main.js',
        location: { lineNumber: 6, columnNumber: 0 },
        scopeChain: [{ type: 'local', object: { objectId: 'scope1' } }],
      },
    ],
  });
  assert.equal(d.state.debugger.stackFrames[0].line, 7);
  const r = await d.request(
    { action: 'debug', command: 'variables', reference: 'scope1' },
    'http://localhost',
  );
  assert.equal(r.variables![0].value, '3');
  d.event('Debugger.resumed', {});
  await assert.rejects(
    d.request(
      { action: 'debug', command: 'variables', reference: 'scope1' },
      'http://localhost',
    ),
    /stale/,
  );
  assert.deepEqual(calls, ['Runtime.getProperties']);
});
test('bridge only accepts explicit diagnostic actions, never arbitrary CDP methods', () => {
  assert.throws(
    () =>
      validateBrowserDiagnosticRequest({
        action: 'send',
        method: 'Runtime.evaluate',
      }),
    /action/,
  );
  assert.throws(
    () =>
      validateBrowserDiagnosticRequest({
        action: 'read',
        method: 'Runtime.evaluate',
      }),
    /action/,
  );
  assert.throws(
    () =>
      validateBrowserDiagnosticRequest({
        action: 'debug',
        command: 'evaluate',
      }),
    /debugger/,
  );
  assert.deepEqual(validateBrowserDiagnosticRequest({ action: 'read' }), {
    action: 'read',
  });
});

test('breakpoints can be removed and script ids retain source URLs', async () => {
  const calls: string[] = [];
  const d = new BrowserDiagnostics(async (method) => {
    calls.push(method);
    return { breakpointId: 'b1', locations: [{ lineNumber: 3 }] };
  });
  d.event('Debugger.scriptParsed', {
    scriptId: 's1',
    url: 'http://localhost/file.js',
  });
  d.event('Debugger.paused', {
    callFrames: [
      {
        callFrameId: 'f1',
        functionName: 'main',
        location: { scriptId: 's1', lineNumber: 3, columnNumber: 0 },
        scopeChain: [],
      },
    ],
  });
  assert.equal(
    d.state.debugger.stackFrames[0].source.path,
    'http://localhost/file.js',
  );
  await d.request(
    {
      action: 'debug',
      command: 'breakpoints',
      url: 'http://localhost/file.js',
      line: 4,
    },
    'http://localhost',
  );
  assert.equal(d.state.debugger.breakpoints[0].verified, true);
  await d.request(
    { action: 'debug', command: 'removeBreakpoint', reference: 'b1' },
    'http://localhost',
  );
  assert.equal(d.state.debugger.breakpoints.length, 0);
  assert.deepEqual(calls, [
    'Debugger.setBreakpointByUrl',
    'Debugger.removeBreakpoint',
  ]);
});
