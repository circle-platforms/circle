import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { waitBrowserState } from './helpers/browser-state.mjs';

// Run the same serialized callback against a synthetic async preload bridge.
const pageFor = (browserState) => ({
  evaluate: (callback, id) =>
    runInNewContext('(' + callback.toString() + ')', {
      window: { circleDesktop: { browserState } },
    })(id),
});

test('browser readiness awaits IPC and an async predicate until the actual state matches', async () => {
  const states = [
    { url: 'about:blank', title: '', loading: true },
    { url: 'http://fixture/', title: 'fixture', loading: true },
    { url: 'http://fixture/', title: 'fixture', loading: false },
  ];
  const reads = [];
  const checks = [];
  const page = pageFor(async (id) => {
    reads.push(id);
    await Promise.resolve();
    return states[reads.length - 1];
  });
  const state = await waitBrowserState(
    page,
    'session1',
    async (state) => {
      checks.push(state);
      await Promise.resolve();
      return (
        state.url === 'http://fixture/' &&
        state.title === 'fixture' &&
        !state.loading
      );
    },
    { intervalMs: 0 },
  );
  assert.equal(state, states[2]);
  assert.deepEqual(reads, ['session1', 'session1', 'session1']);
  assert.deepEqual(checks, states);
});

test('browser readiness preserves the original IPC and predicate failures', async () => {
  const ipcError = Error('fixture IPC unavailable');
  await assert.rejects(
    waitBrowserState(
      pageFor(async () => {
        throw ipcError;
      }),
      'session1',
      () => true,
    ),
    (error) => error === ipcError,
  );
  const predicateError = Error('fixture predicate failed');
  await assert.rejects(
    waitBrowserState(
      pageFor(async () => ({ loading: true })),
      'session1',
      async () => {
        throw predicateError;
      },
    ),
    (error) => error === predicateError,
  );
});

test('browser readiness rejects on its bound with the last state instead of passing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lastState = { url: 'about:blank', title: '', loading: true };
  let checked;
  const firstCheck = new Promise((resolve) => (checked = resolve));
  const pending = waitBrowserState(
    pageFor(async () => lastState),
    'session1',
    () => {
      checked();
      return false;
    },
  );
  const rejected = assert.rejects(pending, (error) => {
    assert.match(error.message, /session1.*timed out after 10000ms/);
    assert.ok(error.message.includes(JSON.stringify(lastState)));
    return true;
  });
  await firstCheck;
  t.mock.timers.tick(10000);
  await rejected;
});
