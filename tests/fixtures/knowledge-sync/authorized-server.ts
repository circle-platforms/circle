// Synthetic OAuth/MCP + sync peer. No Hub server or real identity provider is imported.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { FakeSyncServer } from './fake-server.js';
import { McpAuthProvider, redirectPort } from '../../../src/mcp_auth.js';

export interface TeamDocument {
  id: string;
  version: string;
  title: string;
  path: string;
  markdown: string;
  space?: string;
  enabled?: boolean;
  auto?: boolean;
}
export class AuthorizedServer {
  readonly codes = new Map<string, { challenge: string; redirect: string }>();
  readonly peer: FakeSyncServer;
  readonly requests: {
    path: string;
    headers: Record<string, unknown>;
    body: any;
  }[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly memoryQueries: any[] = [];
  readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => res.destroy());
  });
  origin = '';
  token = 'synthetic-valid-access';
  refresh = 'synthetic-refresh';
  refreshFails = false;
  rotatesRefresh = true;
  gateRefresh: (() => Promise<void>) | undefined;
  memoryHook: ((query: any) => void) | undefined;
  documents: TeamDocument[] = [];
  pageItems = 1;
  chunkBytes = 6;
  constructor(home: string) {
    this.peer = new FakeSyncServer(home);
    this.peer.now = Date.now();
  }
  async start() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    this.peer.origin = this.origin;
    this.peer.token = this.token;
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.peer.store.close();
  }
  async seed(home: string, expires = 3600) {
    const url = this.origin + '/mcp',
      port = await redirectPort(home, url),
      provider = new McpAuthProvider(home, url, port);
    provider.saveClientInformation({
      client_id: 'synthetic-client',
      issuer: this.origin,
    });
    provider.saveDiscoveryState({
      authorizationServerUrl: this.origin,
      resourceMetadata: { resource: url, authorization_servers: [this.origin] },
      authorizationServerMetadata: {
        issuer: this.origin,
        authorization_endpoint: this.origin + '/authorize',
        token_endpoint: this.origin + '/token',
        response_types_supported: ['code'],
        grant_types_supported: ['refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
    provider.saveTokens({
      access_token: 'synthetic-expired-access',
      refresh_token: this.refresh,
      token_type: 'Bearer',
      issuer: this.origin,
      expires_in: expires,
    });
    return provider;
  }
  private metadata(doc: TeamDocument) {
    return {
      document: doc.id,
      version: doc.version,
      space: doc.space ?? 'team',
      title: doc.title,
      path: doc.path,
      state: doc.enabled === false ? 'disabled' : 'enabled',
      bytes: Buffer.byteLength(doc.markdown),
      updated_at: '2026-11-03T00:00:00Z',
      updated_by: 'synthetic-user',
      auto_load_allowed: doc.auto !== false,
    };
  }
  private async handle(req: any, res: any) {
    const url = new URL(req.url, this.origin);
    if (url.pathname.startsWith('/api/sync/')) {
      this.peer.server.emit('request', req, res);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const raw = Buffer.concat(chunks).toString();
    const json = (status: number, body: unknown) =>
      res
        .writeHead(status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        })
        .end(JSON.stringify(body));
    const body = raw && url.pathname !== '/token' ? JSON.parse(raw) : raw;
    this.requests.push({ path: url.pathname, headers: req.headers, body });
    if (url.pathname === '/token') {
      const form = new URLSearchParams(raw);
      this.tokenRequests.push(form);
      await this.gateRefresh?.();
      if (form.get('grant_type') === 'authorization_code') {
        const code = this.codes.get(form.get('code') ?? '');
        if (
          !code ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== code.challenge ||
          form.get('redirect_uri') !== code.redirect
        )
          return json(400, { error: 'invalid_grant' });
        this.codes.delete(form.get('code')!);
      } else if (
        this.refreshFails ||
        form.get('refresh_token') !== this.refresh
      )
        return json(400, {
          error: 'invalid_grant',
          error_description: 'synthetic refresh refusal',
        });
      this.token = 'synthetic-access-' + randomUUID();
      if (this.rotatesRefresh)
        this.refresh = 'synthetic-refresh-' + randomUUID();
      this.peer.token = this.token;
      return json(200, {
        access_token: this.token,
        refresh_token: this.refresh,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json(200, {
        resource: this.origin + '/mcp',
        authorization_servers: [this.origin],
      });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer: this.origin,
        authorization_endpoint: this.origin + '/authorize',
        token_endpoint: this.origin + '/token',
        registration_endpoint: this.origin + '/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url.pathname === '/register')
      return json(201, {
        ...body,
        client_id: 'synthetic-registered-client',
        token_endpoint_auth_method: 'none',
      });
    if (url.pathname === '/authorize') {
      const code = randomUUID(),
        redirect = url.searchParams.get('redirect_uri')!;
      this.codes.set(code, {
        challenge: url.searchParams.get('code_challenge')!,
        redirect,
      });
      const back = new URL(redirect);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      back.searchParams.set('code', code);
      res.writeHead(302, { location: back.href }).end();
      return;
    }

    if (url.pathname !== '/mcp') return json(404, {});
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.setHeader(
        'www-authenticate',
        `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`,
      );
      return json(401, {});
    }
    if (req.method !== 'POST') return json(405, {});
    if (body.id === undefined) return res.writeHead(202).end();
    let result: any = {};
    if (body.method === 'initialize')
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'synthetic-preferences', version: '1.0' },
      };
    else if (body.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'get_nodes',
            description: 'Read synthetic preferences',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    else if (body.method === 'tools/call') {
      const query = body.params.arguments.memory;
      this.memoryQueries.push(query);
      this.memoryHook?.(query);
      let output: any;
      if (query.document) {
        const doc = this.documents.find((d) => d.id === query.document);
        if (!doc || doc.version !== query.version)
          output = {
            call_result: 'error',
            errors: [{ code: 'MEMORY_CURSOR_STALE' }],
          };
        else {
          const offset = Number(query.cursor ?? 0),
            bytes = Buffer.from(doc.markdown);
          let end = Math.min(bytes.length, offset + this.chunkBytes);
          while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
          output = {
            call_result: 'ok',
            errors: [],
            memory_document: {
              ...this.metadata(doc),
              current_version: doc.version,
              markdown: bytes.subarray(offset, end).toString(),
              offset,
              next: end < bytes.length ? String(end) : null,
            },
          };
        }
      } else {
        const offset = Number(query.cursor ?? 0),
          end = offset + this.pageItems;
        output = {
          call_result: 'ok',
          errors: [],
          memory_page: {
            scope: 'team',
            snapshot: 'a'.repeat(64),
            items: this.documents
              .slice(offset, end)
              .map((d) => this.metadata(d)),
            next: end < this.documents.length ? String(end) : null,
          },
        };
      }
      result = {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
        isError: output.call_result === 'error',
      };
    }
    return json(200, { jsonrpc: '2.0', id: body.id, result });
  }
}
