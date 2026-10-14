import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForDownloadStart } from '../src/browser/navigation.js';

test('download-start waiting is bounded and cancellation ends it', async () => {
  await assert.rejects(
    waitForDownloadStart(
      'download',
      () => false,
      new AbortController().signal,
      30,
    ),
    /download event did not arrive/,
  );
  const controller = new AbortController();
  const waiting = waitForDownloadStart(
    'download',
    () => false,
    controller.signal,
  );
  controller.abort(new Error('stop fixture'));
  await assert.rejects(waiting, /stop fixture/);
  let arrived = false;
  const timer = setTimeout(() => (arrived = true), 20);
  await waitForDownloadStart(
    'download',
    () => arrived,
    new AbortController().signal,
    100,
  );
  clearTimeout(timer);
  await waitForDownloadStart(
    'aborted',
    () => false,
    new AbortController().signal,
    10,
  );
  await waitForDownloadStart(
    'page',
    () => false,
    new AbortController().signal,
    0,
  );
});
