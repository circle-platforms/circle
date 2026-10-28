import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { join } from 'node:path';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { cleanup, cleanupServer, scratch as made } from './helpers.js';
import { executable, skip, listen } from './browser-chrome-helpers.js';

test(
  'a snapshot shows the state of switches, checkboxes and toggles, see-through checkboxes and icon-only buttons, and a click changes it',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-snapshot-state-');
    const site = createHttp((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>state</title><style>.sw{display:inline-block;width:40px;height:20px;cursor:pointer;background:#ccc}.see{position:relative;display:inline-block;width:20px;height:20px;border:1px solid}.see input{position:absolute;inset:0;margin:0;opacity:0;width:100%;height:100%}</style>' +
          '<div class="sw" role="switch" aria-checked="true" aria-label="Health check" tabindex="0" onclick="this.setAttribute(\'aria-checked\', this.getAttribute(\'aria-checked\') === \'true\' ? \'false\' : \'true\')"></div>' +
          '<button aria-pressed="false">Bold</button><button aria-expanded="true">More</button>' +
          '<span class="see"><input type="checkbox" checked aria-label="Remember"></span>' +
          '<input type="checkbox" id="all" aria-label="All"><input type="checkbox" aria-label="Plain">' +
          '<div role="tab" aria-selected="true" tabindex="0">General</div><button aria-disabled="true">Apply</button>' +
          '<input aria-label="Name" required aria-invalid="true">' +
          '<button style="width:30px;height:20px"><i class="el-icon-delete"></i></button>' +
          '<button style="width:30px;height:20px"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Edit item" width="10" height="10"></button>' +
          '<script>document.getElementById("all").indeterminate = true</script>',
      );
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    const shown = await chrome.request('c', 'navigate', { url }, signal);
    const line = (pattern: RegExp) =>
      shown.text.split('\n').find((entry) => pattern.test(entry)) ?? '';
    assert.match(
      line(/switch "Health check"/),
      /\] switch "Health check" checked$/,
    );
    assert.match(line(/"Bold"/), /button "Bold" not pressed$/);
    assert.match(line(/"More"/), /button "More" expanded$/);
    // A native checkbox made see-through over a styled box is still there, with its state
    assert.match(line(/"Remember"/), /checkbox "Remember" value="on" checked$/);
    assert.match(line(/"All"/), /checkbox "All" value="on" mixed$/);
    assert.match(line(/"Plain"/), /checkbox "Plain" value="on" unchecked$/);
    assert.match(line(/"General"/), /tab "General" selected$/);
    assert.match(line(/"Apply"/), /button "Apply" disabled$/);
    assert.match(line(/"Name"/), /textbox "Name" value="" required invalid$/);
    assert.match(shown.text, /\] button "" icon=delete$/m);
    assert.match(shown.text, /\] button "Edit item"$/m);
    const ref = (name: string) =>
      line(new RegExp(`"${name}"`)).match(/\[(e\d+)\]/)![1]!;
    const toggled = await chrome.request(
      'c',
      'click',
      { ref: ref('Health check'), element: 'Health check switch' },
      signal,
    );
    assert.match(toggled.text, /\] switch "Health check" unchecked$/m);
    const unchecked = await chrome.request(
      'c',
      'click',
      { ref: ref('Remember'), element: 'Remember checkbox' },
      signal,
    );
    assert.match(unchecked.text, /checkbox "Remember" value="on" unchecked$/m);
  },
);

test(
  'a click reaches a wrapped link and a checkbox through its label, waits for a mask to go, and names a dialog that stays',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-click-covered-');
    const hits: string[] = [];
    const site = createHttp((req, res) => {
      if (req.url?.startsWith('/hit')) {
        hits.push(req.url);
        res.setHeader('Content-Type', 'text/html');
        res.end('<title>hit</title>done');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        req.url === '/dialog'
          ? '<!doctype html><title>dialog</title><button onclick="fetch(\'/hit-under\')">Delete row</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div role="dialog" aria-modal="true" aria-label="Edit user" style="margin:120px auto;width:300px;background:#fff"><button>Close</button></div></div>'
          : req.url === '/plain'
            ? '<!doctype html><title>plain</title><button id="b" onclick="fetch(\'/hit-plain\')">Refresh</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.1)"></div>'
            : '<!doctype html><title>covered</title><p style="font:20px/24px monospace">aaaaaaaaaaaaa <a id="wrap" href="/hit-link">go<br>on</a> bbbbbbbbbbbbbbbbbbbbbbbbbb</p>' +
              '<label><input type="checkbox" id="agree" style="position:absolute;opacity:0;width:16px;height:16px;margin:0;z-index:-1"><span style="display:inline-block;width:16px;height:16px;border:1px solid;background:#fff"></span> Agree</label>' +
              '<p><button id="save" onclick="fetch(\'/hit-save\')">Save</button></p><div id="mask" style="position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>',
      );
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    const internal = chrome as any;
    const page = (expression: string) =>
      internal.evaluate(
        internal.conversations.get('c').tabs.get('t1'),
        expression,
        signal,
      );
    const shown = await chrome.request('c', 'navigate', { url }, signal);
    const ref = (text: string, name: string) =>
      text
        .split('\n')
        .find((entry) => entry.includes(`"${name}"`))!
        .match(/\[(e\d+)\]/)![1]!;
    // Everything under the mask is marked, and a click waits for the mask to go
    assert.match(shown.text, /\] link "go on" \[covered\]$/m);
    assert.match(shown.text, /\] button "Save" \[covered\]$/m);
    await page(
      'setTimeout(() => document.getElementById("mask").remove(), 800)',
    );
    const started = Date.now();
    const saved = await chrome.request(
      'c',
      'click',
      { ref: ref(shown.text, 'Save'), element: 'Save' },
      signal,
    );
    assert.ok(Date.now() - started >= 700, 'the click waited for the mask');
    assert.match(saved.text, /Clicked e\d+ button "Save"/);
    assert.doesNotMatch(saved.text, /\[covered\]/);
    assert.deepEqual(hits, ['/hit-save']);
    // A checkbox whose box is drawn over it takes the click through its label
    const agreed = await chrome.request(
      'c',
      'click',
      { ref: ref(saved.text, 'Agree'), element: 'Agree' },
      signal,
    );
    assert.match(agreed.text, /checkbox "Agree" value="on" checked/);
    // The middle of a link's box that wraps is on the paragraph, not on the link
    const box = await page(
      '(() => { const r = document.getElementById("wrap").getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return at && at.localName })()',
    );
    assert.equal(box, 'p');
    await chrome.request(
      'c',
      'click',
      { ref: ref(agreed.text, 'go on'), element: 'go on link' },
      signal,
    );
    assert.deepEqual(hits, ['/hit-save', '/hit-link']);
    // A dialog stays until it is answered: said once the page is still, not after the wait
    const dialog = await chrome.request(
      'c',
      'navigate',
      { url: url + 'dialog' },
      signal,
    );
    assert.match(dialog.text, /\] button "Delete row" \[covered\]$/m);
    assert.match(dialog.text, /\] button "Close"$/m);
    const before = Date.now();
    await assert.rejects(
      chrome.request(
        'c',
        'click',
        { ref: ref(dialog.text, 'Delete row'), element: 'Delete row' },
        signal,
      ),
      /the element is covered by .* of dialog "Edit user": close the dialog or act in it first/,
    );
    assert.ok(Date.now() - before < 2500, 'a dialog is not waited out');
    // What covers it and does not go is said after the wait
    const plain = await chrome.request(
      'c',
      'navigate',
      { url: url + 'plain' },
      signal,
    );
    const waited = Date.now();
    await assert.rejects(
      chrome.request(
        'c',
        'click',
        { ref: ref(plain.text, 'Refresh'), element: 'Refresh' },
        signal,
      ),
      /the element is covered by div "", still after 3(?:\.\d)? s/,
    );
    assert.ok(Date.now() - waited >= 2900);
    assert.deepEqual(hits, ['/hit-save', '/hit-link']);
  },
);

test(
  'the result of a click shows the page once it has settled',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-click-settle-');
    const site = createHttp((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        "<!doctype html><title>settle</title><button onclick=\"let i = 0; const timer = setInterval(() => { i++; document.getElementById('status').textContent = i < 7 ? 'step ' + i : 'Done'; if (i >= 7) clearInterval(timer) }, 120)\">Run</button><p id=\"status\">idle</p>",
      );
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    await chrome.request('c', 'navigate', { url }, signal);
    const ran = await chrome.request(
      'c',
      'click',
      { ref: 'e1', element: 'Run' },
      signal,
    );
    assert.match(ran.text, /^Done$/m);
  },
);

test(
  'a coordinate click goes on while the page changes elsewhere, and is refused when what is at the point changed',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-coordinate-local-');
    const hits: string[] = [];
    const site = createHttp((req, res) => {
      if (req.url?.startsWith('/hit')) {
        hits.push(req.url);
        res.end('yes');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>clock</title><style>.hover{outline:2px solid red}</style><p id="clock">0</p><button id="go" style="margin:40px;width:200px;height:50px">Go</button><div id="tip" style="position:absolute;right:0;top:0">tip</div>' +
          '<script>let n = 0; setInterval(() => { document.getElementById("clock").textContent = String(++n) }, 40); const go = document.getElementById("go"); go.onclick = () => fetch("/hit-go"); go.onmouseenter = () => { go.classList.add("hover"); go.setAttribute("aria-describedby", "tip") }</script>',
      );
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
      mode: () => 'auto',
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    const internal = chrome as any;
    const page = (expression: string) =>
      internal.evaluate(
        internal.conversations.get('c').tabs.get('t1'),
        expression,
        signal,
      );
    await chrome.request('c', 'navigate', { url }, signal);
    const point = await page(
      '(() => { const r = document.getElementById("go").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()',
    );
    // The clock ticks and the hover restyles the button: neither is where the click goes
    const shot = await chrome.request('c', 'screenshot', {}, signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const clicked = await chrome.request(
      'c',
      'click_at',
      { ...point, screenshotId: shot.screenshot!.id },
      signal,
    );
    assert.match(clicked.text, /Clicked at .*button "Go"/);
    assert.deepEqual(hits, ['/hit-go']);
    // The button itself changed since the screenshot
    const changed = await chrome.request('c', 'screenshot', {}, signal);
    await page('document.getElementById("go").textContent = "Delete all"');
    await assert.rejects(
      chrome.request(
        'c',
        'click_at',
        { ...point, screenshotId: changed.screenshot!.id },
        signal,
      ),
      /screenshot is stale: what is at these coordinates changed/,
    );
    // A mask the screenshot showed over the button is gone. On a page loaded again, whose
    // button is as the screenshot shows it: the pointer still rests there, so its hover
    // handler goes first.
    await chrome.request('c', 'navigate', { url }, signal);
    await page('document.getElementById("go").onmouseenter = null');
    await page(
      'document.body.insertAdjacentHTML("beforeend", "<div id=mask style=\'position:fixed;inset:0;background:rgba(0,0,0,.3)\'></div>")',
    );
    const masked = await chrome.request('c', 'screenshot', {}, signal);
    await page('document.getElementById("mask").remove()');
    await assert.rejects(
      chrome.request(
        'c',
        'click_at',
        { ...point, screenshotId: masked.screenshot!.id },
        signal,
      ),
      /screenshot is stale: what lay over these coordinates changed/,
    );
    assert.deepEqual(hits, ['/hit-go']);
  },
);

test(
  'a snapshot cut short keeps the drawer at the end of the page',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-snapshot-layers-');
    const site = createHttp((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      // The page's own scroll bar takes room from the viewport on every system, as the
      // system's does where it is always shown; the last page has no doctype
      const bar =
        req.url === '/'
          ? ''
          : '<style>::-webkit-scrollbar{width:30px;height:30px}</style>';
      res.end(
        `${req.url === '/quirks' ? '' : '<!doctype html>'}<title>long</title>${bar}<main>${'<p>a long row of the list <button>Edit</button></p>'.repeat(1500)}</main><div style="position:fixed;inset:0;background:rgba(0,0,0,.3)"></div><aside role="dialog" aria-label="Health check" style="position:fixed;right:0;top:0;bottom:0;width:300px;background:#fff"><label>Request <select aria-label="Request"><option>GET /</option></select></label><button>Save drawer</button></aside>`,
      );
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    for (const page of ['', 'scroll-bar', 'quirks']) {
      const shown = await chrome.request(
        'c',
        'navigate',
        { url: url + page },
        signal,
      );
      assert.match(shown.text, /… snapshot truncated$/, page);
      assert.match(
        shown.text,
        /… the rest of the page is left out; what lies on top of it follows/,
        page,
      );
      assert.match(shown.text, /\] button "Save drawer"$/m, page);
      assert.match(shown.text, /\] combobox "Request" value="GET \/"/, page);
      // The list under the drawer's mask is marked, also where it is out of view
      assert.match(shown.text, /\] button "Edit" \[covered\]$/m, page);
      assert.doesNotMatch(shown.text, /\] button "Edit"$/m, page);
    }
  },
);

test(
  'a page can close its own popup and the terminal browser reports the closed tab and continues',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-popup-close-');
    const cookies: string[] = [];
    const site = createHttp((req, res) => {
      cookies.push(req.headers.cookie ?? '');
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Set-Cookie', 'fixture=kept; SameSite=Lax');
      res.end(
        req.url === '/popup'
          ? '<title>popup</title><button onclick="window.close()">close this page</button>'
          : '<title>opener</title><button onclick="window.open(\'/popup\')">open popup</button>',
      );
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    await chrome.request('c', 'navigate', { url }, signal);
    const opened = await chrome.request(
      'c',
      'click',
      { ref: 'e1', element: 'open popup' },
      signal,
    );
    assert.match(opened.text, /t2 \(shown\)/);
    const closed = await chrome.request(
      'c',
      'click',
      { ref: 'e1', element: 'close this page' },
      signal,
    );
    assert.match(closed.text, /tab t2 was closed/);
    const listed = await chrome.request(
      'c',
      'tabs',
      { action: 'list' },
      signal,
    );
    assert.match(listed.text, /t1 \(shown\)/);
    assert.doesNotMatch(listed.text, /t2/);
    const after = await chrome.request(
      'c',
      'navigate',
      { url: url + 'after' },
      signal,
    );
    assert.match(after.text, /opener/);
    assert.ok(cookies.at(-1)?.includes('fixture=kept'));
    await assert.rejects(
      chrome.request('c', 'tabs', { action: 'select', tab: 't2' }, signal),
      /no tab t2/,
    );
  },
);
