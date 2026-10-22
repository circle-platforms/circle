import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeForQuit } from '../src/quit.ts';

test('a settled close lets the quit proceed without a failure', async () => {
  assert.equal(await closeForQuit(() => Promise.resolve(), 50), undefined);
});

test('a failing close comes back as the failure but cannot hold the quit', async () => {
  const failure = await closeForQuit(
    () => Promise.reject(Error('the browser is stuck')),
    50,
  );
  assert.match(String(failure), /the browser is stuck/);
});

test('a stalled close is given up on at the limit', async () => {
  const started = Date.now();
  const failure = await closeForQuit(() => new Promise(() => {}), 50);
  assert.match(String(failure), /did not finish in time/);
  assert.ok(Date.now() - started < 5000, 'the quit was not bounded');
});

test('a close that fails only after the limit does not disturb the settled quit', async () => {
  const failure = await closeForQuit(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    throw Error('late');
  }, 25);
  assert.match(String(failure), /did not finish in time/);
  // The late rejection is already handled: nothing throws here or at process level
  await new Promise((resolve) => setTimeout(resolve, 150));
});
