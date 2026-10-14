import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextPercent,
  formatBusyElapsed,
  formatTokens,
  formatWindow,
} from '../src/model/format.ts';
import {
  browserApprovalInput,
  browserEventAddress,
  browserOpened,
  dialogSource,
  hasToolInput,
  invalidBrowserAddressError,
  isSessionBrowser,
  shownDialog,
} from '../src/model/browser.ts';

// tests/desktop-format.test.ts in the root suite holds these equal to the terminal's.
test('invalid addresses stay distinct from network failures after native IPC rejection', () => {
  assert.equal(
    invalidBrowserAddressError(new Error('invalid browser address')),
    true,
  );
  assert.equal(
    invalidBrowserAddressError(
      new Error(
        "Error invoking remote method 'circle:browser-navigate': Error: invalid browser address",
      ),
    ),
    true,
  );
  for (const error of [
    new Error(
      "Error invoking remote method 'circle:browser-navigate': Error: net::ERR_CONNECTION_REFUSED",
    ),
    new Error(
      "Error invoking remote method 'circle:browser-tabs': Error: invalid browser address",
    ),
    new Error('invalid browser address: network unreachable'),
    { message: 'invalid browser address' },
    'invalid browser address',
    undefined,
  ])
    assert.equal(invalidBrowserAddressError(error), false);
});

test('the footer and busy word write numbers as the terminal does', () => {
  assert.deepEqual([0, 840, 1000, 12_345, 7_824_000].map(formatTokens), [
    '0',
    '840',
    '1.0k',
    '12.3k',
    '7.8M',
  ]);
  assert.equal(formatWindow(1_000_000), '1.0M');
  assert.equal(formatWindow(128_000), '128.0k');
  assert.deepEqual([12.44, 185, 3725].map(formatBusyElapsed), [
    '12.4s',
    '3m 5s',
    '1h 2m',
  ]);
  assert.equal(contextPercent(12_500, 1_000_000), 1.25);
  assert.equal(contextPercent(null, 1_000_000), null);
  assert.equal(contextPercent(10, null), null);
  assert.equal(contextPercent(5_000_000, 1000), 999);
});

test('a dialog shows over the tab that waits on it and names where it came from', () => {
  const dialog = (id: string, tab: string, origin: string) => ({
    id,
    tab,
    type: 'confirm' as const,
    message: 'Delete?',
    defaultPrompt: '',
    origin,
  });
  const state = {
    sessionId: 'browser:conversation1',
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    tab: 't2',
    dialogs: [
      dialog('d1', 't1', 'https://other.test'),
      dialog('d2', 't2', 'https://172.16.6.215:8888'),
    ],
  };
  assert.equal(shownDialog(state)?.id, 'd2');
  assert.equal(shownDialog({ ...state, tab: 't3' }), undefined);
  // A tab waiting on a dialog counts as opened even before its address is known
  assert.equal(browserOpened(state), true);
  assert.equal(dialogSource(state.dialogs[1]!), '172.16.6.215:8888');
  assert.equal(dialogSource(dialog('d3', 't1', '')), '');
  assert.equal(
    browserOpened({
      ...state,
      dialogs: [],
      warning: { host: 'nas.lan', error: 'net::ERR_CERT_AUTHORITY_INVALID' },
    }),
    true,
  );
});

test('browser events stay with their conversation', () => {
  const state = {
    sessionId: 'browser:conversation1',
    url: 'https://localhost/',
    title: 'local test',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    operating: true,
  };
  assert.equal(isSessionBrowser(state, 'conversation1'), true);
  assert.equal(isSessionBrowser(state, 'conversation2'), false);
  assert.equal(isSessionBrowser(state, 'browser:conversation1'), false);
  assert.equal(browserOpened(state), true);
  assert.equal(browserOpened({ ...state, url: '' }), false);
  assert.equal(browserOpened({ ...state, url: 'about:blank' }), false);
  assert.equal(browserOpened(null), false);
  assert.equal(
    browserOpened({
      ...state,
      url: '',
      failure: { url: 'http://localhost/', error: 'ERR_CONNECTION_REFUSED' },
    }),
    true,
  );
});

test('tool arguments omit empty containers and preserve browser approval values', () => {
  assert.equal(hasToolInput({}), false);
  assert.equal(hasToolInput([]), false);
  assert.equal(hasToolInput(undefined), false);
  assert.equal(hasToolInput({ text: '' }), true);
  assert.deepEqual(
    browserApprovalInput({
      url: 'https://localhost/login',
      ref: 'e3',
      element: 'username',
      text: 'admin\nsecond line',
      submit: false,
    }),
    [
      { key: 'url', value: 'https://localhost/login' },
      { key: 'ref', value: 'e3' },
      { key: 'element', value: 'username' },
      { key: 'text', value: 'admin\nsecond line' },
      { key: 'submit', value: 'false' },
    ],
  );
  assert.deepEqual(browserApprovalInput({}), []);
});

test('late blank browser events preserve the address being entered and back can clear it', () => {
  const state = {
    sessionId: 'browser:conversation1',
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const typedAddress = 'https://localhost/login';
  assert.equal(
    browserEventAddress(state, true, true) ?? typedAddress,
    typedAddress,
  );
  assert.equal(
    browserEventAddress(state, false, false) ?? typedAddress,
    typedAddress,
  );
  assert.equal(
    browserEventAddress({ ...state, url: '' }, false, false) ?? typedAddress,
    typedAddress,
  );
  assert.equal(
    browserEventAddress(
      { ...state, url: 'https://localhost/new' },
      true,
      true,
    ) ?? typedAddress,
    typedAddress,
  );
  assert.equal(
    browserEventAddress({ ...state, url: typedAddress }, false, false),
    typedAddress,
  );
  assert.equal(browserEventAddress(state, false, true), '');
});
