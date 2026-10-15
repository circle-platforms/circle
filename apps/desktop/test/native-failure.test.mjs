import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  captureNativeFailure,
  cleanupNativeFixture,
} from './helpers/native-failure.mjs';

const secret = 'sensitive-value-must-not-reach-artifacts';
const native = `
  import { writeFileSync, mkdirSync } from 'node:fs';
  import { join } from 'node:path';
  const state = globalThis.nativeFailureFixture;
  const original = Error('locator.fill: Timeout 20000ms exceeded');
  original.name = 'TimeoutError';
  original.stack = 'TimeoutError: locator.fill: Timeout 20000ms exceeded\\n    at synthetic base url fill';
  globalThis.nativeFailurePrimary = original;
  const bootstrap = Error('synthetic renderer bootstrap rejected');
  bootstrap.stack = 'Error: synthetic renderer bootstrap rejected\\n    at synthetic bootstrap';
  const listeners = new Map();
  const page = {
    on(name, callback) { listeners.set(name, callback); return page; },
    setDefaultTimeout(value) { state.timeout = value; },
    url: () => 'circle://workbench/index.html',
    pageErrors: async () => process.env.NATIVE_FAILURE_MODE==='large'?Array.from({length:30},()=>{const error=Error('x'.repeat(10000));error.stack='s'.repeat(10000);return error;}):[bootstrap],
    consoleMessages: async () => process.env.NATIVE_FAILURE_MODE==='large'?Array.from({length:300},()=>({type:()=> 'error',text:()=> 'c'.repeat(10000)})):[{ type: () => 'error', text: () => 'synthetic bootstrap console' }],
    locator: (selector) => ({ selector }),
    async screenshot(options) {
      if (options.mask[0].selector !== 'input,textarea') throw Error('inputs were not masked');
      state.inputsMasked = true;
      writeFileSync(options.path, 'synthetic masked screenshot');
    },
    async evaluate(fn, value) {
      if (process.env.NATIVE_FAILURE_MODE === 'secondary' && String(fn).includes('document.readyState'))
        throw Error('synthetic DOM probe failed');
      return fn(value);
    },
    getByRole(role, options) { return { async fill() {
      state.locator = {role, name: options.name, exact: options.exact};
      listeners.get('pageerror')?.(bootstrap);
      if(process.env.NATIVE_FAILURE_MODE==='large')for(let i=0;i<30;i++)listeners.get('pageerror')?.(Error('e'.repeat(10000)));
      if(process.env.NATIVE_FAILURE_MODE==='write-fails')mkdirSync(join(state.output,'failure.json'));
      throw original;
    }}; },
  };
  const window = {
    id: 1, show() {}, setContentSize(width,height) {state.contentRequest={width,height};},
    isVisible:()=>true,isFocused:()=>true,isMinimized:()=>false,
    getBounds:()=>({x:0,y:0,width:1400,height:900}),
    getContentBounds:()=>({x:0,y:0,width:1400,height:900}),
    webContents:{getURL:()=>page.url(),isLoading:()=>false,isDestroyed:()=>false},
  };
  export const _electron = { async launch(options) {
    state.dataPath = options.env.CIRCLE_WORKBENCH_DATA_DIR;
    state.output = join(options.args[0],'artifacts/browser-coordinate-live');
    const sensitive = process.env.NATIVE_FAILURE_SECRET;
    globalThis.location = {href:page.url()};
    globalThis.document = {
      readyState:'complete',title:'synthetic isolated workbench',
      getElementById:()=>({childElementCount:0}),
      querySelectorAll:(selector)=>process.env.NATIVE_FAILURE_MODE==='large'?Array.from({length:selector==='input,textarea'?60:30},()=>({tagName:'INPUT',type:'password',disabled:false,value:sensitive,getAttribute:(name)=>name==='type'?'password':'l'.repeat(1000)})):selector==='input,textarea'?[{
        tagName:'INPUT',type:'password',disabled:false,value:sensitive,
        getAttribute:(name)=>({type:'password','aria-label':'api key'}[name]),
      }]:[],
    };
    globalThis.window = {circleDesktop:{
      apiVersion:1,
      info:async()=>({dataPath:state.dataPath,packaged:true,runtimeConnected:true,frontendOnly:false}),
      runtimeState:async()=>({seq:23,connected:true,event:process.env.NATIVE_FAILURE_MODE==='large'?{kind:'k'.repeat(500),at:'a'.repeat(500),eventSeq:7}:undefined,snapshot:{
        activeSessionId:'fixture-session',
        runtime:{configured:false,connected:true,hasKey:false,observedAt:process.env.NATIVE_FAILURE_MODE==='large'?'o'.repeat(500):'2026-01-01T00:00:00Z',coreVersion:process.env.NATIVE_FAILURE_MODE==='large'?'v'.repeat(500):'fixture',error:sensitive},
        sessions:[{id:'fixture-session',state:'idle',messages:[{text:sensitive}]}],
        settings:{endpoint:sensitive,key:sensitive},
      }}),
    }};
    return {
      context:()=>({on(name,callback){if(name==='page')callback(page);}}),
      firstWindow:async()=>page,
      evaluate:async(fn)=>fn({BrowserWindow:{getAllWindows:()=>process.env.NATIVE_FAILURE_MODE==='large'?Array(12).fill(window):[window]}}),
      async close(){state.closeCalled=true;if(process.env.NATIVE_FAILURE_MODE==='secondary')throw Error('synthetic cleanup failed');},
    };
  }};
`;
const http = `
  export function createServer(){
    const state=globalThis.nativeFailureFixture;
    const server={
      listen(...args){queueMicrotask(args.at(-1));return server;},
      address:()=>({port:12345}),
      closeAllConnections(){state.connectionsClosed=true;},
      close(callback){state.serverClosed=true;callback(process.env.NATIVE_FAILURE_MODE==='server-callback'?Error('synthetic server close callback failed'):undefined);},
    };return server;
  }
`;
function failedCoordinate(t, mode = '') {
  const root = mkdtempSync(join(tmpdir(), 'circle-native-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'app');
  const folder = join(app, 'test');
  mkdirSync(join(folder, 'helpers'), { recursive: true });
  mkdirSync(join(root, 'tmp'));
  const entry = join(folder, 'browser-coordinate-live.mjs');
  writeFileSync(
    entry,
    readFileSync(new URL('./browser-coordinate-live.mjs', import.meta.url)),
  );
  writeFileSync(
    join(folder, 'helpers/native-failure.mjs'),
    readFileSync(new URL('./helpers/native-failure.mjs', import.meta.url)),
  );
  const record = join(root, 'record.json');
  const hooks = join(root, 'hooks.mjs');
  writeFileSync(
    hooks,
    `import {registerHooks} from 'node:module';
     import {writeFileSync} from 'node:fs';
     globalThis.nativeFailureFixture={};
     process.on('uncaughtExceptionMonitor',error=>writeFileSync(${JSON.stringify(record)},JSON.stringify({
       ...globalThis.nativeFailureFixture,
       primaryIdentityPreserved:error===globalThis.nativeFailurePrimary,
       reportedName:error?.name,reportedMessage:error?.message,
     })));
     registerHooks({resolve(specifier,context,nextResolve){
       const source=specifier==='playwright'?${JSON.stringify(native)}:specifier==='node:http'?${JSON.stringify(http)}:undefined;
       if(source!==undefined)return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
       return nextResolve(specifier,context);
     }});`,
  );
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(hooks).href, entry],
    {
      env: {
        ...process.env,
        CIRCLE_HOME: join(root, 'home'),
        CIRCLE_WORKBENCH_DATA_DIR: join(root, 'data'),
        CIRCLE_DESKTOP_EXECUTABLE: 'synthetic-electron-never-started',
        CIRCLE_DESKTOP_APP_PATH: app,
        TMPDIR: join(root, 'tmp'),
        TMP: join(root, 'tmp'),
        TEMP: join(root, 'tmp'),
        NATIVE_FAILURE_MODE: mode,
        NATIVE_FAILURE_SECRET: secret,
      },
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  const observed = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(observed.primaryIdentityPreserved, true, result.stderr);
  assert.equal(observed.reportedName, 'TimeoutError');
  assert.equal(observed.timeout, 20000);
  assert.deepEqual(observed.contentRequest, { width: 1400, height: 900 });
  assert.equal(observed.serverClosed, true);
  assert.equal(existsSync(dirname(observed.dataPath)), false);
  return {
    result,
    observed,
    output: join(app, 'artifacts/browser-coordinate-live'),
  };
}

test('the coordinate harness records its failed attempt and early page errors without sensitive UI or runtime values', (t) => {
  const { output, observed, result } = failedCoordinate(t);
  const bytes = readFileSync(join(output, 'failure.json'), 'utf8');
  const details = JSON.parse(bytes);
  assert.equal(details.stage, 'fill base url');
  assert.ok(details.attempt.id);
  assert.ok(details.attempt.startedAt);
  assert.ok(details.observer.pageErrorListenerStartedAt);
  assert.equal(details.error.name, 'TimeoutError');
  assert.ok(details.events.includes('synthetic renderer bootstrap rejected'));
  assert.equal(
    details.probes.page.value.errors[0].message,
    'synthetic renderer bootstrap rejected',
  );
  assert.equal(details.probes.bridge.value.seq, 23);
  assert.equal(details.probes.bridge.value.runtime.configured, false);
  assert.equal(details.probes.bridge.value.runtime.errorPresent, true);
  assert.equal(details.probes.dom.value.rootChildren, 0);
  assert.equal(details.probes.windows.value.items[0].loading, false);
  assert.equal(observed.inputsMasked, true);
  assert.match(
    details.probes.screenshot.value.file,
    new RegExp(details.attempt.id),
  );
  assert.equal(
    readFileSync(join(output, details.probes.screenshot.value.file), 'utf8'),
    'synthetic masked screenshot',
  );
  assert.equal(bytes.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
});

test('a failed diagnostic probe and application cleanup preserve the coordinate error and still close its server and scratch folder', (t) => {
  const { output } = failedCoordinate(t, 'secondary');
  const details = JSON.parse(
    readFileSync(join(output, 'failure.json'), 'utf8'),
  );
  assert.equal(details.error.name, 'TimeoutError');
  assert.equal(details.probes.dom.status, 'unavailable');
  assert.match(details.probes.dom.error.message, /synthetic DOM probe failed/);
  assert.equal(details.probes.bridge.status, 'captured');
  assert.equal(details.cleanupErrors[0].name, 'Error');
  assert.equal(details.cleanupErrors[0].operation, 'application');
  assert.match(details.cleanupErrors[0].message, /synthetic cleanup failed/);
});

test('a server close callback rejection is disclosed without replacing the primary failure or skipping scratch cleanup', (t) => {
  const { output } = failedCoordinate(t, 'server-callback');
  const details = JSON.parse(
    readFileSync(join(output, 'failure.json'), 'utf8'),
  );
  assert.equal(details.error.name, 'TimeoutError');
  assert.equal(details.cleanupErrors[0].operation, 'server');
  assert.match(
    details.cleanupErrors[0].message,
    /synthetic server close callback failed/,
  );
});

test('an unwritable detailed record preserves the immutable primary record, observed page error and original rejection', (t) => {
  const { output, result } = failedCoordinate(t, 'write-fails');
  assert.match(result.stderr, /coordinate failure diagnostic failed/);
  assert.match(result.stderr, /EISDIR/);
  assert.match(result.stderr, /synthetic renderer bootstrap rejected/);
  assert.match(
    result.stderr,
    /Error \[TimeoutError\]: locator.fill: Timeout 20000ms exceeded/,
  );
  const primaryFiles = readdirSync(output).filter((name) =>
    name.startsWith('primary-'),
  );
  assert.equal(primaryFiles.length, 1);
  const primary = JSON.parse(
    readFileSync(join(output, primaryFiles[0]), 'utf8'),
  );
  assert.equal(primary.error.name, 'TimeoutError');
  assert.equal(primary.stage, 'fill base url');
  assert.ok(primary.events.includes('synthetic renderer bootstrap rejected'));
  assert.equal(primaryFiles[0], primary.primaryFile);
});

test('native failure records bound large errors, console history, DOM lists and owned windows with explicit truncation counts', (t) => {
  const { output } = failedCoordinate(t, 'large');
  const details = JSON.parse(
    readFileSync(join(output, 'failure.json'), 'utf8'),
  );
  assert.equal(details.events.length, 20);
  assert.equal(details.eventsSummary.count, 31);
  assert.equal(details.eventsSummary.truncated, true);
  assert.equal(details.eventsSummary.textTruncated, true);
  const page = details.probes.page.value;
  assert.equal(page.errors.length, 20);
  assert.equal(page.errorsSummary.count, 30);
  assert.equal(page.errorsSummary.truncated, true);
  assert.equal(page.errors[0].message.length, 2000);
  assert.equal(page.errors[0].limits.message.characters, 10000);
  assert.equal(page.errors[0].limits.message.truncated, true);
  assert.equal(page.consoleErrors.length, 20);
  assert.equal(page.consoleSummary.count, 300);
  assert.equal(page.consoleSummary.inspected, 200);
  assert.equal(page.consoleSummary.truncated, true);
  assert.equal(page.consoleSummary.textTruncated, true);
  assert.equal(details.probes.dom.value.inputs.count, 60);
  assert.equal(details.probes.dom.value.inputs.items.length, 50);
  assert.equal(details.probes.dom.value.inputs.truncated, true);
  assert.equal(details.probes.dom.value.inputs.items[0].label.length, 200);
  assert.equal(details.probes.dom.value.inputs.items[0].labelTruncated, true);
  assert.equal(details.probes.dom.value.inputs.items[0].type, 'password');
  assert.equal(details.probes.bridge.value.event.kind.length, 100);
  assert.equal(details.probes.bridge.value.event.kindTruncated, true);
  assert.equal(details.probes.bridge.value.event.atTruncated, true);
  assert.equal(details.probes.bridge.value.runtime.observedAtTruncated, true);
  assert.equal(details.probes.bridge.value.runtime.coreVersionTruncated, true);
  assert.equal(details.probes.windows.value.count, 12);
  assert.equal(details.probes.windows.value.items.length, 10);
  assert.equal(details.probes.windows.value.truncated, true);
});

test(
  'native diagnostic probes share a bound and preserve the first record while unavailable reads remain pending',
  { timeout: 6000 },
  async (t) => {
    const output = mkdtempSync(join(tmpdir(), 'circle-native-failure-bound-'));
    t.after(() => rmSync(output, { recursive: true, force: true }));
    writeFileSync(
      join(output, 'failure.json'),
      JSON.stringify({ attempt: { id: 'previous-attempt' } }),
    );
    writeFileSync(join(output, 'failure-previous-attempt.png'), 'old capture');
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const probeStarted = new Promise((resolve) => {
      started = resolve;
    });
    const original = Error('primary fixture failure');
    const capture = captureNativeFailure({
      app: { evaluate: () => pending },
      page: {
        url: () => 'circle://workbench/index.html',
        pageErrors: () => {
          started();
          return pending;
        },
        evaluate: () => pending,
        locator: () => ({}),
        screenshot: () => pending,
      },
      error: original,
      events: [],
      output,
      attempt: { id: 'controlled-bound', startedAt: new Date().toISOString() },
      stage: 'fill base url',
      expectedDataPath: 'synthetic-only',
    });
    await probeStarted;
    const first = JSON.parse(
      readFileSync(join(output, 'failure.json'), 'utf8'),
    );
    assert.equal(first.error.message, original.message);
    assert.equal(first.attempt.id, 'controlled-bound');
    assert.deepEqual(first.probes, {});
    const immutable = readFileSync(join(output, first.primaryFile), 'utf8');
    const details = await capture;
    assert.equal(
      JSON.parse(readFileSync(join(output, 'failure.json'), 'utf8')).error
        .message,
      original.message,
    );
    for (const probe of Object.values(details.probes)) {
      assert.equal(probe.status, 'unavailable');
      assert.match(probe.error.message, /diagnostic deadline exceeded/);
    }
    assert.equal(details.probes.screenshot.value, undefined);
    assert.equal(
      readFileSync(join(output, first.primaryFile), 'utf8'),
      immutable,
    );
    assert.equal(
      readFileSync(join(output, 'failure-previous-attempt.png'), 'utf8'),
      'old capture',
    );
    release();
  },
);

test('without a primary failure native cleanup still rejects its original error after attempting every owned cleanup', async () => {
  const original = Error('application cleanup failed');
  const calls = [];
  await assert.rejects(
    cleanupNativeFixture({
      primaryFailed: false,
      operations: [
        [
          'app',
          () => {
            calls.push('app');
            throw original;
          },
        ],
        ['server', () => calls.push('server')],
        ['scratch', () => calls.push('scratch')],
      ],
      onErrors: () => calls.push('diagnostic'),
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, ['app', 'server', 'scratch', 'diagnostic']);
});

test('secondary cleanup diagnostic failure cannot replace an original cleanup rejection or turn it green', async () => {
  const original = Error('owned cleanup rejected');
  await assert.rejects(
    cleanupNativeFixture({
      primaryFailed: false,
      operations: [
        [
          'owned',
          () => {
            throw original;
          },
        ],
      ],
      onErrors: () => {
        throw Error('secondary diagnostic rejected');
      },
    }),
    (error) => error === original,
  );
});
