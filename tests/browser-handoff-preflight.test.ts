import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { scratch } from './helpers.js';
import { ownedStartupBrowser } from './browser-startup-fixture.js';

function handoff(t: TestContext) {
  const fixture = ownedStartupBrowser(t, 'unused', false);
  const state = fixture.browser as any;
  const conversation = state.conversation('fixture');
  const tab = {
    id: 't1',
    targetId: 'fixture-target',
    session: 'fixture-session',
    conversation,
    url: 'https://fixture.invalid/',
    frameUrl: 'https://fixture.invalid/',
    dialogs: [],
    wake: new Set<() => void>(),
  };
  conversation.active = tab.id;
  conversation.tabs.set(tab.id, tab);
  const ready = t.mock.method(state, 'onScreen', async () => {});
  const launch = t.mock.method(state, 'launch', state.launch.bind(state));
  return {
    ...fixture,
    state,
    ready,
    launch,
    async close() {
      const launches = launch.mock.callCount();
      const child = launches ? fixture.child() : undefined;
      await fixture.browser.close();
      if (child) assert(child.exitCode !== null || child.signalCode !== null);
      t.diagnostic(
        JSON.stringify({
          launches,
          ownedPid: child?.pid ?? null,
          exitCode: child?.exitCode ?? null,
          signalCode: child?.signalCode ?? null,
          ownedExitObserved:
            !!child && (child.exitCode !== null || child.signalCode !== null),
        }),
      );
      return launches;
    },
  };
}

test('an unavailable handoff refuses before starting an owned browser', async (t) => {
  const fixture = handoff(t);
  const error = await fixture.browser
    .request(
      'fixture',
      'handoff',
      { reason: 'sign in' },
      new AbortController().signal,
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  const launches = await fixture.close();
  assert(error instanceof Error);
  assert.match(error.message, /there is no one to hand the browser to here/);
  assert.equal(launches, 0, 'a refused handoff must not acquire a browser');
  assert.equal(fixture.ready.mock.callCount(), 0);
});

test('a configured handoff retains its late handler and mode checks before handing over', async (t) => {
  const fixture = handoff(t);
  const reasons: string[] = [];
  const handler = async (reason: string) => {
    reasons.push(reason);
  };
  let mode = 'manual';
  fixture.state.options.handoff = handler;
  fixture.state.options.mode = () => mode;
  fixture.state.result = async (_conversation: unknown, text: string) => text;
  fixture.ready.mock.mockImplementationOnce(async () => {
    fixture.state.options.handoff = undefined;
  });
  const signal = new AbortController().signal;
  await assert.rejects(
    fixture.browser.request(
      'fixture',
      'handoff',
      { reason: 'sign in' },
      signal,
    ),
    /there is no one to hand the browser to here/,
  );
  fixture.state.options.handoff = handler;
  fixture.ready.mock.mockImplementationOnce(async () => {
    mode = 'plan';
  });
  await assert.rejects(
    fixture.browser.request(
      'fixture',
      'handoff',
      { reason: 'sign in' },
      signal,
    ),
    /plan mode does not hand the browser over/,
  );
  mode = 'manual';
  const result = await fixture.browser.request(
    'fixture',
    'handoff',
    { reason: 'sign in' },
    signal,
  );
  assert.equal(await fixture.close(), 1);
  assert.deepEqual(reasons, ['sign in']);
  assert.equal(result.text, 'The user handed the browser back.');
});

test('closed and already aborted requests keep priority over unavailable handoff', async (t) => {
  const root = scratch(t);
  const browser = () =>
    new ChromeBrowser({
      executable: process.execPath,
      trustFile: join(root, 'certificates.json'),
    });
  const controller = new AbortController();
  const reason = Error('fixture request already stopped');
  controller.abort(reason);
  const closed = browser();
  await closed.close();
  await assert.rejects(
    closed.request('fixture', 'handoff', {}, controller.signal),
    /the browser is closed/,
  );
  const aborted = browser();
  const launch = t.mock.method(aborted as any, 'launch', async () => {
    throw Error('an aborted request must not launch');
  });
  await assert.rejects(
    aborted.request('fixture', 'handoff', {}, controller.signal),
    (error) => error === reason,
  );
  await aborted.close();
  assert.equal(launch.mock.callCount(), 0);
});
