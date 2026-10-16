import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSearchService } from '../src/websearch_service.js';
import type { NativeSearchConnection } from '../src/native_websearch.js';

const connection: NativeSearchConnection = {
  baseUrl: 'https://gateway.example/v1',
  protocol: 'openai',
  model: 'chosen-model',
  apiKey: 'synthetic-key',
};
const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const success = (
  sources: unknown[] = [
    { url: 'https://source.example/docs', title: 'Source' },
  ],
) => ({
  model: 'served-model',
  output: [
    {
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', sources },
    },
  ],
  usage: { input_tokens: 11, output_tokens: 7 },
});
const html = () =>
  new Response(
    '<a class="result-link" href="https://fallback.example/">Fallback source</a>',
  );

test('native search uses current connection and records execution, sources and helper usage', async () => {
  const seen: string[] = [];
  const calls: unknown[] = [];
  const service = new WebSearchService({
    request: async (url, init) => {
      seen.push(String(url));
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer synthetic-key',
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'chosen-model');
      assert.equal(body.tools[0].type, 'web_search');
      assert.ok(!JSON.stringify(body).includes('private session history'));
      return json(success());
    },
  });
  const result = await service.search(
    connection,
    'search query',
    2,
    signal(),
    (call) => calls.push(call),
  );
  assert.deepEqual(seen, ['https://gateway.example/v1/responses']);
  assert.match(result, /Provider: custom/);
  assert.match(result, /https:\/\/source.example\/docs/);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { model: string }).model, 'served-model');
});

test('only structured successful zero results are returned without fallback', async () => {
  let requests = 0;
  const service = new WebSearchService({
    request: async () => {
      requests++;
      return json(success([]));
    },
  });
  assert.match(
    await service.search(connection, 'zero', 5, signal()),
    /No results/,
  );
  assert.equal(requests, 1);
});

test('a 429 search quota falls back without the raw provider error', async () => {
  const service = new WebSearchService({
    request: async (url) => {
      if (String(url).includes('duckduckgo')) return html();
      return json(
        {
          error: {
            code: '1113',
            message:
              '余额不足或无可用资源包, 请充值。request id abc TLS failure raw',
          },
        },
        429,
      );
    },
  });
  const result = await service.search(connection, '京都天气', 3, signal());
  assert.match(result, /Provider: DuckDuckGo/);
  assert.match(result, /Native search unavailable: search quota exceeded/);
  assert.doesNotMatch(result, /1113|余额不足|TLS failure raw/);
});

test('ignored search parameters fall back, cool down, and never establish supported capability', async () => {
  let time = 1000;
  let native = 0;
  const service = new WebSearchService({
    now: () => time,
    request: async (url) => {
      if (String(url).endsWith('/responses')) {
        native++;
        return json({
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'I searched https://fake.example',
                },
              ],
            },
          ],
        });
      }
      return html();
    },
  });
  const result = await service.search(connection, 'query', 5, signal());
  assert.match(result, /Provider: DuckDuckGo/);
  assert.doesNotMatch(result, /fake.example/);
  await service.search(connection, 'again', 5, signal());
  assert.equal(native, 1);
  time += 30001;
  await service.search(connection, 'retry', 5, signal());
  assert.equal(native, 2);
});

test('explicit unsupported is cached while transient HTTP failures are retried after cooldown', async () => {
  for (const status of [400, 401, 403, 429, 503]) {
    let time = 1000;
    let native = 0;
    const service = new WebSearchService({
      now: () => time,
      request: async (url) => {
        if (!String(url).endsWith('/responses')) return html();
        native++;
        return json(
          { error: { message: 'web_search is not supported' } },
          status,
        );
      },
    });
    await service.search(connection, 'q', 1, signal());
    time += 30001;
    await service.search(connection, 'q', 1, signal());
    assert.equal(native, status === 400 ? 1 : 2, `HTTP ${status}`);
    time += 600001;
    await service.search(connection, 'q', 1, signal());
    assert.equal(native, status === 400 ? 2 : 3);
  }
});

test('connection keys isolate model, credentials, path and protocol; no custom key leaves its origin', async () => {
  const seen: string[] = [];
  const service = new WebSearchService({
    request: async (url) => {
      seen.push(String(url));
      if (String(url).includes('duckduckgo')) return html();
      return json({ error: { message: 'web_search not supported' } }, 400);
    },
  });
  for (const next of [
    connection,
    { ...connection, model: 'other' },
    { ...connection, apiKey: 'other-key' },
    { ...connection, baseUrl: 'https://gateway.example/private/v1' },
    { ...connection, protocol: 'anthropic' as const },
  ])
    await service.search(next, 'q', 1, signal());
  assert.equal(seen.filter((url) => url.endsWith('/responses')).length, 4);
  assert.ok(seen.some((url) => url.endsWith('/v1/models/chosen-model')));
  assert.ok(seen.some((url) => url.endsWith('/v1/messages')));
  assert.ok(
    seen.every((url) =>
      ['gateway.example', 'lite.duckduckgo.com'].includes(
        new URL(url).hostname,
      ),
    ),
  );
});

test('a generic missing route or model does not cache unsupported search for ten minutes', async () => {
  for (const status of [404, 405, 501]) {
    let now = 0;
    let native = 0;
    const service = new WebSearchService({
      now: () => now,
      request: async (url) => {
        if (!String(url).endsWith('/responses')) return html();
        native++;
        return json(
          { error: { code: 'model_not_found', message: 'Model unavailable' } },
          status,
        );
      },
    });
    await service.search(connection, 'first', 1, signal());
    now = 30001;
    await service.search(connection, 'retry', 1, signal());
    assert.equal(
      native,
      2,
      `HTTP ${status} is not a search capability declaration`,
    );
  }
});

test('concurrent initial unknown checks share their outcome without sharing query output', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let native = 0;
  const service = new WebSearchService({
    request: async (url) => {
      if (!String(url).endsWith('/responses')) return html();
      native++;
      await pending;
      return json({ error: { message: 'web_search not supported' } }, 400);
    },
  });
  const first = service.search(connection, 'first', 1, signal());
  const second = service.search(connection, 'second', 1, signal());
  finish();
  const results = await Promise.all([first, second]);
  assert.equal(native, 1);
  assert.match(results[0]!, /first/);
  assert.doesNotMatch(results[1]!, /first/);
});

test('native cancellation preserves exact reason and does not start fallback', async () => {
  const controller = new AbortController();
  const reason = new Error('user cancelled');
  let requests = 0;
  const service = new WebSearchService({
    request: async (_url, init) => {
      requests++;
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          'abort',
          () => reject(init!.signal!.reason),
          { once: true },
        );
        controller.abort(reason);
      });
    },
  });
  await assert.rejects(
    service.search(connection, 'q', 1, controller.signal),
    (error) => error === reason,
  );
  assert.equal(requests, 1);
});

test('a native deadline falls back and the total deadline stops the whole tool', async () => {
  for (const totalTimeout of [200, 10]) {
    let native = 0;
    let fallback = 0;
    const service = new WebSearchService({
      totalTimeout,
      nativeTimeout: 20,
      request: async (url, init) => {
        if (!String(url).endsWith('/responses')) {
          fallback++;
          return html();
        }
        native++;
        return new Promise((_resolve, reject) =>
          init!.signal!.addEventListener(
            'abort',
            () => reject(init!.signal!.reason),
            { once: true },
          ),
        );
      },
    });
    // AbortSignal.timeout is intentionally unref'd; keep this test alive while it waits.
    const hold = setTimeout(() => {}, 500);
    try {
      const result = service.search(connection, 'q', 1, signal());
      if (totalTimeout === 200)
        assert.match(await result, /Provider: DuckDuckGo/);
      else await assert.rejects(result, /timeout/i);
    } finally {
      clearTimeout(hold);
    }
    assert.equal(native, 1);
    assert.equal(fallback, totalTimeout === 200 ? 1 : 0);
  }
});

test('all-path errors retain endpoints but redact echoed key, query and proxy credentials', async () => {
  const service = new WebSearchService({
    request: async () => {
      throw new Error(
        'synthetic-key secret-query https://user:password@proxy.example/path?token=secret Authorization: Bearer secret',
      );
    },
  });
  await assert.rejects(
    service.search(connection, 'secret-query', 1, signal()),
    (error: Error) => {
      assert.match(error.message, /gateway.example/);
      assert.match(error.message, /lite.duckduckgo.com/);
      assert.match(error.message, /html.duckduckgo.com/);
      assert.doesNotMatch(
        error.message,
        /synthetic-key|secret-query|user:password|Bearer secret/,
      );
      return true;
    },
  );
});

test('a response-body AbortError is diagnosed using the native deadline reason', async () => {
  const service = new WebSearchService({
    nativeTimeout: 10,
    request: async (url, init) => {
      if (!String(url).endsWith('/responses')) return html();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"model":'));
            init!.signal!.addEventListener(
              'abort',
              () =>
                controller.error(
                  new DOMException('body aborted', 'AbortError'),
                ),
              { once: true },
            );
          },
        }),
      );
    },
  });
  const hold = setTimeout(() => {}, 500);
  try {
    const result = await service.search(connection, 'q', 1, signal());
    assert.match(result, /timeout failure on gateway.example/);
    assert.doesNotMatch(result, /connection failure/);
  } finally {
    clearTimeout(hold);
  }
});

test('Anthropic model declarations are coalesced and explicit false expires after ten minutes', async () => {
  let now = 0;
  let declarations = 0;
  let posts = 0;
  const service = new WebSearchService({
    now: () => now,
    request: async (url, init) => {
      if (String(url).includes('duckduckgo')) return html();
      if (init?.method === 'POST') posts++;
      declarations++;
      return json({
        capabilities: { server_tools: { web_search: { supported: false } } },
      });
    },
  });
  const next = { ...connection, protocol: 'anthropic' as const };
  await Promise.all([
    service.search(next, 'first', 1, signal()),
    service.search(next, 'second', 1, signal()),
  ]);
  assert.equal(declarations, 1);
  assert.equal(posts, 0);
  now = 600001;
  await service.search(next, 'after expiry', 1, signal());
  assert.equal(declarations, 2);
});
