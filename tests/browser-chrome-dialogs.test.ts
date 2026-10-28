import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { join } from 'node:path';
import { ChromeBrowser } from '../src/browser/chrome.js';
import type { CdpPipe } from '../src/browser/cdp.js';
import type { BrowserAction } from '../src/browser/protocol.js';
import { cleanup, cleanupServer, scratch as made } from './helpers.js';
import {
  executable,
  skip,
  listen,
  browserFixture,
} from './browser-chrome-helpers.js';

test(
  "the terminal browser's downloads, dialogs and file choosers go by the site and the actor that made them",
  { skip },
  async (t) => {
    const temp = made(t, 'circle-chrome-provenance-');
    const file = (res: import('node:http').ServerResponse, name: string) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
      });
      res.end(name);
    };
    const page = (res: import('node:http').ServerResponse, body: string) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html>${body}`);
    };
    let otherBase = '';
    const site = createHttp((req, res) => {
      if (req.url === '/download') return file(res, 'mine.bin');
      if (req.url === '/late')
        return page(
          res,
          `<title>Late</title><button onclick="setTimeout(() => location = '/download', 1500)">Later</button>`,
        );
      if (req.url === '/blob')
        return page(
          res,
          `<title>Blob</title><button onclick="const a = document.createElement('a'); a.href = window.URL.createObjectURL(new Blob(['made here'])); a.download = 'made.txt'; document.body.append(a); a.click()">Make</button>`,
        );
      // The other site's file by navigation, then the page's own by a download link: a second
      // navigation would cancel the first while the other site has not answered yet (#134)
      if (req.url === '/two')
        return page(
          res,
          `<title>Two</title><button onclick="location = '${otherBase}/download'; setTimeout(() => { const a = document.createElement('a'); a.href = '/download'; a.download = ''; document.body.append(a); a.click() }, 400)">Both</button>`,
        );
      if (req.url === '/alert')
        return page(
          res,
          `<title>Files</title><button onclick="alert('saved')">Save</button><input type="file" aria-label="Attachment">`,
        );
      page(res, '<title>Home</title><p>home</p>');
    });
    const other = createHttp((req, res) => {
      if (req.url === '/download') {
        // A second navigation of the same main frame can cancel this first
        // response. Independent frames test two real downloads, even when the
        // first response arrives after the unchanged 400 ms second trigger.
        setTimeout(() => file(res, 'theirs.bin'), 1000);
        return;
      }
      page(
        res,
        `<title>Asks</title><script>setTimeout(() => confirm('Delete everything?'), 300)</script>`,
      );
    });
    const base = `http://127.0.0.1:${await listen(site)}`;
    otherBase = `http://127.0.0.1:${await listen(other)}`;
    cleanupServer(t, site);
    cleanupServer(t, other);
    const downloads = join(temp, 'downloads');
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads,
    });
    // One shared budget: existing 60s startup, the five provenance sections'
    // 15s idle + 5s page + 3s download waits, two 10s held-download waits, and
    // the unchanged fixed pauses below (1s + 2.5s + .8s + .5s + .5s).
    const budget = 60_000 + 5 * (15_000 + 5000 + 3000) + 2 * 10_000 + 5300;
    const fixture = browserFixture(chrome, budget);
    cleanup(t, () => fixture.close());
    const signal = AbortSignal.any([t.signal, fixture.signal]);
    let section = 'blob download';
    let firstAction = true;
    const actionBudget = 15_000 + 2 * 5000 + 3000;
    const act = (
      action: BrowserAction,
      args: Record<string, unknown> = {},
      bound = actionBudget,
    ) => {
      const limit = firstAction
        ? 60_000 + actionBudget
        : Math.min(actionBudget, bound);
      firstAction = false;
      return fixture.run(
        { phase: section, action },
        () => chrome.request('c', action, args, signal),
        limit,
      );
    };
    const pause = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', aborted);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', aborted);
          resolve();
        }, ms);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      });
    const ref = (text: string, pattern: RegExp) => {
      const match = text.match(pattern);
      assert(match, `no ${pattern} in:\n${text}`);
      return match[1]!;
    };
    const token = (result: { approval?: unknown }) =>
      (result.approval as { token: string }).token;
    // A download starts a moment after what started it, later on a busy machine: look again
    // until the browser holds one
    const held = async (result: Awaited<ReturnType<typeof act>>) => {
      const end = Date.now() + 10_000;
      while (!result.approval && Date.now() < end) {
        await pause(250);
        if (Date.now() >= end) break;
        result = await act('snapshot', {}, end - Date.now());
      }
      return result;
    };

    // ---- a blob is the download of the page that made it
    const blob = await act('navigate', { url: `${base}/blob` });
    const make = await act('click', {
      ref: ref(blob.text, /\[(e\d+)\] button "Make"/),
      element: 'make',
    });
    // The page makes the file after the click: asked with this result or the next
    await pause(1000);
    const made2 = make.approval ? make : await act('snapshot');
    assert.equal(made2.approval?.kind, 'download');
    assert.equal((made2.approval as { site: string }).site, base);
    const kept = await act('click', {
      ref: 'e1',
      approval: { token: token(made2), scope: 'once' },
    });
    assert.match(kept.text, /The download was kept\./);
    assert.equal(
      readFileSync(join(downloads, 'made.txt'), 'utf8'),
      'made here',
    );

    // ---- a download a page starts a moment after the model's click is still the model's
    section = 'late download';
    const late = await act('navigate', { url: `${base}/late` });
    const clicked = await act('click', {
      ref: ref(late.text, /\[(e\d+)\] button "Later"/),
      element: 'later',
    });
    assert.equal(clicked.approval, undefined);
    await pause(2500);
    const after = await act('snapshot');
    assert.equal(after.approval?.kind, 'download');
    assert.equal((after.approval as { site: string }).site, base);
    await act('snapshot', {
      approval: { token: token(after), scope: 'reject' },
    });
    assert.equal(existsSync(join(downloads, 'mine.bin')), false);

    // ---- files from two sites are asked about site by site
    section = 'two download sites';
    const two = await act('navigate', { url: `${base}/two` });
    const both = await act('click', {
      ref: ref(two.text, /\[(e\d+)\] button "Both"/),
      element: 'both',
    });
    // The second starts 400 ms after the first; either site's answer can come first
    const first = await held(both);
    assert.equal(first.approval?.kind, 'download');
    const firstSite = (first.approval as { site: string }).site;
    const second = await held(
      await act('snapshot', {
        approval: { token: token(first), scope: 'once' },
      }),
    );
    assert.equal(second.approval?.kind, 'download');
    const secondSite = (second.approval as { site: string }).site;
    assert.deepEqual(
      new Set([firstSite, secondSite]),
      new Set([base, otherBase]),
    );
    await act('snapshot', {
      approval: { token: token(second), scope: 'reject' },
    });
    const keptName = firstSite === base ? 'mine.bin' : 'theirs.bin';
    const discardedName = firstSite === base ? 'theirs.bin' : 'mine.bin';
    // Download completion and the move to its final name arrive asynchronously.
    // Observe the real file under the fixture's existing deadline and 3s download
    // bound, without assuming that answering the second approval finished it.
    await fixture.run(
      { phase: section, action: 'wait for kept download' },
      async () => {
        while (!existsSync(join(downloads, keptName))) await pause(25);
      },
      3000,
    );
    assert.equal(existsSync(join(downloads, keptName)), true);
    assert.equal(readFileSync(join(downloads, keptName), 'utf8'), keptName);
    assert.equal(existsSync(join(downloads, discardedName)), false);

    // ---- a dialog in another tab is answered only with that site's allowance
    section = 'other tab dialog';
    const opened = await act('tabs', { action: 'new', url: otherBase });
    await pause(800);
    const asking = await act('snapshot');
    const dialog = ref(asking.text, /\[(d\d+)\] confirm/);
    void opened;
    await act('tabs', { action: 'select', tab: 't1' });
    const refused = await act('dialog', {
      id: dialog,
      accept: true,
      site: base,
    });
    assert.match(
      refused.text,
      new RegExp(
        `Nothing was done: dialog ${dialog} is for ${otherBase.replace(/[.]/g, '\\.')}, not ${base.replace(/[.]/g, '\\.')}`,
      ),
    );
    assert.match(refused.text, /It is in tab t2/);
    await act('tabs', { action: 'select', tab: 't2' });
    const answered = await act('dialog', {
      id: dialog,
      accept: false,
      site: otherBase,
    });
    assert.match(answered.text, new RegExp(`Dismissed dialog ${dialog}\\.`));
    await act('tabs', { action: 'close', tab: 't2' });

    // ---- a dialog that ends Circle's click ends its hold on the page's file choosers too
    section = 'person file picker after alert';
    const files = await act('navigate', { url: `${base}/alert` });
    const saved = await act('click', {
      ref: ref(files.text, /\[(e\d+)\] button "Save"/),
      element: 'save',
    });
    assert.match(saved.text, /\[(d\d+)\] alert/);
    const internals = chrome as unknown as {
      conversations: Map<
        string,
        { tabs: Map<string, { session: string; chooser?: unknown }> }
      >;
      send: (
        method: string,
        params: Record<string, unknown>,
        session?: string,
      ) => Promise<unknown>;
    };
    const tab = internals.conversations.get('c')!.tabs.get('t1')!;
    // The person closes the alert and opens the file picker themselves
    await fixture.run(
      {
        phase: section,
        method: 'Page.handleJavaScriptDialog',
        session: tab.session,
      },
      () =>
        internals.send(
          'Page.handleJavaScriptDialog',
          { accept: true },
          tab.session,
        ),
      5000,
    );
    await pause(500);
    await fixture.run(
      { phase: section, method: 'Runtime.evaluate', session: tab.session },
      () =>
        internals.send(
          'Runtime.evaluate',
          {
            expression: `document.querySelector('input[type=file]').click()`,
            userGesture: true,
          },
          tab.session,
        ),
      5000,
    );
    await pause(500);
    assert.equal(tab.chooser, undefined);
  },
);

test(
  'a dialog the page opens while Circle reads it ends the wait, and the result shows the dialog',
  { skip },
  async (t) => {
    // The browser answers a request to the page only once the page's dialog is closed. The
    // page opens one while each of Circle's requests to it is on its way, as a busy machine
    // ordered it in CI (#130); the action's time limits are out of reach, so only the dialog can
    // end the wait.
    const temp = made(t, 'circle-chrome-dialog-wait-');
    const site = createHttp((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Asks</title><p>ready to ask</p>');
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
    });
    // Each request Circle makes to a new tab's page as it puts the result together, in order:
    // the request and how many of its kind come before it
    const stages: [string, number][] = [
      ['Page.getFrameTree', 0],
      ['Page.createIsolatedWorld', 0],
      // The document's title, then the snapshot
      ['Runtime.evaluate', 0],
      ['Runtime.evaluate', 1],
    ];
    // An action's 15s idle + 5s page + 3s download waits; the first also starts the browser.
    // Per stage: a new tab, the dialog's answer and the tab's close.
    const actionBudget = 15_000 + 5000 + 3000;
    const fixture = browserFixture(
      chrome,
      60_000 + actionBudget * (1 + stages.length * 3),
    );
    cleanup(t, () => fixture.close());
    const signal = AbortSignal.any([t.signal, fixture.signal]);
    const internal = chrome as unknown as {
      cdp: CdpPipe;
      send: (
        method: string,
        params?: Record<string, unknown>,
        session?: string,
        options?: Record<string, unknown>,
      ) => Promise<any>;
      limit: (
        promise: Promise<unknown>,
        signal?: AbortSignal,
        ms?: number,
        what?: string,
      ) => Promise<unknown>;
    };
    const act = (
      phase: string,
      action: BrowserAction,
      args = {},
      bound = actionBudget,
    ) =>
      fixture.run(
        { phase, action },
        () => chrome.request('c', action, args, signal),
        bound,
      );
    await act('first page', 'navigate', { url }, 60_000 + actionBudget);
    const first = (
      chrome as unknown as {
        conversations: Map<string, { tabs: Map<string, { session: string }> }>;
      }
    ).conversations
      .get('c')!
      .tabs.get('t1')!.session;
    const send = internal.send.bind(chrome);
    const limit = internal.limit.bind(chrome);
    for (const [method, before] of stages) {
      const stage = `${method} #${before + 1}`;
      let seen = 0;
      let staged = false;
      // The page opens its dialog, and then Circle's request reaches it
      internal.send = async (name, params = {}, session, options) => {
        if (
          !staged &&
          name === method &&
          session &&
          session !== first &&
          (name !== 'Runtime.evaluate' || params.contextId !== undefined) &&
          seen++ === before
        ) {
          staged = true;
          const opened = new Promise<void>((resolve) => {
            const stop = internal.cdp.on((event) => {
              if (
                event.method === 'Page.javascriptDialogOpening' &&
                event.sessionId === session
              ) {
                stop();
                resolve();
              }
            });
          });
          await send(
            'Runtime.evaluate',
            { expression: `setTimeout(() => confirm('Go on?'), 0)` },
            session,
          );
          await opened;
        }
        return send(name, params, session, options);
      };
      internal.limit = (promise, abort, _ms, what) =>
        limit(promise, abort, 2 ** 31 - 1, what);
      let opened;
      try {
        opened = await act(stage, 'tabs', { action: 'new', url });
      } finally {
        internal.send = send;
        internal.limit = limit;
      }
      assert.equal(staged, true, `${stage} was sent to the new tab`);
      const dialog = opened.text.match(
        /### Dialogs waiting\n- \[(d\d+)\] confirm · tab (t\d+) · from http:\/\/127\.0\.0\.1:\d+: "Go on\?"/,
      );
      assert(dialog, `${stage}: no dialog in\n${opened.text}`);
      assert.match(
        opened.text,
        new RegExp(
          `The page waits for dialog ${dialog[1]}; this is the dialog`,
        ),
      );
      // Once the dialog is answered, the page answers Circle again
      const answered = await act(stage, 'dialog', {
        id: dialog[1],
        accept: false,
      });
      assert.match(
        answered.text,
        new RegExp(`Dismissed dialog ${dialog[1]}\\.`),
      );
      assert.doesNotMatch(answered.text, /Dialogs waiting/);
      assert.match(answered.text, /ready to ask/);
      await act(stage, 'tabs', { action: 'close', tab: dialog[2] });
    }
  },
);
