// The capture an after_tool hook asks for (#502): the page as a PNG, which leaves the model's screenshot the one
// coordinate clicks go by, and which never starts a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { join } from 'node:path';
import { ChromeBrowser } from '../src/browser/chrome.js';
import type { BrowserAction } from '../src/browser/protocol.js';
import { cleanup, cleanupServer, scratch as made } from './helpers.js';
import { executable, skip, listen } from './browser-chrome-helpers.js';

test(
  "a hook's capture is the page as a PNG, and coordinate clicks still go by the model's screenshot",
  { skip },
  async (t) => {
    const temp = made(t, 'circle-capture-');
    const hits: string[] = [];
    const site = createHttp((req, res) => {
      if (req.url?.startsWith('/hit')) {
        hits.push(req.url);
        res.end('yes');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>capture</title><style>span{display:inline-block;width:80px;height:30px}</style><span id="target">...</span><script>document.querySelector("#target").addEventListener("click",()=>fetch("/hit"));</script>',
      );
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
      mode: () => 'manual',
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    const act = (action: BrowserAction, args: Record<string, unknown> = {}) =>
      chrome.request('c', action, args, signal);
    await act('navigate', { url });
    const internal = chrome as any;
    const point = await internal.evaluate(
      internal.conversations
        .get('c')
        .tabs.get(internal.conversations.get('c').active),
      '(()=>{const r=document.querySelector("#target").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
      signal,
    );
    const shot = await act('screenshot');
    const captured = await act('capture');
    const png = Buffer.from(captured.image ?? '', 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(captured.screenshot, undefined);
    // Not stale: the capture is not a screenshot the model took
    const asked = await act('click_at', {
      ...point,
      screenshotId: shot.screenshot!.id,
    });
    assert.equal(asked.approval?.kind, 'coordinate');
    await act('click_at', {
      ...point,
      screenshotId: shot.screenshot!.id,
      approval: { token: asked.approval!.token, scope: 'once' },
    });
    assert.deepEqual(hits, ['/hit']);
  },
);

test('with no page open there is nothing to capture, and no browser is started for it', async (t) => {
  const temp = made(t, 'circle-capture-none-');
  // An executable that is not there: starting a browser would fail
  const chrome = new ChromeBrowser({
    executable: join(temp, 'no-browser-here'),
    headless: true,
    downloads: join(temp, 'downloads'),
  });
  cleanup(t, () => chrome.close());
  assert.deepEqual(
    await chrome.request('c', 'capture', {}, new AbortController().signal),
    { text: 'no page to capture' },
  );
  // Asking keeps no record for a session that never used the browser
  assert.equal((chrome as any).conversations.has('c'), false);
});

test(
  "a page another conversation's tab hides gives no capture at once, and is not brought to the front for it",
  { skip },
  async (t) => {
    const temp = made(t, 'circle-capture-hidden-');
    const site = createHttp((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>shared</title><p>shared browser</p>');
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
      mode: () => 'manual',
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    await chrome.request('a', 'navigate', { url }, signal);
    await chrome.request('b', 'navigate', { url }, signal);
    const internal = chrome as any;
    const shown = (id: string) =>
      internal.evaluate(
        internal.conversations
          .get(id)
          .tabs.get(internal.conversations.get(id).active),
        'document.visibilityState',
        signal,
      );
    assert.equal(await shown('a'), 'hidden');
    const started = Date.now();
    assert.deepEqual(await chrome.request('a', 'capture', {}, signal), {
      text: 'no page to capture',
    });
    assert.ok(
      Date.now() - started < 5000,
      'no wait for a frame that never comes',
    );
    assert.equal(await shown('a'), 'hidden');
    assert.equal(await shown('b'), 'visible');
    const front = await chrome.request('b', 'capture', {}, signal);
    assert.equal(
      Buffer.from(front.image ?? '', 'base64')
        .subarray(0, 8)
        .toString('hex'),
      '89504e470d0a1a0a',
    );
  },
);
