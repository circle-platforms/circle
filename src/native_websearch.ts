import { searchProvider, type NativeSearchAdapter } from './providers.js';
import type { Usage } from './types.js';

export interface NativeSearchConnection {
  baseUrl: string;
  protocol: 'openai' | 'anthropic';
  model: string;
  apiKey: string;
}
export interface NativeSearchResult {
  provider: string;
  results: Array<{ url: string; title: string; snippet?: string }>;
  summary?: string;
  /** A structured, successful server search, including a real empty result. */
  executed: boolean;
  usage?: Usage;
  model?: string;
  searchRequests?: number;
}
export interface NativeSearchUsage {
  model: string;
  usage: Usage;
  searchRequests?: number;
  toolFeeUnknown: true;
}
export class NativeSearchUnsupported extends Error {
  override name = 'NativeSearchUnsupported';
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function base(connection: NativeSearchConnection): URL {
  const url = new URL(connection.baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid search API base URL');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}
function endpoint(connection: NativeSearchConnection, suffix: string): URL {
  const url = base(connection);
  url.pathname = url.pathname.replace(/\/+$/, '') + suffix;
  return url;
}
function anthropicEndpoint(
  connection: NativeSearchConnection,
  suffix: string,
): URL {
  const url = base(connection);
  url.pathname =
    url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/' + suffix;
  return url;
}
function headers(connection: NativeSearchConnection): Record<string, string> {
  return connection.protocol === 'anthropic'
    ? {
        'content-type': 'application/json',
        'x-api-key': connection.apiKey,
        'anthropic-version': '2023-06-01',
      }
    : {
        'content-type': 'application/json',
        authorization: `Bearer ${connection.apiKey}`,
      };
}
function unsupported(status: number, detail: string): boolean {
  return (
    [400, 404, 405, 422, 501].includes(status) &&
    /(?:web.?search|browser_search|google_search|server.?tool|tools?)/i.test(
      detail,
    ) &&
    /(?:unsupported|not.support|not.available|unknown|unrecognized|invalid.tool|not.allowed|does.not.support)/i.test(
      detail,
    )
  );
}
async function jsonRequest(
  url: URL,
  init: RequestInit,
  request: typeof fetch,
  onFailureBody?: (body: Json) => void,
): Promise<Json> {
  // A gateway must not redirect a configured credential to another origin.
  const response = await request(url, { ...init, redirect: 'error' });
  if (!response.body) throw new Error('empty native search response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new Error('native search response exceeds 2 MiB');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  let parsed: Json;
  try {
    parsed = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    if (!response.ok && unsupported(response.status, ''))
      throw new NativeSearchUnsupported(
        `native search http ${response.status}`,
      );
    throw new Error(
      `native search http ${response.status}: invalid JSON response`,
    );
  }
  if (!response.ok) {
    onFailureBody?.(parsed);
    const error = record(parsed.error);
    const detail = [error.type, error.code, error.message, parsed.message]
      .map(text)
      .filter(Boolean)
      .join(': ')
      .slice(0, 500);
    const message = `native search http ${response.status}${detail ? ': ' + detail : ''}`;
    if (unsupported(response.status, detail))
      throw new NativeSearchUnsupported(message);
    throw new Error(message);
  }
  return parsed;
}

/** Only the Messages API has a standard, free search capability declaration. */
export async function nativeSearchCapability(
  connection: NativeSearchConnection,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<'supported' | 'unsupported' | 'unknown'> {
  signal.throwIfAborted();
  const provider = searchProvider(
    connection.baseUrl,
    connection.protocol,
    connection.model,
  );
  if (provider.adapter === 'unsupported') return 'unsupported';
  // Zhipu's Anthropic route has no server-tool declaration. Search is the
  // OpenAI paas contract, probed by calling it rather than the models endpoint.
  if (provider.adapter === 'zhipu') return 'unknown';
  if (connection.protocol !== 'anthropic') return 'unknown';
  try {
    const body = await jsonRequest(
      anthropicEndpoint(
        connection,
        'models/' + encodeURIComponent(connection.model),
      ),
      {
        headers: headers(connection),
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      },
      request,
    );
    const supported = record(
      record(record(body.capabilities).server_tools).web_search,
    ).supported;
    return supported === true
      ? 'supported'
      : supported === false
        ? 'unsupported'
        : 'unknown';
  } catch {
    signal.throwIfAborted();
    // A missing/older Models route says nothing about search on Messages.
    return 'unknown';
  }
}

function usage(body: Json): Usage | undefined {
  const raw = record(body.usage ?? body.usageMetadata);
  if (!Object.keys(raw).length) return undefined;
  const token = record(raw.token_usage);
  const source = Object.keys(token).length ? token : raw;
  return {
    input_tokens:
      count(
        source.input_tokens ?? source.prompt_tokens ?? source.promptTokenCount,
      ) +
      count(source.cache_read_input_tokens) +
      count(source.cache_creation_input_tokens),
    output_tokens:
      count(
        source.output_tokens ??
          source.completion_tokens ??
          source.candidatesTokenCount,
      ) + count(source.thoughtsTokenCount),
    cache_read_tokens: count(
      source.cache_read_input_tokens ??
        source.cachedContentTokenCount ??
        record(source.input_tokens_details ?? source.prompt_tokens_details)
          .cached_tokens,
    ),
    cache_write_tokens: count(source.cache_creation_input_tokens),
    ...(count(record(source.cache_creation).ephemeral_1h_input_tokens)
      ? {
          cache_write_1h_tokens: count(
            record(source.cache_creation).ephemeral_1h_input_tokens,
          ),
        }
      : {}),
  };
}
function addResult(
  results: NativeSearchResult['results'],
  value: unknown,
): void {
  const source = record(value);
  const rawUrl = text(source.url ?? source.uri ?? source.link);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return;
  if (results.some((item) => item.url === rawUrl)) return;
  const snippet = text(
    source.snippet ?? source.cited_text ?? source.content ?? source.summary,
  );
  results.push({
    url: rawUrl,
    title: text(source.title) || url.hostname,
    ...(snippet ? { snippet: snippet.slice(0, 4000) } : {}),
  });
}
function addResults(
  results: NativeSearchResult['results'],
  sources: unknown[],
): void {
  const validated: NativeSearchResult['results'] = [];
  for (const source of sources) addResult(validated, source);
  if (sources.length && !validated.length)
    throw new Error('native search returned malformed sources');
  for (const source of validated) addResult(results, source);
}
function responsesResult(body: Json, result: NativeSearchResult): void {
  let searches = 0;
  let completedCalls = 0;
  for (const raw of array(body.output)) {
    const item = record(raw);
    if (item.type === 'web_search_call') {
      if (item.status === 'failed')
        throw new Error('native search tool failed');
      if (item.status !== 'completed') continue;
      completedCalls++;
      const action = record(item.action);
      if (action.type === 'search') searches++;
      // An explicit source array records successful empty search results too.
      if (Array.isArray(action.sources)) {
        result.executed = true;
        addResults(result.results, action.sources);
      }
    }
    if (item.type === 'message') {
      for (const rawContent of array(item.content)) {
        const content = record(rawContent);
        if (content.type === 'output_text') {
          result.summary = [result.summary, text(content.text)]
            .filter(Boolean)
            .join('\n');
          if (
            completedCalls ||
            array(body.output).some(
              (entry) =>
                record(entry).type === 'web_search_call' &&
                record(entry).status === 'completed',
            )
          ) {
            for (const annotation of array(content.annotations)) {
              if (record(annotation).type === 'url_citation')
                addResult(result.results, annotation);
            }
          }
        }
      }
    }
  }
  if (completedCalls && Array.isArray(body.citations)) {
    addResults(
      result.results,
      body.citations.map((citation) =>
        typeof citation === 'string' ? { url: citation } : citation,
      ),
    );
  }
  if (completedCalls && result.results.length) result.executed = true;
  result.searchRequests =
    count(record(record(record(body.usage).x_tools).web_search).count) ||
    count(
      record(record(record(body.usage).tool_usage).web_search).num_requests,
    ) ||
    count(
      record(record(body.usage).server_side_tool_usage_details)
        .web_search_calls,
    ) ||
    searches ||
    undefined;
}
function anthropicResult(body: Json, result: NativeSearchResult): void {
  const blocks = array(body.content).map(record);
  const calls = new Set(
    blocks
      .filter(
        (item) => item.type === 'server_tool_use' && item.name === 'web_search',
      )
      .map((item) => text(item.id)),
  );
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result') {
      const error = record(block.content);
      if (error.type === 'web_search_tool_result_error') {
        const code = text(error.error_code);
        if (['unsupported_tool', 'tool_not_supported'].includes(code))
          throw new NativeSearchUnsupported('native search tool: ' + code);
        throw new Error('native search tool: ' + (code || 'failed'));
      }
      if (calls.has(text(block.tool_use_id)) && Array.isArray(block.content)) {
        result.executed = true;
        addResults(
          result.results,
          block.content.map((source) =>
            record(source).type === 'web_search_result' ? source : {},
          ),
        );
      }
    }
    if (block.type === 'text') {
      result.summary = [result.summary, text(block.text)]
        .filter(Boolean)
        .join('\n');
      for (const citation of array(block.citations)) {
        if (
          record(citation).type === 'web_search_result_location' &&
          calls.size
        )
          addResult(result.results, citation);
      }
    }
  }
  result.searchRequests =
    count(record(record(body.usage).server_tool_use).web_search_requests) ||
    calls.size ||
    undefined;
}
function chatResult(
  body: Json,
  result: NativeSearchResult,
  adapter: NativeSearchAdapter,
): void {
  const choice = record(array(body.choices)[0]);
  const message = record(choice.message);
  result.summary = text(message.content) || undefined;
  if (adapter === 'bailian') {
    const search = record(body.search_info ?? record(body.output).search_info);
    if (Array.isArray(search.search_results)) {
      result.executed = true;
      addResults(result.results, search.search_results);
    }
    result.searchRequests =
      count(record(record(record(body.usage).plugins).search).count) ||
      undefined;
    // Chat's ordinary content and token counts do not prove a search happened.
  } else if (adapter === 'zhipu') {
    if (Array.isArray(body.web_search)) {
      result.executed = true;
      addResults(result.results, body.web_search);
    }
  } else {
    for (const raw of array(
      message.executed_tools ?? record(body.x_groq).executed_tools,
    )) {
      const tool = record(raw);
      if (tool.type !== 'browser_search' && tool.name !== 'browser_search')
        continue;
      if (tool.error || tool.status === 'failed')
        throw new Error('native browser search failed');
      // Groq's generated OpenAPI SDK exposes browser_results and nested
      // search_results.results; output itself is an unstructured string.
      const sources =
        tool.browser_results ?? record(tool.search_results).results;
      if (Array.isArray(sources)) {
        result.executed = true;
        addResults(result.results, sources);
      }
      result.searchRequests = (result.searchRequests ?? 0) + 1;
    }
  }
}
function geminiResult(body: Json, result: NativeSearchResult): void {
  for (const raw of array(body.candidates)) {
    const candidate = record(raw);
    const grounding = record(candidate.groundingMetadata);
    const queries = array(grounding.webSearchQueries).filter(
      (query) => typeof query === 'string',
    );
    if (queries.length && Array.isArray(grounding.groundingChunks)) {
      result.executed = true;
      addResults(
        result.results,
        grounding.groundingChunks.map((chunk) => record(chunk).web),
      );
    }
    result.searchRequests = (result.searchRequests ?? 0) + queries.length;
    for (const part of array(record(candidate.content).parts)) {
      if (!record(part).thought)
        result.summary = [result.summary, text(record(part).text)]
          .filter(Boolean)
          .join('\n');
    }
  }
}
function mistralResult(body: Json, result: NativeSearchResult): void {
  const outputs = array(body.outputs).map(record);
  const calls = outputs.filter(
    (item) => item.type === 'tool.execution' && item.name === 'web_search',
  );
  if (calls.some((item) => item.error || item.status === 'failed'))
    throw new Error('native search tool failed');
  const completed = calls.filter(
    (item) => item.completed_at || item.status === 'completed',
  );
  for (const output of outputs) {
    if (output.type !== 'message.output') continue;
    if (text(output.model)) result.model = text(output.model);
    if (typeof output.content === 'string') result.summary = output.content;
    for (const rawContent of array(output.content)) {
      const content = record(rawContent);
      if (content.type === 'text')
        result.summary = [result.summary, text(content.text)]
          .filter(Boolean)
          .join('\n');
      if (
        completed.length &&
        content.type === 'tool_reference' &&
        content.tool === 'web_search'
      )
        addResult(result.results, content);
    }
  }
  if (completed.length && result.results.length) result.executed = true;
  result.searchRequests = calls.length || undefined;
}

// https://help.aliyun.com/zh/model-studio/web-search: Chat does not return
// sources, whereas these Responses models return web_search_call.action.sources.
function bailianResponses(model: string): boolean {
  return (
    (/^qwen3\.(?:5|7|8)-/.test(model) &&
      (!model.includes('omni') || model === 'qwen3.8-omni-flash')) ||
    /^qwen3\.6-(?:plus|flash|35b-a3b)(?:-|$)/.test(model) ||
    [
      'qwen3-max',
      'qwen3-max-2026-01-23',
      'deepseek-v4-flash-0731',
      'deepseek-v4-pro',
      'deepseek-v4-pro-0813',
      'glm-5.2',
      'kimi-k3',
    ].includes(model)
  );
}

/** Execute one auxiliary search request using only the calling model's snapshot. */
export async function nativeWebSearch(
  connection: NativeSearchConnection,
  query: string,
  numResults: number,
  signal: AbortSignal,
  request: typeof fetch = fetch,
  onUsage?: (value: NativeSearchUsage) => void,
): Promise<NativeSearchResult> {
  signal.throwIfAborted();
  const provider = searchProvider(
    connection.baseUrl,
    connection.protocol,
    connection.model,
  );
  if (provider.adapter === 'unsupported')
    throw new NativeSearchUnsupported(
      `${provider.id} has no supported native search contract for this model and protocol`,
    );
  let adapter = provider.adapter;
  if (adapter === 'bailian' && bailianResponses(connection.model))
    adapter = 'responses';
  const prompt = `Search the web for the following query. Return up to ${numResults} useful sources with brief factual snippets and source citations. You must perform a web search; do not answer from memory.\n\n${query}`;
  let url: URL;
  let body: Json;
  const requestHeaders = headers(connection);
  switch (adapter) {
    case 'responses':
    case 'ark-responses':
      url = endpoint(connection, '/responses');
      if (provider.id === 'openai' && base(connection).pathname === '/')
        url = endpoint(connection, '/v1/responses');
      body = {
        model: connection.model,
        input: prompt,
        tools: [
          {
            type: 'web_search',
            ...(adapter === 'ark-responses' ? { sources: ['doubao'] } : {}),
          },
        ],
        tool_choice: 'required',
        store: false,
        max_output_tokens: 4096,
      };
      if (['openai', 'custom', 'xai'].includes(provider.id))
        body.include = ['web_search_call.action.sources'];
      break;
    case 'anthropic':
      url = anthropicEndpoint(connection, 'messages');
      body = {
        model: connection.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
        ],
        tool_choice: { type: 'auto' },
      };
      break;
    case 'gemini': {
      url = base(connection);
      url.pathname =
        url.pathname.replace(/\/openai$/, '') +
        '/models/' +
        encodeURIComponent(connection.model.replace(/^models\//, '')) +
        ':generateContent';
      delete requestHeaders.authorization;
      requestHeaders['x-goog-api-key'] = connection.apiKey;
      body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 4096 },
      };
      break;
    }
    case 'kimi':
      url = endpoint(connection, '/tools/search');
      body = {
        text_query: query,
        limit: numResults,
        timeout_seconds: 30,
        include_content: false,
      };
      break;
    case 'mistral':
      url = endpoint(connection, '/conversations');
      body = {
        model: connection.model,
        inputs: prompt,
        tools: [{ type: 'web_search' }],
        store: false,
        completion_args: { max_tokens: 4096 },
      };
      break;
    default:
      url = endpoint(connection, '/chat/completions');
      body = {
        model: connection.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      };
      if (adapter === 'bailian') {
        body.enable_search = true;
        body.search_options = { forced_search: true, enable_source: true };
      } else if (adapter === 'zhipu') {
        // GLM on the Anthropic base URL still searches through paas v4 chat completions.
        if (
          connection.protocol === 'anthropic' &&
          new URL(connection.baseUrl).hostname === 'open.bigmodel.cn'
        ) {
          url = new URL(
            'https://open.bigmodel.cn/api/paas/v4/chat/completions',
          );
          delete requestHeaders['x-api-key'];
          delete requestHeaders['anthropic-version'];
          requestHeaders.authorization = `Bearer ${connection.apiKey}`;
        }
        body.tools = [
          {
            type: 'web_search',
            web_search: {
              enable: true,
              search_engine: 'search_pro',
              search_result: true,
            },
          },
        ];
      } else {
        body.tools = [{ type: 'browser_search' }];
        body.tool_choice = 'required';
        body.max_completion_tokens = 4096;
      }
  }
  const data = await jsonRequest(
    url,
    {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal,
    },
    request,
    (failed) => {
      const tokens = usage(failed);
      if (tokens)
        onUsage?.({
          model: text(failed.model ?? failed.modelVersion) || connection.model,
          usage: tokens,
          toolFeeUnknown: true,
        });
    },
  );
  const result: NativeSearchResult = {
    provider: provider.id,
    results: [],
    executed: false,
    model: text(data.model ?? data.modelVersion) || connection.model,
    usage: usage(data),
  };
  // Record chargeable tokens before validating embedded errors or execution.
  let reported = false;
  const reportUsage = () => {
    if (reported) return;
    reported = true;
    onUsage?.({
      model: result.model!,
      usage: result.usage ?? {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
      },
      searchRequests: result.searchRequests,
      toolFeeUnknown: true,
    });
  };
  try {
    switch (adapter) {
      case 'responses':
      case 'ark-responses':
        responsesResult(data, result);
        break;
      case 'anthropic':
        anthropicResult(data, result);
        break;
      case 'gemini':
        geminiResult(data, result);
        break;
      case 'mistral':
        mistralResult(data, result);
        break;
      case 'kimi':
        if (Array.isArray(data.search_results)) {
          result.executed = true;
          result.searchRequests = 1;
          addResults(result.results, data.search_results);
        }
        break;
      default:
        chatResult(data, result, adapter);
    }
    signal.throwIfAborted();
    if (data.error)
      throw new Error(
        'native search: ' +
          (text(record(data.error).message) || 'provider returned an error'),
      );
    result.results = result.results.slice(0, numResults);
    return result;
  } finally {
    reportUsage();
  }
}
