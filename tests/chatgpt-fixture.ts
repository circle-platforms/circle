// A local stand-in for OpenAI's Sign in with ChatGPT endpoints and the plan's Responses
// route, shared by the core and desktop checks. Never a real account or endpoint.
import {
  createHash,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { zstdDecompressSync } from 'node:zlib';

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(key: KeyObject, claims: Record<string, unknown>, kid = 'k1') {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64(claims);
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(key).toString('base64url')}`;
}
export type Body = Record<string, unknown>;
export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  headers: IncomingMessage['headers'];
  json?: Body;
}
/**
 * OpenAI's Sign in with ChatGPT endpoints and the plan's Responses route, as documented:
 * discovery, keys, dynamic registration, code and rotating refresh grants, revocation,
 * the account's model list and a Responses stream.
 */
export async function openai(
  t: { after(fn: () => void | Promise<void>): void },
  options: {
    scope?: string;
    deny?: boolean;
    issuedClient?: string;
    respond?: (seen: Seen, res: ServerResponse) => boolean;
    nonce?: (nonce: string) => string;
  } = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'k1',
    alg: 'RS256',
  };
  const seen: Seen[] = [];
  const codes = new Map<
    string,
    { challenge: string; nonce: string; client: string; redirect: string }
  >();
  const state = {
    refresh: new Set<string>(),
    issued: 0,
    revoked: [] as string[],
    access: new Set<string>(),
  };
  let base = '';
  const server = createServer(async (req, res) => {
    let raw = Buffer.alloc(0);
    for await (const chunk of req) raw = Buffer.concat([raw, chunk]);
    const url = new URL(req.url ?? '/', base);
    const text =
      req.headers['content-encoding'] === 'zstd'
        ? zstdDecompressSync(raw).toString('utf8')
        : raw.toString('utf8');
    const entry: Seen = {
      method: req.method ?? '',
      path: url.pathname,
      query: url.searchParams,
      form: new URLSearchParams(
        req.headers['content-type']?.includes('form') ? text : '',
      ),
      headers: req.headers,
      ...(req.headers['content-type']?.includes('json') && text
        ? { json: JSON.parse(text) as Body }
        : {}),
    };
    seen.push(entry);
    if (options.respond?.(entry, res)) return;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const tokens = (client: string, nonce?: string) => {
      const n = ++state.issued;
      const access = `access-${n}`;
      const refresh = `refresh-${n}`;
      state.access.add(access);
      state.refresh.add(refresh);
      return {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: 3600,
        scope:
          options.scope ??
          'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        ...(nonce !== undefined
          ? {
              id_token: jwt(privateKey, {
                iss: base,
                aud: client,
                sub: 'user-1',
                email: 'person@example.com',
                nonce: options.nonce?.(nonce) ?? nonce,
                exp: Math.floor(Date.now() / 1000) + 3600,
              }),
            }
          : {}),
      };
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer: base,
        jwks_uri: `${base}/jwks`,
        revocation_endpoint: `${base}/revoke`,
      });
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/api/accounts/authorize') {
      const q = url.searchParams;
      const redirect = new URL(q.get('redirect_uri')!);
      const fresh = q.get('client_id') === 'dynamic_agent_client';
      const client = fresh
        ? (options.issuedClient ?? 'oaiapp_issued')
        : q.get('client_id')!;
      if (options.deny) {
        redirect.searchParams.set('error', 'access_denied');
      } else {
        const code = `code-${seen.length}`;
        codes.set(code, {
          challenge: q.get('code_challenge')!,
          nonce: q.get('nonce')!,
          client,
          redirect: q.get('redirect_uri')!,
        });
        redirect.searchParams.set('code', code);
        if (fresh) redirect.searchParams.set('client_id', client);
      }
      redirect.searchParams.set('state', q.get('state')!);
      res.writeHead(302, { Location: redirect.href });
      return res.end();
    }
    if (url.pathname === '/api/accounts/oauth/token') {
      const form = entry.form;
      if (form.get('resource') !== 'https://api.openai.com/v1')
        return json(400, { error: 'invalid_target' });
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code')!);
        codes.delete(form.get('code')!);
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (
          !grant ||
          grant.challenge !== challenge ||
          grant.client !== form.get('client_id') ||
          grant.redirect !== form.get('redirect_uri')
        )
          return json(400, { error: 'invalid_grant' });
        return json(200, tokens(grant.client, grant.nonce));
      }
      if (form.get('grant_type') === 'refresh_token') {
        const presented = form.get('refresh_token')!;
        if (!state.refresh.has(presented))
          return json(400, { error: 'refresh_token_reused' });
        state.refresh.delete(presented);
        return json(200, tokens(form.get('client_id')!));
      }
    }
    if (url.pathname === '/revoke') {
      state.revoked.push(entry.form.get('token')!);
      state.refresh.delete(entry.form.get('token')!);
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === '/v1/models')
      return json(200, {
        models: [
          {
            slug: 'gpt-6.1-sol',
            display_name: 'Sol',
            visibility: 'list',
            supported_in_api: true,
          },
          {
            slug: 'internal',
            display_name: 'Hidden',
            visibility: 'hide',
            supported_in_api: true,
          },
        ],
      });
    if (url.pathname === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'm',
          delta: 'hello',
        },
        {
          type: 'response.completed',
          response: {
            id: 'r',
            model: 'gpt-6.1-sol',
            status: 'completed',
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      return res.end();
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  /** The system browser: follows the authorization to the loopback callback. */
  const browser = async (url: string) => {
    const response = await fetch(url, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (location) await fetch(location);
  };
  return { base, seen, state, browser, privateKey };
}
