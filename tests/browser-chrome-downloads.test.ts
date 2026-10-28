import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { join } from 'node:path';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { cleanup, cleanupServer, scratch as made } from './helpers.js';
import { executable, skip, listen } from './browser-chrome-helpers.js';

test(
  'a download navigation waits for a delayed download-start event instead of claiming Loaded',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-download-start-');
    const site = createHttp((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="late.bin"',
      });
      res.end('late bytes');
    });
    const url = `http://127.0.0.1:${await listen(site)}/download`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
    });
    cleanup(t, () => chrome.close());
    const internals = chrome as unknown as {
      event: (pipe: unknown, event: { method: string }) => void;
    };
    const navigationResponses: unknown[] = [];
    const send = (chrome as any).send.bind(chrome);
    (chrome as any).send = async (method: string, ...args: unknown[]) => {
      const reply = await send(method, ...args);
      if (method === 'Page.navigate') navigationResponses.push(reply);
      return reply;
    };
    const event = internals.event.bind(chrome);
    const timers: ReturnType<typeof setTimeout>[] = [];
    cleanup(t, () => {
      timers.forEach(clearTimeout);
      timers.length = 0;
    });
    internals.event = (pipe, value) => {
      if (value.method.startsWith('Browser.download'))
        timers.push(setTimeout(() => event(pipe, value), 1600));
      else event(pipe, value);
    };
    const asked = await chrome.request(
      'c',
      'navigate',
      { url },
      new AbortController().signal,
    );
    assert.equal(asked.approval?.kind, 'download');
    assert.match(asked.text, /started download/);
    assert.doesNotMatch(asked.text, /Loaded\./);
    assert.equal(existsSync(join(temp, 'downloads', 'late.bin')), false);
    t.diagnostic(
      JSON.stringify({
        platform: process.platform,
        navigationResponses,
        downloadStartDeliveryDelayMs: 1600,
      }),
    );
  },
);

test(
  'a first navigation replaced by a no-content response reports the response and saves no download',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-download-intercepted-');
    const hits: string[] = [];
    const site = createHttp((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/intercepted') {
        res.writeHead(204, 'Intercepted by a local download integration');
        res.end();
      } else {
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><title>ordinary page</title>ready');
      }
    });
    const base = `http://127.0.0.1:${await listen(site)}`;
    cleanupServer(t, site);
    const downloads = join(temp, 'downloads');
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads,
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    const aborted = await chrome.request(
      'c',
      'navigate',
      { url: `${base}/intercepted` },
      signal,
    );
    assert.equal(aborted.approval, undefined);
    assert.match(
      aborted.text,
      /Navigation was aborted; the page was not loaded\./,
    );
    assert.match(
      aborted.text,
      /HTTP 204 \("Intercepted by a local download integration"\)/,
    );
    assert.doesNotMatch(aborted.text, /Loaded\.|started download/);
    assert.equal(existsSync(downloads), false);
    assert.deepEqual(hits, ['/intercepted']);
    // The browser can still open an ordinary page after the aborted navigation.
    const loaded = await chrome.request(
      'c',
      'navigate',
      { url: `${base}/page` },
      signal,
    );
    assert.match(loaded.text, /Loaded\./);
    assert.doesNotMatch(loaded.text, /HTTP 204|Intercepted by/);
  },
);
