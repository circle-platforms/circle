import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSearchHtml, webSearch } from '../src/websearch.js';

test('HTML search keeps only actual result anchors and associates snippets with their result', () => {
  const html = `
    <a href="https://navigation.example">Navigation must not become a result</a>
    <a class="result__url" href="https://first.example">first.example</a>
    <a href="https://first.example/docs?a=1&amp;b=2" class="result__a other">First &amp; API</a>
    <div class="result__extras"><a href="https://ads.example">Advert</a></div>
    <a class="result__a" href="https://second.example/docs">Second</a>
    <div class="wrapper"><a class="result__snippet">Second <b>snippet</b> &amp; details</a></div>
    <a class="result__a" href="https://third.example/docs">Third</a>
    <div class="result__snippet">Third snippet</div>
    <a data-class="result__a" href="https://not-a-result.example">Wrong attribute</a>
  `;
  const result = parseSearchHtml(html, 'API', 2, 2026);
  assert.match(
    result,
    /1\. First & API\n   https:\/\/first.example\/docs\?a=1&b=2\n\n2\. Second\n   https:\/\/second.example\/docs\n   Second snippet & details/,
  );
  assert.doesNotMatch(
    result,
    /Navigation|navigation.example|Advert|ads.example|Third|Wrong attribute/,
  );
});

test('lite search decodes result redirects and associates the following snippet row', () => {
  const html = `<table>
    <tr><td>1.</td><td><a rel="nofollow" class='result-link' href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2&amp;rut=ignored">Example &#x26; docs</a></td></tr>
    <tr><td></td><td class='result-snippet'>Read <strong>these</strong> docs.</td></tr>
    <tr><td>2.</td><td><a class=result-link href='https://other.example'>Other</a></td></tr>
    <tr><td></td><td class=result-snippet>Other snippet.</td></tr>
    </table>`;
  const result = parseSearchHtml(html, 'docs');
  assert.match(
    result,
    /1\. Example & docs\n   https:\/\/example.com\/a\?x=1&y=2\n   Read these docs/,
  );
  assert.match(
    result,
    /2\. Other\n   https:\/\/other.example\/\n   Other snippet/,
  );
  assert.doesNotMatch(result, /uddg|rut=/);
});

test('search ignores script, comment and malformed result anchors without inventing links', () => {
  const html = `<script>const html = '<a class="result__a" href="https://fake.example">Script result</a><form class="captcha">Hidden template</form>';</script>
    <!-- <a class="result__a" href="https://comment.example">Comment result</a> -->
    <a class="result__a" href="javascript:alert(1)">Unsafe</a>
    <a class="result__a" href="https://duckduckgo.com/about">Internal</a>
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=invalid">Invalid redirect</a>
    <a class="result__a" href="https://real.example">CAPTCHA documentation</a>`;
  const result = parseSearchHtml(html, 'captcha');
  assert.match(result, /1\. CAPTCHA documentation/);
  assert.doesNotMatch(
    result,
    /Script result|Comment result|Unsafe|Internal|Invalid redirect/,
  );
});

test('only recognized no-results markup is accepted as an empty search', () => {
  for (const html of [
    '<div class="no-results__message"><h1>No results found for <strong>query</strong></h1></div>',
    '<table><tr><td><span class="no-results">No results found for query</span></td></tr></table>',
  ])
    assert.match(
      parseSearchHtml(html, 'query'),
      /No results for "query" \(source: DuckDuckGo\)/,
    );
  for (const html of [
    '',
    '<html><a href="https://example.com">ordinary page</a></html>',
    '<div>no results found</div>',
    '<div class="no-results">temporarily unavailable</div>',
    '<a class="result__a" href="javascript:alert(1)">not a valid result</a>',
  ])
    assert.throws(
      () => parseSearchHtml(html, 'query'),
      /unrecognized search page/,
    );
});

for (const status of [200, 202]) {
  test(`HTTP ${status} bot challenges cause a second endpoint search`, async () => {
    const urls: string[] = [];
    const result = await webSearch(
      'query',
      new AbortController().signal,
      5,
      async (input) => {
        urls.push(String(input));
        if (urls.length === 1)
          return new Response(
            '<html><form id="challenge-form" action="//duckduckgo.com/anomaly.js?token=hidden">Please verify you are human</form></html>',
            { status },
          );
        return new Response(
          '<a class="result__a" href="https://success.example">Fallback result</a>',
        );
      },
    );
    assert.equal(urls.length, 2);
    assert.match(urls[0]!, /^https:\/\/lite.duckduckgo.com\/lite\//);
    assert.match(urls[1]!, /^https:\/\/html.duckduckgo.com\/html\//);
    assert.match(result, /Fallback result/);
  });
}

test('two challenge pages report both failures and never report no results', async () => {
  let calls = 0;
  await assert.rejects(
    webSearch('query', new AbortController().signal, 5, async () => {
      calls++;
      return new Response('<div class="anomaly-modal">Select the ducks</div>', {
        status: 202,
      });
    }),
    (error: Error) => {
      assert.match(
        error.message,
        /lite.duckduckgo.com[\s\S]*CAPTCHA[\s\S]*html.duckduckgo.com[\s\S]*CAPTCHA/,
      );
      assert.doesNotMatch(error.message, /No results|HTTPS_PROXY/);
      assert.ok(error.cause instanceof AggregateError);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test('unknown HTML is retried but a confirmed empty search stops without fallback', async () => {
  let calls = 0;
  const result = await webSearch(
    'query',
    new AbortController().signal,
    5,
    async () => {
      calls++;
      if (calls === 1)
        return new Response('<html><h1>Something changed</h1></html>');
      return new Response(
        '<div class="no-results">No results found for query</div>',
      );
    },
  );
  assert.equal(calls, 2);
  assert.match(result, /No results/);
  calls = 0;
  await webSearch('query', new AbortController().signal, 5, async () => {
    calls++;
    return new Response(
      '<div class="no-results__container">No results found for query</div>',
    );
  });
  assert.equal(calls, 1);
});

test('a response-body deadline retains timeout classification and the 15 second endpoint budget', async (t) => {
  const budgets: number[] = [];
  const timeouts: AbortController[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    budgets.push(milliseconds);
    const timeout = new AbortController();
    timeouts.push(timeout);
    return timeout.signal;
  });
  let calls = 0;
  await assert.rejects(
    webSearch('query', new AbortController().signal, 5, async (_url, init) => {
      calls++;
      return new Response(
        new ReadableStream({
          start(body) {
            init!.signal!.addEventListener(
              'abort',
              () => {
                // Fetch body streams use AbortError even when the timeout signal
                // preserves the more useful TimeoutError reason.
                body.error(
                  new DOMException('The operation was aborted.', 'AbortError'),
                );
              },
              { once: true },
            );
            queueMicrotask(() =>
              timeouts
                .at(-1)!
                .abort(
                  new DOMException('Search endpoint timed out', 'TimeoutError'),
                ),
            );
          },
        }),
      );
    }),
    (error: Error) => {
      assert.match(error.message, /timeout failure on lite.duckduckgo.com/);
      assert.match(error.message, /timeout failure on html.duckduckgo.com/);
      assert.doesNotMatch(error.message, /connection failure/);
      return true;
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(budgets, [15000, 15000]);
});

test('user cancellation during a response body preserves its exact reason and skips fallback', async () => {
  const controller = new AbortController();
  const reason = new Error('user stopped this search');
  let calls = 0;
  await assert.rejects(
    webSearch('query', controller.signal, 5, async (_url, init) => {
      calls++;
      return new Response(
        new ReadableStream({
          start(body) {
            init!.signal!.addEventListener(
              'abort',
              () =>
                body.error(
                  new DOMException('The operation was aborted.', 'AbortError'),
                ),
              { once: true },
            );
            queueMicrotask(() => controller.abort(reason));
          },
        }),
      );
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(calls, 1);
});
