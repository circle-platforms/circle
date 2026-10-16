import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import {
  nativeWebSearch,
  nativeSearchCapability,
  NativeSearchUnsupported,
  type NativeSearchConnection,
  type NativeSearchUsage,
} from '../src/native_websearch.js';
import { searchProvider } from '../src/providers.js';

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  method?: string;
  body: Record<string, unknown>;
}
async function gateway(t: TestContext, answer: unknown, status = 200) {
  const seen: Seen[] = [];
  const original: URL[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({
      url: req.url!,
      headers: req.headers,
      method: req.method,
      body: raw ? JSON.parse(raw) : {},
    });
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request: typeof fetch = async (input, init) => {
    const target = new URL(
      input instanceof Request ? input.url : String(input),
    );
    original.push(target);
    assert.equal(init?.redirect, 'error');
    return fetch(local + target.pathname + target.search, init);
  };
  return { seen, original, request, local };
}
const source = {
  url: 'https://example.org/news',
  title: 'News',
  snippet: 'A verified search snippet.',
};
const tokens = {
  input_tokens: 31,
  output_tokens: 12,
  input_tokens_details: { cached_tokens: 5 },
};
const responses = (sources: unknown[] = [source]) => ({
  model: 'actual-model',
  usage: tokens,
  output: [
    {
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', sources },
    },
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'Search summary.',
          annotations: [{ type: 'url_citation', ...source }],
        },
      ],
    },
  ],
});
const connection = (
  baseUrl: string,
  model = 'configured-model',
  protocol: 'openai' | 'anthropic' = 'openai',
): NativeSearchConnection => ({
  baseUrl,
  model,
  protocol,
  apiKey: 'synthetic-test-key',
});
const signal = () => AbortSignal.timeout(5000);

test('endpoint metadata matches complete official routes and never infers vendors from a model', () => {
  assert.deepEqual(
    searchProvider('https://api.openai.com/v1/', 'openai', 'gpt'),
    { id: 'openai', adapter: 'responses' },
  );
  assert.deepEqual(
    searchProvider('https://api.anthropic.com/v1', 'anthropic', 'claude'),
    { id: 'anthropic', adapter: 'anthropic' },
  );
  assert.deepEqual(
    searchProvider(
      'https://open.bigmodel.cn/api/anthropic',
      'anthropic',
      'glm-5.3',
    ),
    { id: 'zhipu-anthropic', adapter: 'zhipu' },
  );
  assert.deepEqual(
    searchProvider('https://proxy.example/v1', 'openai', 'qwen3.8-max'),
    { id: 'custom', adapter: 'responses' },
  );
  assert.deepEqual(
    searchProvider('https://api.openai.com/proxy/v1', 'openai', 'gemini'),
    { id: 'custom', adapter: 'responses' },
  );
  assert.equal(
    searchProvider('https://api.deepseek.com', 'openai', 'deepseek').adapter,
    'unsupported',
  );
  assert.equal(
    searchProvider('https://api.openai.com/v1', 'anthropic', 'claude').adapter,
    'unsupported',
  );
  assert.equal(
    searchProvider('https://api.deepseek.com/v1', 'openai', 'deepseek').adapter,
    'unsupported',
  );
  assert.equal(
    searchProvider('https://api.groq.com/openai/v1', 'openai', 'llama').adapter,
    'unsupported',
  );
  assert.equal(
    searchProvider(
      'https://api.groq.com/openai/v1',
      'openai',
      'openai/gpt-oss-20b',
    ).adapter,
    'groq',
  );
  assert.equal(
    searchProvider(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'openai',
      'qwen',
    ).adapter,
    'bailian',
  );
  assert.equal(
    searchProvider(
      'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      'openai',
      'qwen',
    ).adapter,
    'bailian',
  );
  assert.equal(
    searchProvider('https://api.moonshot.ai/v1', 'openai', 'kimi').adapter,
    'kimi',
  );
});

test('OpenAI, xAI, Ark and supported Bailian models use the current model and same-origin Responses', async (t) => {
  for (const [baseUrl, model, path, provider] of [
    ['https://api.openai.com/v1', 'gpt-current', '/v1/responses', 'openai'],
    ['https://api.openai.com', 'gpt-current', '/v1/responses', 'openai'],
    ['https://api.x.ai/v1', 'grok-current', '/v1/responses', 'xai'],
    [
      'https://ark.cn-beijing.volces.com/api/v3',
      'deployment-current',
      '/api/v3/responses',
      'ark',
    ],
    [
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'qwen3.8-max',
      '/compatible-mode/v1/responses',
      'bailian',
    ],
    [
      'https://proxy.example/openai/v1',
      'claude-through-proxy',
      '/openai/v1/responses',
      'custom',
    ],
  ]) {
    const { request, seen, original } = await gateway(t, responses());
    const charges: NativeSearchUsage[] = [];
    const result = await nativeWebSearch(
      connection(baseUrl!, model),
      'circle web search',
      3,
      signal(),
      request,
      (usage) => charges.push(usage),
    );
    assert.equal(result.executed, true);
    assert.equal(result.provider, provider);
    assert.equal(result.results[0]?.url, source.url);
    assert.equal(result.summary, 'Search summary.');
    assert.equal(original[0]?.origin, new URL(baseUrl!).origin);
    assert.equal(seen[0]?.url, path);
    assert.equal(seen[0]?.headers.authorization, 'Bearer synthetic-test-key');
    assert.equal(seen[0]?.body.model, model);
    assert.equal(seen[0]?.body.store, false);
    assert.match(String(seen[0]?.body.input), /circle web search/);
    assert.deepEqual(seen[0]?.body.tools, [
      {
        type: 'web_search',
        ...(provider === 'ark' ? { sources: ['doubao'] } : {}),
      },
    ]);
    assert.equal(charges.length, 1);
    assert.equal(charges[0]?.model, 'actual-model');
    assert.equal(charges[0]?.usage.input_tokens, 31);
    assert.equal(charges[0]?.usage.cache_read_tokens, 5);
    assert.equal(charges[0]?.searchRequests, 1);
    assert.equal(charges[0]?.toolFeeUnknown, true);
  }
});

test('root API bases join native search and Models paths without double slashes', async (t) => {
  for (const baseUrl of [
    'https://api.anthropic.com',
    'https://proxy.example/',
  ]) {
    const { request, seen } = await gateway(t, {
      capabilities: { server_tools: { web_search: { supported: true } } },
      content: [
        { type: 'server_tool_use', name: 'web_search', id: 'search-1' },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'search-1',
          content: [{ type: 'web_search_result', ...source }],
        },
      ],
    });
    const selected = connection(baseUrl, 'selected-model', 'anthropic');
    assert.equal(
      await nativeSearchCapability(selected, signal(), request),
      'supported',
    );
    const result = await nativeWebSearch(
      selected,
      'query',
      1,
      signal(),
      request,
    );
    assert.equal(result.executed, true);
    assert.deepEqual(
      seen.map((entry) => entry.url),
      ['/v1/models/selected-model', '/v1/messages'],
    );
  }
  const { request, seen } = await gateway(t, responses());
  await nativeWebSearch(
    connection('https://proxy.example/'),
    'query',
    1,
    signal(),
    request,
  );
  assert.equal(seen[0]?.url, '/responses');
});

test('HTTP 200, a normal function call, or unverified citations never prove hosted search', async (t) => {
  for (const output of [
    [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'I searched https://example.org',
            annotations: [{ type: 'url_citation', ...source }],
          },
        ],
      },
    ],
    [{ type: 'function_call', name: 'web_search', arguments: '{}' }],
    [
      {
        type: 'web_search_call',
        status: 'in_progress',
        action: { sources: [source] },
      },
    ],
  ]) {
    const { request } = await gateway(t, { output, usage: tokens });
    const result = await nativeWebSearch(
      connection('https://proxy.example/prefix/v1'),
      'query',
      5,
      signal(),
      request,
    );
    assert.equal(result.executed, false);
    assert.deepEqual(result.results, []);
  }
});

test('a completed empty source array succeeds while malformed source data fails', async (t) => {
  const empty = responses([]);
  empty.output.pop();
  const { request } = await gateway(t, empty);
  const result = await nativeWebSearch(
    connection('https://api.openai.com/v1'),
    'query',
    5,
    signal(),
    request,
  );
  assert.equal(result.executed, true);
  assert.deepEqual(result.results, []);
  const malformed = await gateway(
    t,
    responses([{ url: 'javascript:alert(1)' }]),
  );
  await assert.rejects(
    nativeWebSearch(
      connection('https://api.openai.com/v1'),
      'query',
      5,
      signal(),
      malformed.request,
    ),
    /malformed sources/,
  );
});

test('Anthropic compatible search pairs server calls with results and accounts for cached input', async (t) => {
  const { request, seen } = await gateway(t, {
    model: 'claude-returned',
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
      server_tool_use: { web_search_requests: 1 },
    },
    content: [
      {
        type: 'server_tool_use',
        name: 'web_search',
        id: 'search-1',
        input: { query: 'query' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'search-1',
        content: [{ type: 'web_search_result', ...source }],
      },
      {
        type: 'text',
        text: 'Summary',
        citations: [
          {
            type: 'web_search_result_location',
            ...source,
            cited_text: 'Quoted text',
          },
        ],
      },
    ],
  });
  const charges: NativeSearchUsage[] = [];
  const result = await nativeWebSearch(
    connection(
      'https://proxy.example/prefix/v1',
      'claude-selected',
      'anthropic',
    ),
    'query',
    5,
    signal(),
    request,
    (value) => charges.push(value),
  );
  assert.equal(seen[0]?.url, '/prefix/v1/messages');
  assert.equal(seen[0]?.headers['x-api-key'], 'synthetic-test-key');
  assert.equal(seen[0]?.headers.authorization, undefined);
  assert.equal(seen[0]?.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(seen[0]?.body.tools, [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
  ]);
  assert.equal(result.executed, true);
  assert.equal(result.results[0]?.title, source.title);
  assert.equal(charges[0]?.usage.input_tokens, 20);
  assert.equal(charges[0]?.usage.cache_write_tokens, 3);
});

test('Anthropic embedded failures preserve usage and do not classify rate limits as unsupported', async (t) => {
  for (const error of ['too_many_requests', 'unsupported_tool']) {
    const { request } = await gateway(t, {
      usage: { input_tokens: 4, output_tokens: 2 },
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'call',
          content: { type: 'web_search_tool_result_error', error_code: error },
        },
      ],
    });
    const charges: NativeSearchUsage[] = [];
    await assert.rejects(
      nativeWebSearch(
        connection('https://proxy.example', 'claude', 'anthropic'),
        'query',
        2,
        signal(),
        request,
        (value) => charges.push(value),
      ),
      (caught: unknown) => {
        assert.equal(
          caught instanceof NativeSearchUnsupported,
          error === 'unsupported_tool',
        );
        return true;
      },
    );
    assert.equal(charges[0]?.usage.input_tokens, 4);
    assert.equal(charges.length, 1);
  }
});

test('Anthropic capability declaration distinguishes false, missing and missing Models routes', async (t) => {
  for (const [answer, status, expected] of [
    [
      { capabilities: { server_tools: { web_search: { supported: true } } } },
      200,
      'supported',
    ],
    [
      { capabilities: { server_tools: { web_search: { supported: false } } } },
      200,
      'unsupported',
    ],
    [{ id: 'model' }, 200, 'unknown'],
    [{ error: { message: 'missing route' } }, 404, 'unknown'],
  ] as const) {
    const { request, seen } = await gateway(t, answer, status);
    assert.equal(
      await nativeSearchCapability(
        connection('https://proxy.example/prefix', 'model/name', 'anthropic'),
        signal(),
        request,
      ),
      expected,
    );
    assert.equal(seen[0]?.method, 'GET');
    assert.equal(seen[0]?.url, '/prefix/v1/models/model%2Fname');
  }
  const { request, seen } = await gateway(t, {});
  assert.equal(
    await nativeSearchCapability(
      connection('https://proxy.example/v1'),
      signal(),
      request,
    ),
    'unknown',
  );
  assert.equal(seen.length, 0);
});

test('Bailian legacy Chat forces search but accepts only structured search results', async (t) => {
  for (const hasSources of [true, false]) {
    const { request, seen } = await gateway(t, {
      choices: [
        { message: { content: 'I searched: https://example.org/news' } },
      ],
      ...(hasSources ? { search_info: { search_results: [source] } } : {}),
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const result = await nativeWebSearch(
      connection(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'qwen-plus',
      ),
      'query',
      5,
      signal(),
      request,
    );
    assert.equal(seen[0]?.url, '/compatible-mode/v1/chat/completions');
    assert.equal(seen[0]?.body.enable_search, true);
    assert.deepEqual(seen[0]?.body.search_options, {
      forced_search: true,
      enable_source: true,
    });
    assert.equal(result.executed, hasSources);
  }
});

test('Zhipu tools use official search parameters and return structured links', async (t) => {
  const { request, seen } = await gateway(t, {
    choices: [{ message: { content: 'Summary' } }],
    web_search: [{ title: 'News', link: source.url, content: 'Snippet' }],
  });
  const result = await nativeWebSearch(
    connection('https://open.bigmodel.cn/api/paas/v4', 'glm-current'),
    'query',
    2,
    signal(),
    request,
  );
  assert.equal(seen[0]?.url, '/api/paas/v4/chat/completions');
  assert.deepEqual(seen[0]?.body.tools, [
    {
      type: 'web_search',
      web_search: {
        enable: true,
        search_engine: 'search_pro',
        search_result: true,
      },
    },
  ]);
  assert.equal(result.results[0]?.snippet, 'Snippet');
  assert.equal(result.executed, true);
});

test('Zhipu on the Anthropic route searches through paas v4 with the same key', async (t) => {
  const { request, seen, original } = await gateway(t, {
    choices: [{ message: { content: 'Summary' } }],
    web_search: [{ title: 'News', link: source.url, content: 'Snippet' }],
  });
  const link = connection(
    'https://open.bigmodel.cn/api/anthropic',
    'glm-5.3',
    'anthropic',
  );
  assert.equal(
    await nativeSearchCapability(link, signal(), async () => {
      throw new Error('the models endpoint is not the search contract');
    }),
    'unknown',
  );
  const result = await nativeWebSearch(link, 'query', 2, signal(), request);
  assert.equal(
    original[0]?.href,
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  );
  assert.equal(seen[0]?.headers.authorization, 'Bearer synthetic-test-key');
  assert.equal(seen[0]?.headers['x-api-key'], undefined);
  assert.equal(
    (seen[0]?.body.tools as { type?: string }[])?.[0]?.type,
    'web_search',
  );
  assert.equal(result.executed, true);
});

test('Gemini grounding stays on the official origin, keeps selected model and reads grounding evidence', async (t) => {
  const { request, seen, original } = await gateway(t, {
    modelVersion: 'gemini-returned',
    candidates: [
      {
        content: { parts: [{ text: 'Summary' }] },
        groundingMetadata: {
          webSearchQueries: ['query'],
          groundingChunks: [{ web: { uri: source.url, title: source.title } }],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 4,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 2,
      cachedContentTokenCount: 1,
    },
  });
  const charges: NativeSearchUsage[] = [];
  const result = await nativeWebSearch(
    connection(
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'gemini-selected',
    ),
    'query',
    2,
    signal(),
    request,
    (value) => charges.push(value),
  );
  assert.equal(
    original[0]?.origin,
    'https://generativelanguage.googleapis.com',
  );
  assert.equal(seen[0]?.url, '/v1beta/models/gemini-selected:generateContent');
  assert.equal(seen[0]?.headers['x-goog-api-key'], 'synthetic-test-key');
  assert.equal(seen[0]?.headers.authorization, undefined);
  assert.deepEqual(seen[0]?.body.tools, [{ google_search: {} }]);
  assert.equal(result.executed, true);
  assert.equal(charges[0]?.usage.output_tokens, 7);
});

test('Kimi uses the current origin and recommended independent search API with unknown search fees', async (t) => {
  const { request, seen } = await gateway(t, { search_results: [source] });
  const charges: NativeSearchUsage[] = [];
  const result = await nativeWebSearch(
    connection('https://api.moonshot.cn/v1', 'kimi-selected'),
    'query',
    2,
    signal(),
    request,
    (value) => charges.push(value),
  );
  assert.equal(seen[0]?.url, '/v1/tools/search');
  assert.deepEqual(seen[0]?.body, {
    text_query: 'query',
    limit: 2,
    timeout_seconds: 30,
    include_content: false,
  });
  assert.equal(result.executed, true);
  assert.equal(charges[0]?.toolFeeUnknown, true);
  assert.equal(charges[0]?.searchRequests, 1);
});

test('Groq only trusts structured browser results and never plain snippets in content', async (t) => {
  for (const shape of ['browser', 'search', 'plain']) {
    const { request, seen } = await gateway(t, {
      choices: [
        {
          message: {
            content: 'Browsed https://example.org/news',
            ...(shape !== 'plain'
              ? {
                  executed_tools: [
                    {
                      type: 'browser_search',
                      index: 0,
                      arguments: '{"query":"query"}',
                      output: 'Tool output',
                      ...(shape === 'browser'
                        ? {
                            browser_results: [
                              {
                                title: source.title,
                                url: source.url,
                                content: 'Snippet',
                              },
                            ],
                          }
                        : {
                            search_results: {
                              results: [
                                {
                                  title: source.title,
                                  url: source.url,
                                  content: 'Snippet',
                                },
                              ],
                            },
                          }),
                    },
                  ],
                }
              : {}),
          },
        },
      ],
    });
    const result = await nativeWebSearch(
      connection('https://api.groq.com/openai/v1', 'openai/gpt-oss-120b'),
      'query',
      2,
      signal(),
      request,
    );
    assert.equal(seen[0]?.url, '/openai/v1/chat/completions');
    assert.deepEqual(seen[0]?.body.tools, [{ type: 'browser_search' }]);
    assert.equal(result.executed, shape !== 'plain');
    if (result.executed) assert.equal(result.results[0]?.snippet, 'Snippet');
  }
});

test('Mistral uses a stateless Conversation with current model and tool references', async (t) => {
  const { request, seen } = await gateway(t, {
    outputs: [
      { type: 'tool.execution', name: 'web_search', completed_at: 123 },
      {
        type: 'message.output',
        model: 'mistral-served-snapshot',
        content: [
          { type: 'text', text: 'Summary' },
          { type: 'tool_reference', tool: 'web_search', ...source },
        ],
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 5 },
  });
  const charges: NativeSearchUsage[] = [];
  const result = await nativeWebSearch(
    connection('https://api.mistral.ai/v1', 'mistral-selected'),
    'query',
    2,
    signal(),
    request,
    (value) => charges.push(value),
  );
  assert.equal(seen[0]?.url, '/v1/conversations');
  assert.equal(seen[0]?.body.model, 'mistral-selected');
  assert.equal(seen[0]?.body.store, false);
  assert.equal(seen[0]?.body.agent_id, undefined);
  assert.equal(result.executed, true);
  assert.equal(charges[0]?.model, 'mistral-served-snapshot');
});

test('only explicit tool rejection is unsupported, including failed HTTP usage', async (t) => {
  for (const [status, detail, isUnsupported] of [
    [400, 'web_search is not supported', true],
    [404, 'route not found', false],
    [404, 'unknown model', false],
    [405, 'method not allowed', false],
    [501, 'not implemented', false],
    [404, 'web_search is not available', true],
    [405, 'web_search tool is not allowed', true],
    [422, 'unknown browser_search tool', true],
    [501, 'server tools are not supported', true],
    [401, 'invalid key', false],
    [403, 'web_search forbidden', false],
    [429, 'rate limited', false],
    [500, 'server failed', false],
  ] as const) {
    const { request } = await gateway(
      t,
      { error: { message: detail }, usage: tokens },
      status,
    );
    const charges: NativeSearchUsage[] = [];
    await assert.rejects(
      nativeWebSearch(
        connection('https://proxy.example/v1'),
        'query',
        2,
        signal(),
        request,
        (value) => charges.push(value),
      ),
      (caught: unknown) => {
        assert.equal(caught instanceof NativeSearchUnsupported, isUnsupported);
        return true;
      },
    );
    assert.equal(charges.length, 1);
    assert.equal(charges[0]?.usage.input_tokens, 31);
  }
  for (const status of [404, 405, 501]) {
    await assert.rejects(
      nativeWebSearch(
        connection('https://proxy.example/v1'),
        'query',
        2,
        signal(),
        async () => new Response('<html>proxy unavailable</html>', { status }),
      ),
      (caught: unknown) => {
        assert.equal(caught instanceof NativeSearchUnsupported, false);
        return true;
      },
    );
  }
});

test('unsupported presets send no request, cancellation retains its reason, and redirects are refused', async (t) => {
  const { request, seen } = await gateway(t, {});
  await assert.rejects(
    nativeWebSearch(
      connection('https://api.deepseek.com'),
      'query',
      2,
      signal(),
      request,
    ),
    NativeSearchUnsupported,
  );
  assert.equal(seen.length, 0);
  const controller = new AbortController();
  const reason = new Error('user cancelled');
  controller.abort(reason);
  await assert.rejects(
    nativeWebSearch(
      connection('https://proxy.example/v1'),
      'query',
      2,
      controller.signal,
      request,
    ),
    (caught: unknown) => caught === reason,
  );
  assert.equal(seen.length, 0);
  const server = createServer((_req, res) =>
    res.writeHead(307, { location: 'http://127.0.0.1:1/stolen-key' }).end(),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  await assert.rejects(
    nativeWebSearch(connection(url), 'query', 2, signal()),
    /fetch failed/,
  );
});

test('completed response usage survives cancellation immediately after JSON body is consumed', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel after response');
  const request: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode(JSON.stringify(responses())));
          stream.close();
          controller.abort(reason);
        },
      }),
    );
  const charges: NativeSearchUsage[] = [];
  await assert.rejects(
    nativeWebSearch(
      connection('https://proxy.example/v1'),
      'query',
      2,
      controller.signal,
      request,
      (value) => charges.push(value),
    ),
    (caught: unknown) => caught === reason,
  );
  assert.equal(charges.length, 1);
  assert.equal(charges[0]?.usage.input_tokens, 31);
});

test('xAI server citation URLs require completed execution and browsing actions do not inflate searches', async (t) => {
  for (const completed of [true, false]) {
    const { request } = await gateway(t, {
      output: [
        {
          type: 'web_search_call',
          status: completed ? 'completed' : 'in_progress',
          action: { type: 'open_page', url: source.url },
        },
      ],
      citations: [source.url],
    });
    const result = await nativeWebSearch(
      connection('https://api.x.ai/v1', 'grok-current'),
      'query',
      2,
      signal(),
      request,
    );
    assert.equal(result.executed, completed);
    assert.equal(result.results.length, completed ? 1 : 0);
    assert.equal(result.searchRequests, undefined);
  }
});

test('bounded JSON reader rejects oversized or interrupted response bodies', async () => {
  let cancelled = false;
  const oversized: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  await assert.rejects(
    nativeWebSearch(
      connection('https://proxy.example/v1'),
      'query',
      2,
      signal(),
      oversized,
    ),
    /exceeds 2 MiB/,
  );
  assert.equal(cancelled, true);
  const interrupted: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"output":'));
          stream.error(new Error('socket disconnected'));
        },
      }),
    );
  await assert.rejects(
    nativeWebSearch(
      connection('https://proxy.example/v1'),
      'query',
      2,
      signal(),
      interrupted,
    ),
    /socket disconnected/,
  );
});

test('ignored search with missing usage still records an unknown auxiliary charge', async (t) => {
  const { request } = await gateway(t, {
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'An unverified answer.' }],
      },
    ],
  });
  const charges: NativeSearchUsage[] = [];
  const result = await nativeWebSearch(
    connection('https://proxy.example/v1'),
    'query',
    2,
    signal(),
    request,
    (value) => charges.push(value),
  );
  assert.equal(result.executed, false);
  assert.equal(charges.length, 1);
  assert.equal(charges[0]?.usage.input_tokens, 0);
  assert.equal(charges[0]?.toolFeeUnknown, true);
});
