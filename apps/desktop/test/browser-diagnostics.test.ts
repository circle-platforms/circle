import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.deepEqual(calls, [
    'Runtime.getProperties',
    'Debugger.evaluateOnCallFrame',
  ]);
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

test('browser source inspection only reads an actually observed script', async () => {
  const calls: { method: string; params: unknown }[] = [];
  const d = new BrowserDiagnostics(async (method, params) => {
    calls.push({ method, params });
    return { scriptSource: 'console.log("fixture");' };
  });
  await assert.rejects(
    d.request(
      { action: 'source', url: 'https://unseen.invalid/a.js' },
      'http://localhost',
    ),
    /no longer available/,
  );
  assert.equal(calls.length, 0);
  d.event('Debugger.scriptParsed', {
    scriptId: 'script-1',
    url: 'http://localhost/app.js',
  });
  const result = await d.request(
    { action: 'source', url: 'http://localhost/app.js' },
    'http://localhost',
  );
  assert.equal(result.source?.content, 'console.log("fixture");');
  assert.deepEqual(calls, [
    { method: 'Debugger.getScriptSource', params: { scriptId: 'script-1' } },
  ]);
});

test('paused evaluation binds connection and frame, rejects running or stale replies', async () => {
  let complete: (value: unknown) => void = () => {};
  let calls = 0;
  const d = new BrowserDiagnostics(async () => {
    calls++;
    return await new Promise((resolve) => {
      complete = resolve;
    });
  });
  const paused = () =>
    d.event('Debugger.paused', {
      callFrames: [
        {
          callFrameId: 'frame',
          functionName: 'work',
          url: 'http://localhost/main.js',
          location: { lineNumber: 1 },
          scopeChain: [],
        },
      ],
    });
  paused();
  const request = {
    action: 'debug',
    command: 'evaluate',
    frameId: 'frame',
    expression: 'value = 7',
    expectedPauseEpoch: d.state.debugger.pauseEpoch,
    expectedConnectionEpoch: d.cursor().epoch,
  } as const;
  await assert.rejects(
    d.request(
      { ...request, expectedConnectionEpoch: 'other-target' },
      'http://localhost',
    ),
    /stale/,
  );
  await assert.rejects(
    d.request({ ...request, frameId: 'foreign-frame' }, 'http://localhost'),
    /stale/,
  );
  assert.equal(calls, 0);
  const pending = d.request(request, 'http://localhost');
  d.event('Debugger.resumed', {});
  complete({ result: { value: 7, type: 'number' } });
  await assert.rejects(pending, /changed/);
  await assert.rejects(d.request(request, 'http://localhost'), /stale/);
  assert.equal(calls, 1);
});

test('real webpage CDP evaluation changes paused local and continued program result', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    const d = new BrowserDiagnostics((method, params) =>
      cdp.send(method as any, params),
    );
    cdp.on('Debugger.paused', (event) => d.event('Debugger.paused', event));
    cdp.on('Debugger.resumed', (event) => d.event('Debugger.resumed', event));
    await cdp.send('Debugger.enable');
    const paused = new Promise<void>((resolve) =>
      cdp.once('Debugger.paused', () => resolve()),
    );
    const { browserDebugFixtureSource } = await import(
      new URL('./helpers/native-browser-debug-journey.mjs', import.meta.url)
        .href
    );
    const fixture = browserDebugFixtureSource(
      'window.__receiver = event => console.log(event.data);\n',
    );
    await cdp.send('Runtime.evaluate', {
      expression:
        fixture.source +
        '\n//# sourceURL=http://localhost/debug-eval-fixture.js',
    });
    await cdp.send('Debugger.setBreakpointByUrl', {
      url: 'http://localhost/debug-eval-fixture.js',
      lineNumber: fixture.breakpointLine - 1,
    });
    await page.evaluate(() => {
      setTimeout(() => {
        (window as any).__actualDebugResult = (
          window as any
        ).__journeyBrowserDebug();
      }, 0);
    });
    await paused;
    const frame = d.state.debugger.stackFrames[0];
    const local = frame.scopes.find((scope) => scope.name === 'local');
    assert.ok(local);
    const readLocal = () =>
      d.request(
        {
          action: 'debug',
          command: 'variables',
          reference: local.variablesReference,
          expectedConnectionEpoch: d.cursor().epoch,
          expectedPauseEpoch: d.state.debugger.pauseEpoch,
        },
        'about:blank',
      );
    assert.equal(
      (await readLocal()).variables?.find(
        (variable) => variable.name === 'count',
      )?.value,
      '3',
    );
    const result = await d.request(
      {
        action: 'debug',
        command: 'evaluate',
        frameId: frame.id,
        expression: 'count = 9',
        expectedConnectionEpoch: d.cursor().epoch,
        expectedPauseEpoch: d.state.debugger.pauseEpoch,
      },
      'about:blank',
    );
    assert.equal(result.evaluation?.value, '9');
    assert.equal(
      (await readLocal()).variables?.find(
        (variable) => variable.name === 'count',
      )?.value,
      '9',
      'same paused scope reflects actual evaluation write',
    );
    const nullResult = await d.request(
      {
        action: 'debug',
        command: 'evaluate',
        frameId: frame.id,
        expression: 'null',
        expectedConnectionEpoch: d.cursor().epoch,
        expectedPauseEpoch: d.state.debugger.pauseEpoch,
      },
      'about:blank',
    );
    assert.equal(nullResult.evaluation?.value, 'null');
    const stepped = new Promise<void>((resolve) =>
      cdp.once('Debugger.paused', () => resolve()),
    );
    await d.request({ action: 'debug', command: 'stepOver' }, 'about:blank');
    await stepped;
    assert.equal(
      d.state.debugger.stackFrames[0].line,
      fixture.computationLine,
      'first step reaches the computation before it executes',
    );
    const computed = new Promise<void>((resolve) =>
      cdp.once('Debugger.paused', () => resolve()),
    );
    await d.request({ action: 'debug', command: 'stepOver' }, 'about:blank');
    await computed;
    const steppedFrame = d.state.debugger.stackFrames[0];
    assert.equal(steppedFrame.line, fixture.afterStepLine);
    const steppedScope = steppedFrame.scopes.find(
      (scope) => scope.name === 'local',
    );
    assert.ok(steppedScope);
    const steppedVariables = await d.request(
      {
        action: 'debug',
        command: 'variables',
        reference: steppedScope.variablesReference,
        expectedConnectionEpoch: d.cursor().epoch,
        expectedPauseEpoch: d.state.debugger.pauseEpoch,
      },
      'about:blank',
    );
    assert.equal(
      steppedVariables.variables?.find((variable) => variable.name === 'next')
        ?.value,
      '10',
      'actual next local is available after resumed/paused step',
    );
    await d.request({ action: 'debug', command: 'resume' }, 'about:blank');
    assert.equal(
      await page.evaluate(() => (window as any).__actualDebugResult),
      10,
    );
    await assert.rejects(
      d.request(
        {
          action: 'debug',
          command: 'evaluate',
          frameId: frame.id,
          expression: 'count = 99',
          expectedConnectionEpoch: d.cursor().epoch,
          expectedPauseEpoch: d.state.debugger.pauseEpoch,
        },
        'about:blank',
      ),
      /stale/,
    );
    assert.equal(
      await page.evaluate(() => (window as any).__actualDebugResult),
      10,
    );
    const blockPaused = new Promise<void>((resolve) =>
      cdp.once('Debugger.paused', () => resolve()),
    );
    await page.evaluate(() => {
      setTimeout(() => {
        let shadowed = 3;
        {
          let shadowed = 30;
          debugger;
          (window as any).__innerScopeValue = shadowed;
        }
        (window as any).__outerScopeValue = shadowed;
      }, 0);
    });
    await blockPaused;
    const blockFrame = d.state.debugger.stackFrames[0];
    const outerLocal = blockFrame.scopes.find(
      (scope) => scope.name === 'local',
    );
    assert.ok(outerLocal);
    const outer = await d.request(
      {
        action: 'debug',
        command: 'variables',
        reference: outerLocal.variablesReference,
        expectedConnectionEpoch: d.cursor().epoch,
        expectedPauseEpoch: d.state.debugger.pauseEpoch,
      },
      'about:blank',
    );
    assert.equal(
      outer.variables?.find((variable) => variable.name === 'shadowed')?.value,
      '3',
      'outer local must not be replaced by the same-name inner block binding',
    );
    await d.request({ action: 'debug', command: 'resume' }, 'about:blank');
    assert.deepEqual(
      await page.evaluate(() => [
        (window as any).__innerScopeValue,
        (window as any).__outerScopeValue,
      ]),
      [30, 3],
    );
  } finally {
    await browser.close();
  }
});

test('diagnostic journals retain full console and normalized network beyond the window and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'circle-browser-journal-'));
  const target = { directory, sessionId: 'fixture', tab: 'tab-1' };
  let d = new BrowserDiagnostics(
    async () => ({}),
    () => {},
    target,
  );
  const lines = Array.from(
    { length: 620 },
    (_, i) => `第${i}行 "quoted"\nsecond line`,
  );
  try {
    for (const [i, text] of lines.entries()) {
      d.event('Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ value: text }],
        stackTrace: {
          callFrames: [
            {
              url: 'http://localhost/source.js',
              lineNumber: i,
              columnNumber: 0,
              functionName: 'run',
            },
          ],
        },
      });
      d.event('Network.requestWillBeSent', {
        requestId: String(i),
        timestamp: i,
        request: {
          url: `http://localhost/${i}`,
          method: 'GET',
          headers: { Cookie: 'PRIVATE_COOKIE_SENTINEL' },
          postData: 'PRIVATE_BODY_SENTINEL',
        },
      });
    }
    // Finish every request only after the first 120 have left the display ring.
    for (let i = 0; i < 620; i++)
      d.event(i % 2 ? 'Network.loadingFailed' : 'Network.loadingFinished', {
        requestId: String(i),
        timestamp: 1000 + i,
        ...(i % 2 ? { errorText: 'fixture network failure' } : {}),
      });
    d.event('Network.responseReceived', {
      requestId: '0',
      timestamp: 621,
      response: {
        status: 200,
        mimeType: 'text/plain',
        headers: { Secret: 'PRIVATE_HEADER_SENTINEL' },
      },
    });
    assert.equal(d.state.console.length, 500);
    assert.equal(d.state.network.length, 500);
    await d.request({ action: 'clearConsole' }, 'about:blank');
    await d.request({ action: 'clearNetwork' }, 'about:blank');
    assert.equal(d.state.console.length, 0);
    await d.dispose();
    d = new BrowserDiagnostics(
      async () => ({}),
      () => {},
      target,
    );
    const readAll = async (domain: 'console' | 'network') => {
      const entries: any[] = [];
      let cursor: { offset: number; seq: number } | undefined;
      for (;;) {
        const page = (await d.log(domain, cursor, 73)).log;
        entries.push(...page.entries);
        cursor = page.cursor;
        if (!page.hasMore) return entries;
      }
    };
    const consoleEntries = await readAll('console');
    assert.deepEqual(
      consoleEntries.map((entry) => entry.data.text),
      lines,
    );
    assert.equal(consoleEntries[0].data.stack[0].line, 1);
    const networkEntries = await readAll('network');
    assert.equal(networkEntries.length, 1241);
    const completions = networkEntries.filter((entry) =>
      ['loadingFinished', 'loadingFailed'].includes(entry.data.phase),
    );
    assert.deepEqual(
      completions.map((entry) => entry.data.id),
      Array.from({ length: 620 }, (_, i) => String(i)),
    );
    assert.equal(completions[1].data.error, 'fixture network failure');
    assert.equal(networkEntries.at(-1).data.status, 200);
    assert.equal(networkEntries.at(-1).data.id, '0');
    const bytes = await readFile(
      join(directory, 'fixture', 'tab-1-network.jsonl'),
      'utf8',
    );
    assert.doesNotMatch(bytes, /PRIVATE_(COOKIE|BODY|HEADER)_SENTINEL/);
    assert.match(bytes, /"workspaceId":"browser"/);
  } finally {
    await d.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser log requests accept bounded cursors and reject renderer paths', () => {
  assert.deepEqual(
    validateBrowserDiagnosticRequest({
      action: 'log',
      tab: 'tab-1',
      domain: 'console',
      cursor: { offset: 0, seq: 0 },
      limit: 73,
    }).action,
    'log',
  );
  for (const extra of [
    { path: '/tmp/foreign' },
    { cursor: { offset: -1, seq: 0 } },
    { limit: 257 },
    { tab: '../foreign' },
  ])
    assert.throws(() =>
      validateBrowserDiagnosticRequest({
        action: 'log',
        tab: 'tab-1',
        domain: 'console',
        ...extra,
      }),
    );
});

test('diagnostic journal write failure remains explicit instead of silently losing logs', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'circle-browser-journal-error-'),
  );
  const blocked = join(directory, 'not-a-directory');
  await writeFile(blocked, 'fixture');
  const d = new BrowserDiagnostics(
    async () => ({}),
    () => {},
    { directory: blocked, sessionId: 'fixture', tab: 't1' },
  );
  try {
    d.event('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'must not silently disappear' }],
    });
    await assert.rejects(d.log('console'));
    assert.equal(d.state.logError, 'browser log could not be saved');
    assert.equal(d.state.console[0].text, 'must not silently disappear');
    await assert.rejects(d.dispose());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local refresh never reads a same-name inner block binding or invokes an accessor', async () => {
  const evaluated: string[] = [];
  const d = new BrowserDiagnostics(async (method, params) => {
    if (method === 'Debugger.evaluateOnCallFrame') {
      evaluated.push(String(params?.expression));
      return { result: { type: 'number', value: 30 } };
    }
    return {
      result:
        params?.objectId === 'block'
          ? [{ name: 'shadowed', value: { type: 'number', value: 30 } }]
          : [
              { name: 'shadowed', value: { type: 'number', value: 3 } },
              { name: 'accessor', get: { type: 'function' } },
              { name: 'x;sideEffect()', value: { type: 'number', value: 1 } },
            ],
    };
  });
  d.event('Debugger.paused', {
    callFrames: [
      {
        callFrameId: 'frame',
        functionName: 'work',
        url: 'http://localhost/main.js',
        location: { lineNumber: 1 },
        scopeChain: [
          { type: 'block', object: { objectId: 'block' } },
          { type: 'local', object: { objectId: 'local' } },
        ],
      },
    ],
  });
  const result = await d.request(
    {
      action: 'debug',
      command: 'variables',
      reference: 'local',
      expectedPauseEpoch: d.state.debugger.pauseEpoch,
      expectedConnectionEpoch: d.cursor().epoch,
    },
    'http://localhost',
  );
  assert.equal(
    result.variables?.find((variable) => variable.name === 'shadowed')?.value,
    '3',
  );
  assert.deepEqual(
    evaluated,
    [],
    'shadowed, accessor and invalid identifier must never become frame expressions',
  );
});
