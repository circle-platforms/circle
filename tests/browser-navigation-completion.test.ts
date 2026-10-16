import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { join } from 'node:path';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { scratch } from './helpers.js';

/** Protocol and document boundaries are controlled; no browser or network is needed. */
function navigation(t: TestContext, error = '') {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const root = scratch(t);
  const browser = new ChromeBrowser({
    executable: process.execPath,
    trustFile: join(root, 'certificates.json'),
    headless: true,
  });
  const internal = browser as any;
  const pipe = { closed: false };
  internal.cdp = pipe;
  const conversation = internal.conversation('fixture');
  const url = 'https://fixture.invalid/';
  const tab = {
    id: 't1',
    targetId: 'main-frame',
    session: 'fixture-session',
    conversation,
    url: 'about:blank',
    title: 'about:blank',
    frameUrl: 'about:blank',
    loaderId: 'initial-document',
    loading: false,
    network: new Set<string>(),
    lastNetwork: 0,
    dialogs: [],
    answered: 0,
    wake: new Set<() => void>(),
    closed: false,
    security: {
      certificateSecurityState: {
        // No usable fingerprint: this warning cannot silently trust a certificate.
        certificate: ['fixture'],
        certificateNetworkError: error,
      },
    },
  };
  conversation.active = tab.id;
  conversation.tabs.set(tab.id, tab);
  internal.byTarget.set(tab.targetId, tab);
  internal.bySession.set(tab.session, tab);
  const event = (method: string, params: Record<string, unknown>) =>
    internal.event(pipe, { method, params, sessionId: tab.session });
  let ready = false;
  let navigations = 0;
  let beforeReply = () => {};
  const snapshots: string[] = [];
  internal.evaluate = async (_tab: unknown, expression: string) =>
    expression === 'document.visibilityState' ? 'visible' : 'fixture';
  internal.js = async (_tab: unknown, action: string) => {
    assert.equal(action, 'snapshot');
    snapshots.push(tab.frameUrl);
    return ready ? '[e1] button "Advanced"' : '';
  };
  internal.send = async (method: string) => {
    assert.equal(method, 'Page.navigate');
    navigations++;
    // Target metadata can already name the destination while the old document
    // is still displayed. It is not a document-commit notification.
    event('Target.targetInfoChanged', {
      targetInfo: { targetId: tab.targetId, url, title: 'fixture' },
    });
    event('Network.requestWillBeSent', {
      requestId: 'navigation-request',
      frameId: tab.targetId,
      type: 'Document',
      request: { url },
    });
    event(error ? 'Network.loadingFailed' : 'Network.loadingFinished', {
      requestId: 'navigation-request',
      errorText: error,
    });
    beforeReply();
    return {
      frameId: tab.targetId,
      loaderId: 'new-document',
      errorText: error,
    };
  };
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const idle = internal.idle.bind(browser);
  t.mock.method(internal, 'idle', (...args: unknown[]) => {
    const pending = idle(...args);
    entered();
    return pending;
  });
  const controller = new AbortController();
  const request = browser.request(
    'fixture',
    'navigate',
    { url },
    controller.signal,
  );
  let settled = false;
  void request.then(
    () => (settled = true),
    () => (settled = true),
  );
  t.after(async () => {
    controller.abort(Error('navigation fixture ended'));
    await request.catch(() => {});
  });
  return {
    request,
    waiting,
    event,
    tab,
    controller,
    snapshots,
    settled: () => settled,
    navigations: () => navigations,
    beforeReply: (action: () => void) => (beforeReply = action),
    commit: () => {
      ready = true;
      event('Page.frameStartedLoading', { frameId: tab.targetId });
      event('Page.frameNavigated', {
        frame: {
          id: tab.targetId,
          loaderId: 'new-document',
          url: error ? 'chrome-error://chromewebdata/' : url,
          ...(error ? { unreachableUrl: url } : {}),
        },
      });
      event('Page.frameStoppedLoading', { frameId: tab.targetId });
    },
  };
}

for (const error of [
  '',
  'net::ERR_CERT_AUTHORITY_INVALID',
  'net::ERR_CONNECTION_REFUSED',
])
  test(`navigation waits for its document after a quiet initial page (${error || 'success'})`, async (t) => {
    const fixture = navigation(t, error);
    await fixture.waiting;
    // The real idle timer is already registered. Advance only the clock so the
    // old document is unambiguously network-idle before that timer fires.
    t.mock.timers.setTime(500);
    await delay(100);
    assert.equal(fixture.tab.frameUrl, 'about:blank');
    assert.equal(
      fixture.settled(),
      false,
      'the old blank document is not the navigation result',
    );
    assert.deepEqual(fixture.snapshots, []);

    // A late load notification for the initial document cannot finish this one.
    fixture.event('Page.frameNavigated', {
      frame: {
        id: fixture.tab.targetId,
        loaderId: 'initial-document',
        url: 'about:blank',
      },
    });
    fixture.event('Page.frameStoppedLoading', {
      frameId: fixture.tab.targetId,
    });
    await delay(60);
    assert.equal(fixture.settled(), false);

    fixture.commit();
    const result = await fixture.request;
    assert.equal(fixture.navigations(), 1, 'the navigation is not retried');
    assert.equal((fixture.tab as any).navigation, undefined);
    assert.doesNotMatch(result.text, /about:blank/);
    if (error.includes('ERR_CERT')) {
      assert.match(result.text, /certificate is not trusted/);
      assert.match(result.text, /This is the browser's certificate warning/);
      assert.match(result.text, /\[e1\] button "Advanced"/);
      assert.doesNotMatch(result.text, /Loaded\./);
    } else if (error) {
      assert.match(result.text, /could not be loaded: ERR_CONNECTION_REFUSED/);
      assert.doesNotMatch(result.text, /Loaded\./);
    } else {
      assert.match(result.text, /Loaded\./);
      assert.deepEqual(fixture.snapshots, ['https://fixture.invalid/']);
    }
  });

test('a navigation document that never commits fails rather than reporting the old page as Loaded', async (t) => {
  const fixture = navigation(t, 'net::ERR_CERT_AUTHORITY_INVALID');
  await fixture.waiting;
  t.mock.timers.setTime(15001);
  await assert.rejects(fixture.request, /navigation document did not commit/);
  assert.deepEqual(fixture.snapshots, []);
  assert.equal(fixture.navigations(), 1);
});

test('closing the tab before its navigation commits cannot report Loaded', async (t) => {
  const fixture = navigation(t, 'net::ERR_CERT_AUTHORITY_INVALID');
  await fixture.waiting;
  fixture.tab.closed = true;
  await assert.rejects(
    fixture.request,
    /tab closed before its navigation document committed/,
  );
  assert.deepEqual(fixture.snapshots, []);
});

test('cancelling a pending navigation retains the cancellation reason', async (t) => {
  const fixture = navigation(t, 'net::ERR_CERT_AUTHORITY_INVALID');
  await fixture.waiting;
  const reason = Error('stop the pending navigation');
  fixture.controller.abort(reason);
  await assert.rejects(
    fixture.request,
    (error) =>
      error === reason || (error instanceof Error && error.cause === reason),
  );
  assert.deepEqual(fixture.snapshots, []);
});

test('a document committed before the navigation reply can immediately redirect to another document', async (t) => {
  const fixture = navigation(t);
  fixture.beforeReply(() => {
    fixture.commit();
    fixture.event('Page.frameStartedLoading', {
      frameId: fixture.tab.targetId,
    });
    fixture.event('Page.frameNavigated', {
      frame: {
        id: fixture.tab.targetId,
        loaderId: 'redirected-document',
        url: 'https://fixture.invalid/redirected',
      },
    });
    fixture.event('Target.targetInfoChanged', {
      targetInfo: {
        targetId: fixture.tab.targetId,
        url: 'https://fixture.invalid/redirected',
        title: 'redirected',
      },
    });
    fixture.event('Page.frameStoppedLoading', {
      frameId: fixture.tab.targetId,
    });
  });
  await fixture.waiting;
  t.mock.timers.setTime(15001);
  const result = await fixture.request;
  assert.match(result.text, /Loaded\./);
  assert.match(result.text, /https:\/\/fixture.invalid\/redirected/);
  assert.deepEqual(fixture.snapshots, ['https://fixture.invalid/redirected']);
  assert.equal((fixture.tab as any).navigation, undefined);
  assert.equal(fixture.navigations(), 1);
});
