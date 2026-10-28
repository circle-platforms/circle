import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { join } from 'node:path';
import { ChromeBrowser } from '../src/browser/chrome.js';
import type { BrowserAction } from '../src/browser/protocol.js';
import { cleanup, cleanupServer, scratch as made } from './helpers.js';
import { executable, skip, listen } from './browser-chrome-helpers.js';

test(
  'coordinate clicks reach non-semantic controls, confirm their actual target once, and reject stale screenshots',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-coordinate-click-');
    const hits: string[] = [];
    const site = createHttp((req, res) => {
      if (req.url?.startsWith('/hit')) {
        hits.push(req.url);
        res.end('yes');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>coordinates</title><style>body{height:2400px}span{display:inline-block;width:80px;height:30px}</style><table><tr><td>members</td><td><span id="missing">...</span></td></tr></table><button id="delete">Delete configuration</button><button id="open">open popup</button><script>document.querySelector("#missing").addEventListener("click",()=>fetch("/hit-unknown"));document.querySelector("#delete").addEventListener("click",()=>fetch("/hit-delete"));document.querySelector("#open").addEventListener("click",()=>window.open("/popup"));</script>',
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
    const page = async <T>(expression: string): Promise<T> => {
      const internal = chrome as any;
      return internal.evaluate(
        internal.conversations
          .get('c')
          .tabs.get(internal.conversations.get('c').active),
        expression,
        signal,
      );
    };
    const shown = await act('navigate', { url });
    assert.match(shown.text, /\| members \| \.\.\. \|/);
    assert.doesNotMatch(shown.text, /\[e\d+\].*"\.\.\."/);
    const point = await page<{ x: number; y: number }>(
      '(()=>{const r=document.querySelector("#missing").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
    );
    const shot = await act('screenshot');
    assert.ok(shot.screenshot?.id);
    assert.match(shot.text, /CSS pixels/);
    await assert.rejects(
      act('click_at', { x: -1, y: point.y, screenshotId: shot.screenshot!.id }),
      /inside the screenshot viewport/,
    );
    const args = { ...point, screenshotId: shot.screenshot!.id };
    const asked = await act('click_at', args);
    assert.equal(asked.approval?.kind, 'coordinate');
    assert.deepEqual(hits, []);
    assert.equal((asked.approval as any).element, '...');
    const clicked = await act('click_at', {
      ...args,
      approval: { token: asked.approval!.token, scope: 'once' },
    });
    assert.match(clicked.text, /Clicked at.*span "\.\.\."/);
    assert.deepEqual(hits, ['/hit-unknown']);
    await assert.rejects(act('click_at', args), /screenshot is stale/);
    const deletion = await page<{ x: number; y: number }>(
      '(()=>{const r=document.querySelector("#delete").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
    );
    const deleteShot = await act('screenshot');
    const deleteAsk = await act('click_at', {
      ...deletion,
      screenshotId: deleteShot.screenshot!.id,
    });
    assert.equal(deleteAsk.approval?.kind, 'coordinate');
    assert.equal((deleteAsk.approval as any).destructive, true);
    assert.deepEqual(hits, ['/hit-unknown']);
    const scrolled = await act('screenshot');
    await page('window.scrollTo(0,100)');
    await assert.rejects(
      act('click_at', { ...point, screenshotId: scrolled.screenshot!.id }),
      /screenshot is stale/,
    );
    await page('window.scrollTo(0,0)');
    const changed = await act('screenshot');
    await page('document.querySelector("#missing").textContent="changed"');
    await assert.rejects(
      act('click_at', { ...point, screenshotId: changed.screenshot!.id }),
      /screenshot is stale/,
    );
    const switched = await act('screenshot');
    await act('tabs', { action: 'new' });
    await act('tabs', { action: 'select', tab: 't1' });
    await assert.rejects(
      act('click_at', { ...point, screenshotId: switched.screenshot!.id }),
      /screenshot is stale/,
    );
    const resized = await act('screenshot');
    const internal = chrome as any;
    const activeTab = internal.conversations.get('c').tabs.get('t1');
    await internal.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
      activeTab.session,
    );
    await assert.rejects(
      act('click_at', { ...point, screenshotId: resized.screenshot!.id }),
      /screenshot is stale/,
    );
    const resizedShot = await act('screenshot');
    assert.equal(resizedShot.screenshot!.width, 800);
    assert.equal(resizedShot.screenshot!.height, 600);
    await internal.send(
      'Emulation.clearDeviceMetricsOverride',
      {},
      activeTab.session,
    );
    const navigated = await act('screenshot');
    await act('navigate', { url: url + 'new' });
    await assert.rejects(
      act('click_at', { ...point, screenshotId: navigated.screenshot!.id }),
      /screenshot is stale/,
    );
  },
);

test(
  'coordinate clicks recheck a hover-changed destructive target before mouse press',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-coordinate-hover-');
    const hits: string[] = [];
    const site = createHttp((req, res) => {
      if (req.url?.startsWith('/hit')) {
        hits.push(req.url);
        res.end('yes');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>hover fixture</title><button style="margin:100px;width:220px;height:60px">Show details</button><script>const b=document.querySelector("button");b.addEventListener("mouseenter",()=>{b.textContent="Delete configuration";b.dataset.delete="yes"});b.addEventListener("click",()=>fetch("/hit-"+b.dataset.delete));</script>',
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
    const shot = await act('screenshot');
    const point = { x: 218, y: 138 };
    await assert.rejects(
      act('click_at', { ...point, screenshotId: shot.screenshot!.id }),
      /screenshot.*(?:stale|changed)/,
    );
    assert.deepEqual(
      hits,
      [],
      'hover must not be followed by a mouse press on the changed target',
    );
    const next = await act('screenshot');
    const args = { ...point, screenshotId: next.screenshot!.id };
    const asked = await act('click_at', args);
    assert.equal(asked.approval?.kind, 'coordinate');
    assert.equal((asked.approval as any).destructive, true);
    assert.equal((asked.approval as any).element, 'Delete configuration');
    assert.deepEqual(hits, []);
    await act('click_at', {
      ...args,
      approval: { token: asked.approval!.token, scope: 'once' },
    });
    assert.deepEqual(hits, ['/hit-yes']);
  },
);

test(
  'scrolling a nested document container invalidates coordinate captures',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-coordinate-nested-scroll-');
    const hits: string[] = [];
    const site = createHttp((req, res) => {
      if (req.url?.startsWith('/hit')) {
        hits.push(req.url);
        res.end('yes');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>nested scroll</title><style>#s{width:300px;height:100px;overflow:auto;margin:180px}button{display:block;height:100px;width:280px}</style><div id=s><button id=a>Open first</button><button id=b>Open second</button><button id=c>Other</button></div><script>for(const b of document.querySelectorAll("button"))b.onclick=()=>fetch("/hit-"+b.id);</script>',
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
    await chrome.request('c', 'navigate', { url }, signal);
    const shot = await chrome.request('c', 'screenshot', {}, signal);
    const internal = chrome as any;
    const tab = internal.conversations.get('c').tabs.get('t1');
    await internal.evaluate(
      tab,
      'document.querySelector("#s").scrollTop=100',
      signal,
    );
    await assert.rejects(
      chrome.request(
        'c',
        'click_at',
        { x: 328, y: 230, screenshotId: shot.screenshot!.id },
        signal,
      ),
      /screenshot is stale/,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(
      chrome.request(
        'c',
        'click_at',
        { x: 328, y: 230, screenshotId: shot.screenshot!.id },
        signal,
      ),
      /screenshot is stale/,
    );
    assert.deepEqual(hits, []);
    const next = await chrome.request('c', 'screenshot', {}, signal);
    await chrome.request(
      'c',
      'click_at',
      { x: 328, y: 230, screenshotId: next.screenshot!.id },
      signal,
    );
    assert.deepEqual(hits, ['/hit-b']);
  },
);
