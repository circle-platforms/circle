import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { testBrowserOptions } from './helpers/test-browser.ts';

test('test browser selection honors an explicit component channel without silently skipping', () => {
  assert.deepEqual(
    testBrowserOptions(
      '/missing',
      'darwin',
      { CIRCLE_TEST_BROWSER_CHANNEL: 'chrome' },
      () => false,
    ),
    { channel: 'chrome' },
  );
});
test('installed macOS Chrome and bundled Chromium both keep composer journeys enabled', () => {
  assert.deepEqual(
    testBrowserOptions(
      '/bundled',
      'darwin',
      {},
      (path) =>
        path === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ),
    { channel: 'chrome' },
  );
  assert.deepEqual(
    testBrowserOptions('/bundled', 'darwin', {}, (path) => path === '/bundled'),
    {},
  );
});
test('Windows Chrome and the prior Linux executable paths remain supported', () => {
  const base = 'C:/Programs';
  assert.deepEqual(
    testBrowserOptions(
      '/missing',
      'win32',
      { PROGRAMFILES: base },
      (path) =>
        path === join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ),
    { channel: 'chrome' },
  );
  assert.deepEqual(
    testBrowserOptions(
      '/missing',
      'linux',
      {},
      (path) => path === '/usr/bin/google-chrome-stable',
    ),
    { executablePath: '/usr/bin/google-chrome-stable' },
  );
  assert.equal(
    testBrowserOptions('/missing', 'darwin', {}, () => false),
    undefined,
  );
});
