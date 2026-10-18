import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { CdpPipe } from '../src/browser/cdp.js';
import { ChromeBrowser, findBrowser } from '../src/browser/chrome.js';
import { browserTools, runtimeBrowserOptions } from '../src/browser/tools.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { cleanup, cleanupServer, scratch } from './helpers.js';
import {
  assertNothingLeft,
  fakeBrowser,
  type FakeBrowser,
} from './browser-fake-cdp.js';

// Every protocol command Circle sends ends, whatever the page does: these drive a stand-in
// browser that never answers a given command, closes its tab, crashes its page or loses its
// pipe mid-command, and check what the model is told and that nothing is left running.

const never = new AbortController().signal;

/** The model's turn over the real browser tools: each call's result as the next request saw it. */
async function turn(
  t: test.TestContext,
  fake: FakeBrowser,
  calls: { id: string; name: string; args: Record<string, unknown> }[],
): Promise<Record<string, string>> {
  const root = scratch(t, 'circle-cdp-bounds-');
  const model = new ScriptedModel([
    {
      message: { id: '1', role: 'assistant', content: '', tool_calls: calls },
    },
    { message: { id: '2', role: 'assistant', content: 'done' } },
  ]);
  let runtime!: AgentRuntime;
  runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    headless: true,
    extraTools: browserTools(
      fake.browser,
      runtimeBrowserOptions(() => runtime),
    ),
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('look at the page');
  assert.equal(model.requests.length, 2, 'the turn went on to the model');
  return Object.fromEntries(
    model.requests[1]!.messages.filter(
      (message) => message.role === 'tool',
    ).map((message) => [message.tool_call_id, String(message.content)]),
  );
}

test('a protocol command ends at its deadline, its signal, its session failing or its pipe closing, and names the command and target', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: { id: number; method: string }[] = [];
  input.on('data', (chunk: Buffer) => {
    for (const part of chunk.toString().split('\0').filter(Boolean))
      written.push(JSON.parse(part));
  });
  const pipe = new CdpPipe(input, output, 40);
  await assert.rejects(
    pipe.send('Page.enable', {}, 'S1', { target: 'tab t1' }),
    { message: 'the browser did not answer Page.enable for tab t1 in 0.04 s' },
  );
  // A late answer to a command given up on is dropped, and nothing waits any more
  output.write(JSON.stringify({ id: written[0]!.id, result: {} }) + '\0');
  assert.deepEqual(pipe.pending, []);
  await assert.rejects(
    pipe.send('Browser.cancelDownload', {}, undefined, { timeout: 1500 }),
    /did not answer Browser\.cancelDownload for the browser in 1\.5 s/,
  );
  const stop = new AbortController();
  const stopped = pipe.send('Runtime.evaluate', {}, 'S1', {
    timeout: Infinity,
    signal: stop.signal,
  });
  stop.abort(Error('the turn was stopped'));
  await assert.rejects(stopped, { message: 'the turn was stopped' });
  // A session that is failed (its tab closed or crashed) ends only its own commands
  const other = pipe.send('Page.reload', {}, 'S2', {
    timeout: Infinity,
    target: 'tab t2',
  });
  const own = pipe.send('Page.reload', {}, 'S1', {
    timeout: Infinity,
    target: 'tab t1',
  });
  pipe.fail('S1', 'crashed');
  await assert.rejects(own, {
    message: 'tab t1 crashed before the browser answered Page.reload',
  });
  assert.deepEqual(pipe.pending, [{ method: 'Page.reload', target: 'tab t2' }]);
  // The pipe ending ends the rest
  output.destroy();
  await assert.rejects(other, { message: 'the browser was closed' });
  assert.deepEqual(pipe.pending, []);
  await assert.rejects(pipe.send('Page.enable'), {
    message: 'the browser was closed',
  });
});

test('a first tab whose page never answers is let go and the action goes on in a tab of its own', async (t) => {
  // The initial tab's renderer answers nothing it is asked, as in PR #150's CI run
  const fake = fakeBrowser(
    t,
    (request) =>
      request.sessionId === 'S-T1' &&
      ['Page.enable', 'Network.enable', 'Runtime.enable'].includes(
        request.method,
      ),
    { commandTimeout: 300 },
  );
  const results = await turn(t, fake, [
    { id: 'look', name: 'browser_snapshot', args: {} },
  ]);
  assert.match(
    results.look!,
    /- tab t1 was not taken on: the browser did not answer (Page|Network|Runtime)\.enable for tab t1 in 0\.3 s/,
  );
  assert.match(results.look!, /### Page\ntab t2 · "Fake page"/);
  assert.match(results.look!, /- heading "Fake page"/);
  // Circle let go of the unanswering tab, and opened its own
  assert.ok(
    fake.requests.some(
      (request) =>
        request.method === 'Target.detachFromTarget' &&
        request.params.sessionId === 'S-T1',
    ),
  );
  await fake.browser.close();
  assertNothingLeft(fake);
});

test('a browser whose pages never answer gives the model an error naming the command, and the next call is not held', async (t) => {
  const fake = fakeBrowser(t, (request) => request.method === 'Page.enable', {
    commandTimeout: 200,
  });
  const started = Date.now();
  const results = await turn(t, fake, [
    { id: 'first', name: 'browser_snapshot', args: {} },
    { id: 'second', name: 'browser_snapshot', args: {} },
  ]);
  for (const id of ['first', 'second'])
    assert.match(
      results[id]!,
      /the browser did not answer Page\.enable for tab t\d+ in 0\.2 s/,
    );
  // Each call waited on bounded commands only: a stuck page cannot hold the turn
  assert.ok(Date.now() - started < 10_000, 'the turn ended');
  await fake.browser.close();
  assertNothingLeft(fake);
});

test('a download not kept whose cancel the browser never answers is told as unconfirmed, and its file goes when it ends', async (t) => {
  let fake!: FakeBrowser;
  fake = fakeBrowser(
    t,
    (request) => {
      if (request.method === 'Browser.cancelDownload') return true;
      if (request.method !== 'Page.navigate') return;
      fake.emit('Browser.downloadWillBegin', {
        frameId: 'T1',
        guid: 'G1',
        url: request.params.url,
        suggestedFilename: 'report.bin',
      });
      fake.answer(request, { frameId: 'T1', isDownload: true });
      return true;
    },
    { commandTimeout: 300 },
  );
  const browser = fake.browser;
  const url = 'https://files.example/report.bin';
  const asked = await browser.request('c', 'navigate', { url }, never);
  assert.equal(asked.approval?.kind, 'download');
  // The browser has written part of it to Circle's staging folder
  const staging = (browser as unknown as { staging: string }).staging;
  mkdirSync(staging, { recursive: true });
  const partial = join(staging, 'G1');
  writeFileSync(partial, 'part');
  const discarded = await browser.request(
    'c',
    'navigate',
    {
      url,
      approval: {
        token: (asked.approval as { token: string }).token,
        scope: 'reject',
      },
    },
    never,
  );
  assert.equal(
    discarded.text,
    '### Download\nThe user did not keep the download; it was discarded.\n- download dl1 was not kept; the browser did not confirm it stopped (the browser did not answer Browser.cancelDownload for the browser in 0.3 s), so what it writes is deleted when it ends',
  );
  assert.deepEqual(fake.pending(), []);
  // It went on writing, then ended: what it wrote is deleted, never kept
  writeFileSync(partial, 'part and more');
  fake.emit('Browser.downloadProgress', {
    guid: 'G1',
    state: 'completed',
    receivedBytes: 13,
  });
  const after = await browser.request('c', 'snapshot', {}, never);
  assert.equal(existsSync(partial), false);
  assert.equal(
    existsSync(join(staging, '..', 'downloads', 'report.bin')),
    false,
  );
  assert.doesNotMatch(after.text, /finished/);
  await browser.close();
  assertNothingLeft(fake);
});

test('a failed navigation whose stopLoading is never answered still tells the model the page did not load', async (t) => {
  let fake!: FakeBrowser;
  fake = fakeBrowser(
    t,
    (request) => {
      if (request.method === 'Page.stopLoading') return true;
      if (request.method !== 'Page.navigate') return;
      // The browser refuses the navigation outright
      fake.refuse(request, 'Navigation failed');
      return true;
    },
    { commandTimeout: 300 },
  );
  const result = await fake.browser.request(
    'c',
    'navigate',
    { url: 'https://slow.example/' },
    never,
  );
  assert.match(
    result.text,
    /### Result\nThe page could not be loaded: ERR_TIMED_OUT\./,
  );
  assert.ok(
    fake.requests.some((request) => request.method === 'Page.stopLoading'),
  );
  assert.deepEqual(fake.pending(), []);
  await fake.browser.close();
  assertNothingLeft(fake);
});

/** A stand-in whose page never answers a reload: what ends the wait is the test's to do. */
function heldReload(t: test.TestContext) {
  const fake = fakeBrowser(t, (request) => request.method === 'Page.reload', {
    // Far past the test: only the event under test can end the wait
    commandTimeout: 60_000,
  });
  return fake;
}

test('a tab that closes while a command waits ends the action at once, naming the command', async (t) => {
  const fake = heldReload(t);
  await fake.browser.request('c', 'snapshot', {}, never);
  const started = Date.now();
  const reload = fake.browser.request(
    'c',
    'navigate',
    { url: 'reload' },
    never,
  );
  await fake.sent('Page.reload', 'S-T1');
  fake.emit('Target.detachedFromTarget', { sessionId: 'S-T1', targetId: 'T1' });
  fake.emit('Target.targetDestroyed', { targetId: 'T1' });
  await assert.rejects(reload, {
    message: 'tab t1 closed before the browser answered Page.reload',
  });
  assert.ok(Date.now() - started < 5000, 'the detach ended the wait');
  assert.deepEqual(fake.pending(), []);
  // The conversation goes on: its next action opens a tab of its own
  const next = await fake.browser.request('c', 'snapshot', {}, never);
  assert.match(next.text, /- tab t1 was closed/);
  assert.match(next.text, /### Page\ntab t2 /);
  await fake.browser.close();
  assertNothingLeft(fake);
});

test('a page that crashes while a command waits ends the action, and the tab says so until it loads again', async (t) => {
  const fake = heldReload(t);
  await fake.browser.request('c', 'snapshot', {}, never);
  const reload = fake.browser.request(
    'c',
    'navigate',
    { url: 'reload' },
    never,
  );
  await fake.sent('Page.reload', 'S-T1');
  fake.emit('Target.targetCrashed', {
    targetId: 'T1',
    status: 'crashed',
    errorCode: 11,
  });
  await assert.rejects(reload, {
    message: 'tab t1 crashed before the browser answered Page.reload',
  });
  const evaluations = () =>
    fake.requests.filter((request) => request.method === 'Runtime.evaluate')
      .length;
  const before = evaluations();
  // Nothing is asked of a crashed page: the model is told at once what to do
  await assert.rejects(fake.browser.request('c', 'snapshot', {}, never), {
    message: 'the page in tab t1 crashed; load it again with browser_navigate',
  });
  assert.equal(evaluations(), before);
  const loaded = await fake.browser.request(
    'c',
    'navigate',
    { url: 'https://again.example/' },
    never,
  );
  assert.match(loaded.text, /### Result\nLoaded\./);
  assert.match(loaded.text, /- heading "Fake page"/);
  await fake.browser.close();
  assertNothingLeft(fake);
});

test('a browser whose pipe ends while a command waits ends the action and leaves no process', async (t) => {
  const fake = heldReload(t);
  await fake.browser.request('c', 'snapshot', {}, never);
  const reload = fake.browser.request(
    'c',
    'navigate',
    { url: 'reload' },
    never,
  );
  await fake.sent('Page.reload', 'S-T1');
  fake.crash();
  await assert.rejects(reload, { message: 'the browser was closed' });
  await fake.browser.close();
  assertNothingLeft(fake);
});

test(
  "a real page's crash ends the command waiting on it, which Chrome never answers, and a load recovers the tab",
  { skip: findBrowser() ? false : 'no Chrome, Edge or Chromium is installed' },
  async (t) => {
    const site = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Back</title><h1>back again</h1>');
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    cleanupServer(t, site);
    const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
    const chrome = new ChromeBrowser({
      executable: findBrowser()!,
      headless: true,
      downloads: join(scratch(t, 'circle-cdp-crash-'), 'downloads'),
      // Far past the test: only the crash can end the wait
      commandTimeout: 60_000,
    });
    cleanup(t, () => chrome.close());
    const internal = chrome as unknown as {
      child: ChildProcess;
      cdp: CdpPipe;
      conversations: Map<string, { tabs: Map<string, { session: string }> }>;
      send: (
        method: string,
        params: Record<string, unknown>,
        session?: string,
      ) => Promise<unknown>;
    };
    await chrome.request('c', 'navigate', { url }, never);
    const tab = internal.conversations.get('c')!.tabs.get('t1')!;
    const started = Date.now();
    const waiting = internal.send(
      'Runtime.evaluate',
      { expression: 'new Promise(() => {})', awaitPromise: true },
      tab.session,
    );
    void internal.send('Page.crash', {}, tab.session).catch(() => {});
    await assert.rejects(waiting, {
      message: 'tab t1 crashed before the browser answered Runtime.evaluate',
    });
    assert.ok(Date.now() - started < 30_000, 'the crash ended the wait');
    await assert.rejects(chrome.request('c', 'snapshot', {}, never), {
      message:
        'the page in tab t1 crashed; load it again with browser_navigate',
    });
    const loaded = await chrome.request('c', 'navigate', { url }, never);
    assert.match(
      loaded.text,
      /- the page in tab t1 crashed; load it again with browser_navigate/,
    );
    assert.match(loaded.text, /heading "back again"/);
    const { child, cdp } = internal;
    await chrome.close();
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(cdp.closed, true);
    assert.deepEqual(cdp.pending, []);
  },
);
