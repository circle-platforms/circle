import { verifyLocal } from '../../../src/knowledge/verification.js';
import { sha256 } from '../../../src/knowledge/canonical.js';
// Synthetic OAuth/MCP + sync peer. No sync server implementation or real identity provider is imported.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { FakeSyncServer } from './fake-server.js';
import { McpAuthProvider, redirectPort } from '../../../src/mcp_auth.js';
import { DEVICE_CODE_GRANT } from '../../../src/mcp_device.js';

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
export const unsignedUploadRefusal = {
  code: 'SHARE_UPLOAD_UNSIGNED',
  message: '上传原文需上传人署名',
  fix: '请上传人在原文详情中选择“署名为团队来源…”，确认后重新预检',
};
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
  sharedDocuments: TeamDocument[] = [];
  personalDocuments = new Map<string, any>();
  knowledgeEntries: any[] = [];
  sourceTexts = new Map<string, string>();
  shareCalls: any[] = [];
  sharesAllowed = true;
  shareRefusal?: { code: string; message: string; fix: string };
  pageItems = 1;
  chunkBytes = 6;
  /**
   * Publish a knowledge-sync discovery document that maps the operations to other tool and
   * argument names, so a client that hard-codes the earlier names fails against it.
   */
  renamedTools = false;
  /** The tool name of every tools/call, as the client sent it. */
  readonly toolNames: string[] = [];
  /** Offer the device code (RFC 8628) and a revocation endpoint, as a Circle Hub does. */
  device = false;
  /** Set when a person approved the device code on the server's page. */
  deviceApproved = false;
  readonly deviceRequests: URLSearchParams[] = [];
  readonly revocations: URLSearchParams[] = [];
  constructor(home: string) {
    this.peer = new FakeSyncServer(home);
    this.peer.now = Date.now();
    this.peer.project = (item) => {
      const object = this.peer.store.read(item.heads[0]!);
      const base = {
        kind: item.kind,
        item_id: item.item_id,
        object: item.heads[0]!,
      };
      if (item.heads.length !== 1) return base;
      const root = sha256('synthetic-native-root:' + this.peer.store.head);
      if (object.kind === 'entry_revision') {
        const entry = sha256('synthetic-native-entry:' + item.heads[0]),
          path = '/';
        const row = {
          space: 'synthetic-user',
          root,
          path,
          entry,
          statement: object.body.content.statement,
          status:
            verifyLocal(this.peer.store.graph(this.peer.store.head!)).find(
              (v) => v.object === item.heads[0],
            )?.status ?? 'unverified',
          grounds: [],
        };
        this.knowledgeEntries = this.knowledgeEntries.filter(
          (e) => e.localItem !== item.item_id,
        );
        this.knowledgeEntries.push({ ...row, localItem: item.item_id });
        return { ...base, reference: 'tree:' + root + path + '@' + entry };
      }
      if (object.kind === 'memory_revision') {
        const document = sha256('synthetic-document:' + item.item_id),
          version = sha256('synthetic-memory-version:' + item.heads[0]);
        this.personalDocuments.set(document, {
          document,
          version,
          ...object.body,
        });
        return { ...base, document, version };
      }
      return base;
    };
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
    const formBody = ['/token', '/device_authorization', '/revoke'].includes(
      url.pathname,
    );
    const body = raw && !formBody ? JSON.parse(raw) : raw;
    this.requests.push({ path: url.pathname, headers: req.headers, body });
    if (url.pathname === '/token') {
      const form = new URLSearchParams(raw);
      this.tokenRequests.push(form);
      await this.gateRefresh?.();
      if (form.get('grant_type') === DEVICE_CODE_GRANT) {
        if (form.get('device_code') !== 'synthetic-device-code')
          return json(400, { error: 'invalid_grant' });
        if (!this.deviceApproved)
          return json(400, { error: 'authorization_pending' });
      } else if (form.get('grant_type') === 'authorization_code') {
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
    if (url.pathname === '/device_authorization' && this.device) {
      this.deviceRequests.push(new URLSearchParams(raw));
      return json(200, {
        device_code: 'synthetic-device-code',
        user_code: 'BCDF-GHJK',
        verification_uri: this.origin + '/device',
        verification_uri_complete: this.origin + '/device?user_code=BCDF-GHJK',
        expires_in: 600,
        interval: 1,
      });
    }
    if (url.pathname === '/revoke') {
      this.revocations.push(new URLSearchParams(raw));
      return res.writeHead(200).end();
    }
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer: this.origin,
        authorization_endpoint: this.origin + '/authorize',
        token_endpoint: this.origin + '/token',
        registration_endpoint: this.origin + '/register',
        revocation_endpoint: this.origin + '/revoke',
        ...(this.device
          ? {
              device_authorization_endpoint:
                this.origin + '/device_authorization',
            }
          : {}),
        response_types_supported: ['code'],
        grant_types_supported: [
          'authorization_code',
          'refresh_token',
          ...(this.device ? [DEVICE_CODE_GRANT] : []),
        ],
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

    if (url.pathname === '/.well-known/knowledge-sync' && this.renamedTools)
      return json(200, {
        schema: 'knowledge-sync-discovery@1',
        issuer: this.origin,
        sync: {
          versions: [
            {
              version: 'v1',
              base_url: this.origin + '/api/sync/v1',
              capabilities: ['error-detail'],
            },
          ],
        },
        authorization: {
          resource: this.origin + '/mcp',
          resource_metadata:
            this.origin + '/.well-known/oauth-protected-resource/mcp',
          bearer_methods_supported: ['header'],
        },
        local_tools: { base_url: this.origin + '/local-tools' },
        mcp: {
          endpoint: this.origin + '/mcp',
          capabilities: {
            'entry-share': { tool: 'team_share', argument: 'entry' },
            'memory-share': { tool: 'team_share', argument: 'memory' },
            'team-memory-read': {
              tool: 'team_preferences',
              argument: 'query',
              fixed: { scope: 'team' },
            },
          },
        },
        synthetic_future_member: true,
      });
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
    // The renamed tools are the same operations under the names the document declares.
    if (body.method === 'tools/call') this.toolNames.push(body.params.name);
    if (this.renamedTools && body.method === 'tools/call') {
      const args = body.params.arguments ?? {};
      if (['get_nodes', 'upload_file'].includes(body.params.name))
        return json(200, {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32602, message: 'unknown tool' },
        });
      if (body.params.name === 'team_share')
        body.params = {
          ...body.params,
          name: 'upload_file',
          arguments: args.entry
            ? { share_entry: args.entry }
            : { memory_share: args.memory },
        };
      else if (body.params.name === 'team_preferences')
        body.params = {
          ...body.params,
          name: 'get_nodes',
          arguments: { memory: args.query },
        };
    }
    let result: any = {};
    if (body.method === 'initialize')
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'synthetic-preferences', version: '1.0' },
      };
    else if (body.method === 'tools/list' && this.renamedTools)
      result = {
        tools: [
          {
            name: 'team_share',
            description: 'Share synthetic personal content',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: false },
          },
          {
            name: 'team_preferences',
            description: 'Read synthetic preferences',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    else if (body.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'upload_file',
            description: 'Share synthetic personal content',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: false },
          },
          {
            name: 'get_nodes',
            description: 'Read synthetic preferences',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    else if (
      body.method === 'tools/call' &&
      body.params.name === 'upload_file'
    ) {
      const args = body.params.arguments;
      this.shareCalls.push(structuredClone(args));
      const share = args.memory_share;
      let output: any;
      if (!this.sharesAllowed || this.peer.mode === 'local')
        output = {
          call_result: 'error',
          errors: [{ code: 'SOURCE_UNAVAILABLE' }],
        };
      else if (args.share_entry && this.shareRefusal)
        output = {
          call_result: 'error',
          errors: [this.shareRefusal],
          share: {
            status: 'rejected',
            code: this.shareRefusal.code,
            message: this.shareRefusal.message,
          },
        };
      else if (share) {
        const own = this.personalDocuments.get(share.document),
          valid = own?.version === share.version;
        const check = {
          ok: valid,
          checks: [],
          effect: 'created',
          replaces: null,
          title: own?.title ?? '',
          target_path: share.team_path ?? '/',
        };
        if (!share.check_only && valid) {
          const doc = {
            id: sha256('team:' + share.document),
            version: sha256('team:' + share.version),
            title: own.title,
            path: share.team_path ?? '/',
            markdown: own.markdown,
          };
          this.documents = this.documents.filter((d) => d.id !== doc.id);
          this.documents.push(doc);
          (check as any).share = {
            status: 'merged',
            team_document: doc.id,
            team_version: doc.version,
          };
        }
        output = { call_result: 'ok', errors: [], memory_share: check };
      } else {
        const own = this.knowledgeEntries.find(
          (e) =>
            e.root === args.share_entry?.root &&
            e.entry === args.share_entry?.entry &&
            e.space === 'synthetic-user',
        );
        output =
          own?.status === 'verified'
            ? {
                call_result: 'ok',
                errors: [],
                share: {
                  status: 'merged',
                  reference:
                    'tree:' +
                    sha256('team') +
                    (args.share_entry.team_path ?? '/') +
                    '@' +
                    own.entry,
                },
              }
            : {
                call_result: 'error',
                errors: [{ code: 'SOURCE_UNAVAILABLE' }],
              };
      }
      result = {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
        isError: output.call_result !== 'ok',
      };
    } else if (body.method === 'tools/call' && !body.params.arguments.memory) {
      const args = body.params.arguments;
      let output: any;
      if (args.reference) {
        const text = this.sourceTexts.get(args.reference);
        output = {
          call_result: 'ok',
          content: {
            readable: text !== undefined,
            text,
            read_tier: text === undefined ? 'retain_only' : 'model_readable',
          },
        };
      } else if (args.search) {
        const matches = this.knowledgeEntries
          .filter(
            (e) =>
              (args.scope === 'team'
                ? e.space === 'team'
                : args.scope === 'shared'
                  ? e.space !== 'team' && e.space !== 'synthetic-user'
                  : true) && e.statement.includes(args.search),
          )
          .map((e) => ({
            ...e,
            reference: 'tree:' + e.root + e.path + '@' + e.entry,
            kind: 'observation',
          }));
        output = { call_result: 'ok', matches };
      } else {
        const path = args.paths?.[0] ?? '/',
          rows = this.knowledgeEntries.filter((e) =>
            args.root
              ? e.root === args.root
              : e.space === (args.space ?? 'synthetic-user'),
          );
        const root = args.root ?? rows[0]?.root ?? sha256('empty-team'),
          children = [
            ...new Set(
              rows
                .filter(
                  (e) =>
                    e.path.startsWith(path === '/' ? '/' : path + '/') &&
                    e.path !== path,
                )
                .map(
                  (e) =>
                    e.path
                      .slice(path === '/' ? 1 : path.length + 1)
                      .split('/')[0],
                ),
            ),
          ].map((name) => ({
            name,
            path: (path === '/' ? '' : path) + '/' + name,
            digest: sha256(name),
          }));
        output = {
          call_result: 'ok',
          root,
          nodes: [
            {
              path,
              name: path.split('/').at(-1),
              children,
              entries: rows
                .filter((e) => e.path === path)
                .map((e) => ({
                  ...e,
                  reference: 'tree:' + root + path + '@' + e.entry,
                })),
            },
          ],
        };
      }
      result = {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } else if (body.method === 'tools/call') {
      const query = body.params.arguments.memory;
      this.memoryQueries.push(query);
      this.memoryHook?.(query);
      let output: any;
      if (query.document) {
        const doc = [...this.documents, ...this.sharedDocuments].find(
          (d) => d.id === query.document,
        );
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
            scope: query.scope ?? 'team',
            snapshot: 'a'.repeat(64),
            items: (query.scope === 'shared'
              ? this.sharedDocuments
              : this.documents
            )
              .slice(offset, end)
              .map((d) => this.metadata(d)),
            next:
              end <
              (query.scope === 'shared' ? this.sharedDocuments : this.documents)
                .length
                ? String(end)
                : null,
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
