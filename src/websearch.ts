import { decodeHTML } from 'entities';
import { networkError, networkErrorReason } from './net.js';
export type FetchFunction = typeof fetch;
export function stripTags(text: string): string {
  return decodeHTML(
    text
      .replace(
        /<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi,
        '',
      )
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/gu, ' ')
    .trim();
}
export function parseSearchHtml(
  raw: string,
  query: string,
  numResults = 5,
  year = new Date().getUTCFullYear(),
): string {
  const html = raw.replace(
    /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi,
    '',
  );
  // Search endpoints can answer a challenge with HTTP 200 or 202. Treating
  // such a page as an empty search would suppress the other endpoint.
  if (
    /<(?:form|div|section|input)\b[^>]*(?:action|id|class)\s*=\s*(["'])[^"']*(?:anomaly(?:\.js|-modal)|captcha|challenge-form)[^"']*\1/i.test(
      html,
    )
  )
    throw new Error('DuckDuckGo returned a CAPTCHA or bot challenge');
  const attribute = (tag: string, name: string): string | undefined => {
    const match = tag.match(
      new RegExp(
        `(?:^|[\\s<])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
        'i',
      ),
    );
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    return value === undefined ? undefined : decodeHTML(value);
  };
  const hasClass = (tag: string, names: string[]): boolean =>
    (attribute(tag, 'class') ?? '')
      .split(/\s+/u)
      .some((value) => names.includes(value));
  const anchors = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].filter(
    (match) =>
      hasClass(match[0].slice(0, match[0].indexOf('>') + 1), [
        'result__a',
        'result-link',
      ]),
  );
  const links: { url: string; title: string; snippet?: string }[] = [];
  for (const [index, match] of anchors.entries()) {
    const openingEnd = match[0].indexOf('>') + 1;
    const opening = match[0].slice(0, openingEnd);
    const href = attribute(opening, 'href')?.trim();
    if (!href) continue;
    try {
      let url = new URL(href, 'https://duckduckgo.com');
      if (
        (url.hostname === 'duckduckgo.com' ||
          url.hostname.endsWith('.duckduckgo.com')) &&
        url.searchParams.has('uddg')
      )
        url = new URL(url.searchParams.get('uddg')!);
      if (
        url.hostname === 'duckduckgo.com' ||
        url.hostname.endsWith('.duckduckgo.com')
      )
        continue;
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      // Lite puts the snippet in the following table row. HTML puts it in
      // the same result div. Bound the scan by the next result title so a
      // missing snippet cannot steal another result's text.
      const remainder = html.slice(
        match.index! + match[0].length,
        anchors[index + 1]?.index ?? html.length,
      );
      let snippet: string | undefined;
      for (const candidate of remainder.matchAll(/<(a|td|div)\b[^>]*>/gi)) {
        if (hasClass(candidate[0], ['result__snippet', 'result-snippet'])) {
          const content = remainder.slice(
            candidate.index! + candidate[0].length,
          );
          const end = content.search(new RegExp(`</${candidate[1]}>`, 'i'));
          if (end >= 0) snippet = stripTags(content.slice(0, end));
          break;
        }
      }
      links.push({
        url: url.toString(),
        title: stripTags(match[0].slice(openingEnd, -4)) || url.toString(),
        snippet,
      });
    } catch {
      /* Ignore malformed result links, never arbitrary navigation anchors. */
    }
  }
  if (!links.length) {
    const empty = [...html.matchAll(/<[^>]+>/g)].some((match) =>
      (attribute(match[0], 'class') ?? '')
        .split(/\s+/u)
        .some((value) => /^no-results(?:__[-\w]+)?$/i.test(value)),
    );
    if (empty && /\bno results(?: found)?\b/i.test(stripTags(html)))
      return `No results for ${JSON.stringify(query)} (source: DuckDuckGo).`;
    throw new Error('DuckDuckGo returned an unrecognized search page');
  }
  const lines = [
    `Web search results for ${JSON.stringify(query)} (as of ${year}):`,
    '',
  ];
  links
    .slice(0, Math.max(1, Math.min(10, numResults)))
    .forEach((link, index) => {
      lines.push(`${index + 1}. ${link.title}`, `   ${link.url}`);
      if (link.snippet) lines.push('   ' + link.snippet);
      lines.push('');
    });
  return lines.join('\n').trimEnd();
}
export async function limitedBody(
  response: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (size + next.value.byteLength > limit) {
        chunks.push(next.value.subarray(0, Math.max(0, limit - size)));
        truncated = true;
        break;
      }
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}
/** The useful causes of both failed requests and interrupted response streams. */
export function fetchErrorReason(error: unknown): string {
  return networkErrorReason(error);
}
/** A network failure the machine may fix with a proxy, as opposed to a site
 * that answered with an error of its own. */
export function unreachableReason(reason: string): boolean {
  return (
    /ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|TimeoutError|aborted due to timeout|socket hang up/i.test(
      reason,
    ) || reason === 'fetch failed'
  );
}
const PROXY_HINT =
  '; the endpoint is unreachable from this network — if you go through a proxy, set HTTPS_PROXY before starting Circle (see docs/environment-variables.md)';
function webError(error: unknown, host: string): Error {
  const result = networkError(error, host);
  if (unreachableReason(fetchErrorReason(error))) result.message += PROXY_HINT;
  return result;
}
export async function webSearch(
  query: string,
  signal: AbortSignal,
  numResults = 5,
  request: FetchFunction = fetch,
): Promise<string> {
  const text = query.trim();
  if (!text) throw new Error('query is required');
  const failures: Error[] = [];
  for (const host of [
    'https://lite.duckduckgo.com/lite/',
    'https://html.duckduckgo.com/html/',
  ]) {
    signal.throwIfAborted();
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    try {
      const url = new URL(host);
      url.searchParams.set('q', text);
      const response = await request(url, {
        signal: attemptSignal,
        headers: {
          'User-Agent': 'Circle/0.1 (+local coding agent)',
          Accept: 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await limitedBody(response, 500000);
      if (body.text) return parseSearchHtml(body.text, text, numResults);
      throw new Error('empty body');
    } catch (error) {
      signal.throwIfAborted();
      failures.push(
        webError(attemptSignal.aborted ? attemptSignal.reason : error, host),
      );
    }
  }
  throw new Error(
    'search failed: ' + failures.map((error) => error.message).join('; '),
    { cause: new AggregateError(failures, 'both search endpoints failed') },
  );
}
export function blockedHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !value ||
    ['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'].includes(value) ||
    value.endsWith('.local') ||
    value.endsWith('.localhost')
  )
    return true;
  if (
    /^(?:127\.|169\.254\.|10\.|192\.168\.)/.test(value) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(value) ||
    /^(?:fc|fd)[a-f0-9]{2}:|^fe[89ab][a-f0-9]:/.test(value)
  )
    return true;
  return false;
}
export async function webFetch(
  raw: string,
  format: string,
  signal: AbortSignal,
  request: FetchFunction = fetch,
): Promise<string> {
  let url = new URL(raw.trim());
  if (url.protocol === 'http:') url.protocol = 'https:';
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 10; redirect++) {
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('use an http(s) URL without credentials');
    if (blockedHost(url.hostname))
      throw new Error(`refusing to fetch local/private host '${url.hostname}'`);
    signal.throwIfAborted();
    try {
      response = await request(url, {
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        headers: {
          'User-Agent': 'Circle/0.1 (+local coding agent)',
          Accept: 'text/*,application/json',
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      throw webError(error, url.host);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    try {
      await response.body?.cancel();
    } catch (error) {
      signal.throwIfAborted();
      throw webError(error, url.host);
    }
    if (!location) throw new Error('redirect has no location');
    url = new URL(location, url);
    if (redirect === 10) throw new Error('too many redirects');
  }
  if (!response?.ok)
    throw webError(
      Object.assign(new Error(`HTTP ${response?.status}`), {
        status: response?.status,
      }),
      url.host,
    );
  let body: Awaited<ReturnType<typeof limitedBody>>;
  try {
    body = await limitedBody(response, 500000);
  } catch (error) {
    signal.throwIfAborted();
    throw webError(error, url.host);
  }
  const type = response.headers.get('content-type')?.toLowerCase() || 'unknown';
  let rendered = body.text;
  if (type.includes('json')) {
    try {
      rendered = JSON.stringify(JSON.parse(body.text), null, 2);
    } catch {
      /* A truncated JSON document remains text. */
    }
  } else if (
    format !== 'html' &&
    (type.includes('html') || /<html/i.test(body.text.slice(0, 200)))
  )
    rendered = stripTags(body.text);
  return `URL: ${url}\nContent-Type: ${type}\n${body.truncated ? '(truncated to 500000 bytes)\n' : ''}\n${rendered}`;
}
