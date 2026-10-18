import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { CdpPipe, type CdpEvent } from '../src/browser/cdp.js';
import { scratch } from './helpers.js';
import { ownedStartupBrowser } from './browser-startup-fixture.js';
import { fakeBrowser } from './browser-fake-cdp.js';

for (const source of ['input', 'output'] as const)
  test(`a CDP ${source} transport error retains its original cause`, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pipe = new CdpPipe(input, output);
    const events: CdpEvent[] = [];
    pipe.on((event) => events.push(event));
    const original = Object.assign(Error('fixture transport detail'), {
      code: 'EPIPE',
    });
    const pending = pipe.send('Browser.getVersion');
    const rejected = assert.rejects(pending, (error) => {
      assert(error instanceof Error);
      assert.equal(error.message, 'the browser was closed');
      assert.equal(error.cause, original);
      assert.equal((error.cause as NodeJS.ErrnoException).code, 'EPIPE');
      assert.equal(events[0]?.params.reason, error);
      return true;
    });
    (source === 'input' ? input : output).emit('error', original);
    if (!pipe.closed) pipe.close();
    await rejected;
    assert.equal(events.length, 1);
    input.destroy();
    output.destroy();
  });

test('an explicit CDP close retains the caller reason and reports it to listeners', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const pipe = new CdpPipe(input, output);
  const reason = Error('the caller stopped the pipe');
  const events: CdpEvent[] = [];
  pipe.on((event) => events.push(event));
  const pending = pipe.send('Browser.getVersion');
  const rejected = assert.rejects(pending, (error) => error === reason);
  pipe.close(reason);
  pipe.close(Error('later close must not replace the first reason'));
  await rejected;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.params.reason, reason);
  input.destroy();
  output.destroy();
});

const phases = [
  'Browser.getVersion',
  'Target.setDiscoverTargets',
  'Browser.setDownloadBehavior',
];

for (const phase of phases)
  for (const exits of [true, false])
    test(`startup at ${phase} preserves ${exits ? 'a known exit' : 'an unknown exit before cleanup'}`, async (t) => {
      const fixture = ownedStartupBrowser(t, phase, exits);
      await assert.rejects(
        fixture.browser.request(
          'fixture',
          'snapshot',
          {},
          new AbortController().signal,
        ),
        (error) => {
          assert(error instanceof Error);
          assert.match(error.message, /^the browser was closed/);
          assert(error.cause instanceof Error);
          const diagnostics = (error as any).browserStartup;
          assert.equal(diagnostics.phase, phase);
          assert.equal(diagnostics.processAtFailure.observedExit, exits);
          assert.equal(
            diagnostics.processAtFailure.exitCode,
            exits ? 23 : 'unknown',
          );
          assert.equal(diagnostics.processAtFailure.signal, 'unknown');
          assert.equal(diagnostics.cleanupTerminationRequested, !exits);
          assert.match(String(error), new RegExp(`startup ${phase}`));
          assert.match(
            String(error),
            new RegExp(`exitCode=${exits ? 23 : 'unknown'}`),
          );
          assert.match(String(error), /signal=unknown/);
          assert.deepEqual(diagnostics.stderr, [
            'fixture final startup diagnostic',
          ]);
          assert.deepEqual(
            (fixture.browser as any).stderr.slice(-3),
            diagnostics.stderr,
          );
          assert.equal(
            JSON.stringify(diagnostics).includes('--user-data-dir'),
            false,
          );
          return true;
        },
      );
      await fixture.browser.close();
      const child = fixture.child();
      assert(child.exitCode !== null || child.signalCode !== null);
    });

test('a spawn failure does not attach native path or argument properties to diagnostics', async (t) => {
  const original = Object.assign(Error('fixture spawn unavailable'), {
    code: 'ENOENT',
    path: '/synthetic/private/browser',
    spawnargs: [
      '--user-data-dir=/synthetic/private/profile',
      '--host-resolver-rules=MAP private-fixture.invalid 192.0.2.1',
    ],
  });
  const fixture = ownedStartupBrowser(t, 'unused', false, original);
  await assert.rejects(
    fixture.browser.request(
      'fixture',
      'snapshot',
      {},
      new AbortController().signal,
    ),
    (error) => {
      assert(error instanceof Error);
      assert.equal(
        error.message,
        'the browser could not start: fixture spawn unavailable',
      );
      assert(error.cause instanceof Error);
      assert.equal(error.cause.cause, undefined);
      assert.doesNotMatch(
        inspect(error, { depth: 10 }),
        /spawnargs|synthetic\/private|private-fixture\.invalid/,
      );
      return true;
    },
  );
});

test('the Node test reporter exposes startup phase, unknown process status and transport cause', (t) => {
  const root = scratch(t);
  const file = join(root, 'reporter.test.mjs');
  const fixtureModule = new URL('./browser-startup-fixture.ts', import.meta.url)
    .href;
  const cdpModule = new URL('../src/browser/cdp.ts', import.meta.url).href;
  writeFileSync(
    file,
    `
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CdpPipe } from ${JSON.stringify(cdpModule)};
import { ownedStartupBrowser } from ${JSON.stringify(fixtureModule)};
test('show the startup failure in CI', async (t) => {
  const fixture = ownedStartupBrowser(t, 'Target.setDiscoverTargets', false);
  await fixture.browser.request('fixture', 'snapshot', {}, new AbortController().signal);
});
test('show the original transport error in CI', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const pipe = new CdpPipe(input, output);
  const pending = pipe.send('Browser.getVersion');
  output.emit('error', Object.assign(Error('reporter original transport detail'), { code: 'EPIPE' }));
  try { await pending; }
  finally { input.destroy(); output.destroy(); }
});
test('show a spawn failure without native argument properties', async (t) => {
  const original = Object.assign(Error('fixture spawn unavailable'), {
    code: 'ENOENT',
    path: '/synthetic/private/browser',
    spawnargs: ['--user-data-dir=/synthetic/private/profile', '--host-resolver-rules=MAP private-fixture.invalid 192.0.2.1'],
  });
  const fixture = ownedStartupBrowser(t, 'unused', false, original);
  await fixture.browser.request('fixture', 'snapshot', {}, new AbortController().signal);
});
`,
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CIRCLE_HOME: join(root, 'reporter-home'),
  };
  delete environment.NODE_TEST_CONTEXT;
  const report = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-reporter=spec', file],
    { encoding: 'utf8', env: environment, timeout: 10_000 },
  );
  assert.equal(report.error, undefined);
  const output = report.stdout + report.stderr;
  assert.equal(report.status, 1, output);
  assert.match(output, /startup Target\.setDiscoverTargets/);
  assert.match(output, /exitCode=unknown; signal=unknown/);
  assert.match(output, /stderrComplete=false/);
  assert.match(output, /fixture final startup diagnostic/);
  assert.match(output, /reporter original transport detail/);
  assert.match(output, /code: 'EPIPE'/);
  assert.match(output, /fixture spawn unavailable/);
  assert.match(output, /ℹ fail 3/);
  assert.doesNotMatch(output, /--user-data-dir=|downloadPath:|discover: true/);
  assert.doesNotMatch(
    output,
    /spawnargs|synthetic\/private|private-fixture\.invalid/,
  );
});

test('a browser that ends during its start is reported by how it ended, and the next action starts it again (#106)', async (t) => {
  // As seen in CI: the protocol pipe closes at the first command, and the exit and the
  // browser's last words arrive only after that
  let starts = 0;
  const fake = fakeBrowser(t, (request, browser) => {
    if (request.method !== 'Browser.getVersion' || ++starts > 1) return;
    browser.end('fixture: the browser could not start', 41);
    return true;
  });
  await assert.rejects(
    fake.browser.request('c', 'snapshot', {}, new AbortController().signal),
    (error) => {
      assert(error instanceof Error);
      assert.match(
        error.message,
        /^the browser was closed \(startup Browser\.getVersion; exitCode=41; signal=unknown; /,
      );
      assert.match(error.message, /fixture: the browser could not start/);
      const diagnostics = (error as any).browserStartup;
      assert.deepEqual(diagnostics.processAtFailure, {
        observedExit: true,
        exitCode: 41,
        signal: 'unknown',
      });
      // Circle did not signal a browser that had ended by itself
      assert.equal(diagnostics.cleanupTerminationRequested, false);
      assert.deepEqual(diagnostics.stderr, [
        'fixture: the browser could not start',
      ]);
      return true;
    },
  );
  const ended = fake.child();
  assert.equal(ended.exitCode, 41);
  const shown = await fake.browser.request(
    'c',
    'snapshot',
    {},
    new AbortController().signal,
  );
  assert.match(shown.text, /Fake page/);
  assert.notEqual(fake.child(), ended);
  assert.equal(
    fake.requests.filter((request) => request.method === 'Browser.getVersion')
      .length,
    2,
  );
});
