import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserDiagnostics } from '../src/browser-diagnostics';
import { validateBrowserDiagnosticRequest } from '../src/browser-diagnostics-contracts';
import type { BrowserDiagnosticEvent } from '../src/browser-diagnostics-contracts';
test('diagnostic events are subscribed, bounded, domain-filtered and coalesced dirty notifications', async () => {
  const events: Omit<BrowserDiagnosticEvent, 'sessionId' | 'tab'>[] = [];
  const d = new BrowserDiagnostics(
    async () => ({}),
    (event) => events.push(event),
  );
  d.event('Runtime.consoleAPICalled', {
    type: 'log',
    args: [{ value: 'unobserved' }],
  });
  await delay(35);
  assert.equal(events.length, 0);
  d.watch('console-view', ['console'], true);
  const started = Date.now();
  for (let i = 0; i < 1000; i++)
    d.event('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'line ' + i }],
    });
  d.event('Network.requestWillBeSent', {
    requestId: 'n1',
    timestamp: 1,
    request: { url: 'http://localhost/test', method: 'GET' },
  });
  await delay(40);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].domains, ['console']);
  assert.equal(events[0].sequence, 1);
  assert(events[0].at >= started);
  assert(events[0].emittedAt >= events[0].at);
  assert(JSON.stringify(events[0]).length < 400);
  assert(!('state' in events[0]));
  assert.equal(d.state.console.length, 500);
  const consoleState = await d.request(
    { action: 'read', domains: ['console'] },
    'http://localhost',
  );
  assert.equal(consoleState.state.console.length, 500);
  assert.deepEqual(consoleState.state.network, []);
  const networkState = await d.request(
    { action: 'read', domains: ['network'] },
    'http://localhost',
  );
  assert.equal(networkState.state.network.length, 1);
  assert.deepEqual(networkState.state.console, []);
  d.watch('console-view', [], false);
  d.event('Runtime.consoleAPICalled', {
    type: 'log',
    args: [{ value: 'after close' }],
  });
  await delay(35);
  assert.equal(events.length, 1);
});
test('DevTools lifecycle changes epoch and causes full current-state recovery, disposed watches emit nothing', async () => {
  const events: Omit<BrowserDiagnosticEvent, 'sessionId' | 'tab'>[] = [];
  const d = new BrowserDiagnostics(
    async () => ({}),
    (event) => events.push(event),
  );
  const initial = d.watch('debug-view', ['debug'], true).stream;
  d.state.owner = 'devtools';
  d.resetEpoch();
  await delay(35);
  assert.notEqual(events[0].epoch, initial.epoch);
  assert.equal(events[0].sequence, 1);
  assert.deepEqual(events[0].domains, ['lifecycle']);
  d.state.owner = 'circle';
  d.resetEpoch();
  await delay(35);
  assert.notEqual(events[1].epoch, events[0].epoch);
  assert.equal(events[1].sequence, 1);
  const current = await d.request({ action: 'read' }, 'http://localhost');
  assert.equal(current.stream?.epoch, events[1].epoch);
  assert.equal(current.state.owner, 'circle');
  d.event('Debugger.resumed', {});
  d.dispose();
  await delay(35);
  assert.equal(events.length, 2);
});
test('subscription bridge refuses forged scope, tokens, domains and nonboolean switches', () => {
  assert.deepEqual(
    validateBrowserDiagnosticRequest({
      action: 'watch',
      tab: 't1',
      subscription: 'fixture-1',
      domains: ['console'],
      enabled: true,
    }),
    {
      action: 'watch',
      tab: 't1',
      subscription: 'fixture-1',
      domains: ['console'],
      enabled: true,
    },
  );
  for (const extra of [
    { tab: '../t1' },
    { subscription: 'a/b' },
    { domains: ['Runtime.evaluate'] },
    { enabled: 1 },
  ])
    assert.throws(() =>
      validateBrowserDiagnosticRequest({
        action: 'watch',
        tab: 't1',
        subscription: 'fixture',
        domains: ['console'],
        enabled: true,
        ...extra,
      }),
    );
  assert.throws(() =>
    validateBrowserDiagnosticRequest({ action: 'read', domains: ['anything'] }),
  );
});
