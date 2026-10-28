import test from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { join } from 'node:path';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { getEventListeners } from 'node:events';
import { cleanup, cleanupServer, scratch as made } from './helpers.js';
import {
  BrowserFixture,
  BrowserFixtureDeadline,
  type BrowserFixtureRecord,
} from './browser-fixture.js';
import {
  executable,
  listen,
  browserFixture,
} from './browser-chrome-helpers.js';

test(
  'a fixture deadline closes its owned real Chrome and rejects the original pending CDP request',
  { skip: executable ? false : 'no Chrome, Edge or Chromium is installed' },
  async (t) => {
    const temp = made(t, 'circle-chrome-fixture-deadline-');
    const site = createHttp((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>local pending fixture</title>');
    });
    const url = `http://127.0.0.1:${await listen(site)}`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
    });
    const records: BrowserFixtureRecord[] = [];
    const fixture = browserFixture(
      chrome,
      60_000 + 15_000 + 5000 + 3000,
      (record) => records.push(record),
    );
    cleanup(t, () => fixture.close());
    await fixture.run({ phase: 'prepare local page', action: 'navigate' }, () =>
      chrome.request('deadline', 'navigate', { url }, fixture.signal),
    );
    const internal = chrome as unknown as {
      child: ChildProcess;
      conversations: Map<string, { tabs: Map<string, { session: string }> }>;
      send: (
        method: string,
        params?: Record<string, unknown>,
        session?: string,
      ) => Promise<any>;
    };
    const child = internal.child;
    const tab = internal.conversations.get('deadline')!.tabs.get('t1')!;
    const pending = internal.send(
      'Runtime.evaluate',
      {
        expression: 'window.circlePendingFixture = true; new Promise(() => {})',
        awaitPromise: true,
        returnByValue: true,
      },
      tab.session,
    );
    const observed = pending.then(
      () => ({ rejected: false, error: undefined }),
      (error: unknown) => ({ rejected: true, error }),
    );
    const marker = await fixture.run(
      {
        phase: 'verify pending evaluation started',
        method: 'Runtime.evaluate',
        session: tab.session,
      },
      () =>
        internal.send(
          'Runtime.evaluate',
          { expression: 'window.circlePendingFixture', returnByValue: true },
          tab.session,
        ),
      5000,
    );
    assert.equal(
      marker.result.value,
      true,
      'the real pending evaluation started',
    );
    // A broken fixture bound must fail this test without hanging the whole suite.
    let fallback = false;
    let fallbackClose: Promise<void> | undefined;
    const watchdog = setTimeout(
      () => {
        fallback = true;
        fallbackClose = fixture.close();
        fallbackClose.catch(() => {});
      },
      200 + 2000 + 3000 + 2000 + 1000 + 1000,
    );
    try {
      await assert.rejects(
        fixture.run(
          {
            phase: 'never-resolving real evaluation',
            method: 'Runtime.evaluate',
            session: tab.session,
          },
          () => pending,
          200,
        ),
        (error) => {
          assert.ok(error instanceof BrowserFixtureDeadline);
          assert.equal(error.limitMs, 200);
          assert.equal(error.fixturePhase.method, 'Runtime.evaluate');
          assert.equal(error.fixturePhase.session, tab.session);
          assert.equal(error.fixturePhase.status, 'timeout');
          assert.ok(fixture.signal.aborted);
          assert.equal(
            Object.hasOwn(error, 'browserFixtureCleanup'),
            false,
            error,
          );
          return true;
        },
      );
    } finally {
      clearTimeout(watchdog);
      await fallbackClose;
    }
    assert.equal(fallback, false, 'the fixture phase deadline owns shutdown');
    const result = await observed;
    assert.equal(result.rejected, true);
    assert.match(String(result.error), /browser was closed/);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' });
    assert.ok(records.some((record) => record.status === 'late-rejection'));
    assert.ok(records.some((record) => record.status === 'cleanup-after'));
    const serialized = JSON.stringify(records);
    assert.equal(serialized.includes('circlePendingFixture'), false);
    assert.equal(serialized.includes(url), false);
    assert.equal(serialized.includes('expression'), false);
  },
);

test('fixture phases share one deadline and never dispatch a later action after it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const records: BrowserFixtureRecord[] = [];
  let closed = 0;
  const fixture = new BrowserFixture({
    budgetMs: 100,
    state: () => ({ tab: 't1', session: 'fixture-session', dialogs: [] }),
    close: async () => {
      closed++;
    },
    report: (record) => records.push(record),
  });
  cleanup(t, () => fixture.close());
  let finishFirst!: () => void;
  const first = fixture.run(
    { phase: 'first completed action', action: 'snapshot' },
    () => new Promise<void>((resolve) => (finishFirst = resolve)),
  );
  await Promise.resolve();
  t.mock.timers.tick(60);
  finishFirst();
  await first;
  let rejectSecond!: (error: Error) => void;
  const second = fixture.run(
    { phase: 'second pending action', action: 'snapshot' },
    () => new Promise<void>((_resolve, reject) => (rejectSecond = reject)),
    1000,
  );
  const rejected = assert.rejects(second, (error) => {
    assert.ok(error instanceof BrowserFixtureDeadline);
    assert.equal(error.limitMs, 100);
    assert.equal(error.fixturePhase.elapsed, 100);
    assert.equal(error.fixturePhase.phase, 'second pending action');
    return true;
  });
  await Promise.resolve();
  t.mock.timers.tick(39);
  assert.equal(fixture.signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  let dispatched = false;
  await assert.rejects(
    fixture.run({ phase: 'too late' }, async () => {
      dispatched = true;
    }),
    (error) => error === fixture.signal.reason,
  );
  assert.equal(dispatched, false);
  assert.equal(closed, 1);
  rejectSecond(Error('late CDP failure'));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(records.some((record) => record.status === 'late-rejection'));
  assert.equal(getEventListeners(fixture.signal, 'abort').length, 0);
});
