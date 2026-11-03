// A minimal knowledge-sync v1 server written from the specification alone
// (circle-hub docs/protocols/knowledge-sync-v1.md): it imports nothing from Circle or from
// any server implementation, only Node built-ins. It keeps one account, stores verbatim
// bytes under their SHA-256, commits by compare-and-swap and serves everything under a
// base the discovery document names, which is not the `/api/sync/v1` of earlier servers.
// It deliberately skips what a real server must also do (graph closure, re-verification,
// credential scans): it shows interoperability of the wire, not a server's guarantees.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';

const sha = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
/** RFC 8785 for the plain JSON a request carries (strings, safe integers, booleans, null). */
function jcs(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            jcs((value as Record<string, unknown>)[k]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
// The route templates of section 2; the request hash binds the template, not the base.
const TEMPLATE = '/api/sync/v1';
export const NEUTRAL_BASE = '/kb/sync/v1';
interface Operation {
  digest: string;
  status: number;
  body: unknown;
}

export class NeutralSyncServer {
  readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => {
      if (!res.headersSent) this.send(res, 500, { code: 'SOURCE_RETRYABLE' });
      else res.destroy();
    });
  });
  origin = '';
  token = 'synthetic-neutral-token';
  /** Every request path the server saw, in order. */
  readonly paths: string[] = [];
  epoch = randomUUID();
  mode: 'hub' | 'local' = 'hub';
  snapshot: string | null = null;
  version = sha('empty');
  lastSyncedAt: string | null = null;
  readonly objects = new Map<string, Buffer>();
  readonly committed = new Set<string>();
  readonly operations = new Map<string, Operation>();
  readonly sessions = new Map<string, { snapshot: string | null }>();
  /** Answer the next request to this route template suffix with an error. */
  failNext: { route: string; status: number; body: unknown } | null = null;
  /** A purge request waiting for the account holder's confirmation. */
  purge: {
    digest: string;
    operation: string;
    expires: number;
    body: any;
  } | null = null;
  confirmationUrl = '';

  async listen(): Promise<void> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    this.confirmationUrl = this.origin + '/console/sync?confirm=purge';
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
  discovery() {
    return {
      schema: 'knowledge-sync-discovery@1',
      issuer: this.origin,
      sync: {
        versions: [
          {
            version: 'v1',
            base_url: this.origin + NEUTRAL_BASE,
            capabilities: ['error-detail', 'purge-confirmation'],
          },
        ],
      },
      authorization: {
        resource: this.origin + '/mcp',
        resource_metadata:
          this.origin + '/.well-known/oauth-protected-resource/mcp',
        bearer_methods_supported: ['header'],
      },
      local_tools: { base_url: this.origin + '/tools' },
      // A member from a later revision of the document, which a client must ignore.
      synthetic_later_member: { note: 'ignored' },
    };
  }
  state() {
    return {
      epoch: this.epoch,
      mode: this.mode,
      status: 'idle',
      state_version: this.version,
      snapshot: this.snapshot,
      last_synced_at: this.lastSyncedAt,
      used_bytes: [...this.objects.values()].reduce((n, b) => n + b.length, 0),
      capacity_bytes: 1 << 30,
      limits: {
        object_bytes: 8388608,
        batch_bytes: 8388608,
        batch_objects: 64,
        page_items: 500,
        session_seconds: 86400,
      },
      synthetic_later_member: true,
    };
  }
  /** The account holder confirms the recorded purge outside the sync API. */
  confirmPurge(): void {
    const purge = this.purge!;
    this.purge = null;
    const previous = this.version;
    this.objects.clear();
    this.committed.clear();
    this.snapshot = null;
    this.mode = 'local';
    this.version = sha('local:' + randomUUID());
    this.operations.set(purge.operation, {
      digest: purge.digest,
      status: 200,
      body: {
        state: this.state(),
        receipt: this.receipt(purge.operation, purge.digest, previous, {
          accepted: 0,
          existing: 0,
          downloaded: 0,
          bytes: 0,
        }),
      },
    });
  }
  private receipt(
    operation: string,
    request: string,
    previous: string | null,
    counts: Record<string, number>,
  ) {
    return {
      operation_id: operation,
      epoch: this.epoch,
      request,
      previous_state: previous,
      state_version: this.version,
      counts,
      at: new Date().toISOString(),
      synthetic_later_member: 1,
    };
  }
  private send(res: ServerResponse, status: number, body: unknown): void {
    res
      .writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      .end(JSON.stringify(body));
  }
  private refuse(
    res: ServerResponse,
    status: number,
    code: string,
    detail: string,
  ) {
    this.send(res, status, { code, detail });
  }
  private kind(id: string): string {
    return JSON.parse(this.objects.get(id)!.toString('utf8')).kind;
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, this.origin);
    this.paths.push(url.pathname);
    if (url.pathname === '/.well-known/knowledge-sync')
      return this.send(res, 200, this.discovery());
    if (!url.pathname.startsWith(NEUTRAL_BASE + '/'))
      return this.send(res, 404, { code: 'SOURCE_UNAVAILABLE' });
    const route = url.pathname.slice(NEUTRAL_BASE.length);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : undefined;
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.setHeader('www-authenticate', 'Bearer');
      return this.send(res, 401, { code: 'SOURCE_UNAVAILABLE' });
    }
    if (this.failNext && route.startsWith(this.failNext.route)) {
      const failure = this.failNext;
      this.failNext = null;
      return this.send(res, failure.status, failure.body);
    }
    const parts = route.split('/').filter(Boolean);
    const template =
      parts[0] === 'sessions' && parts.length === 3
        ? `${TEMPLATE}/sessions/{id}/${parts[2]}`
        : parts[0] === 'operations'
          ? `${TEMPLATE}/operations/{id}`
          : TEMPLATE + route;
    const session =
      parts[0] === 'sessions' && parts.length === 3 ? parts[1]! : null;
    // Section 9: the key binds the route template, the session and the whole request.
    const digest =
      session === null
        ? sha(jcs({ path: template, request: body }))
        : parts[2] === 'upload'
          ? sha(jcs({ path: template, session, batch: body }))
          : sha(jcs({ path: template, session, request: body }));
    if (route === '/state') return this.send(res, 200, this.state());
    if (route === '/clients') return this.send(res, 200, body);
    if (route === '/sessions') {
      const id = randomUUID();
      this.sessions.set(id, { snapshot: this.snapshot });
      return this.send(res, 200, {
        session_id: id,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        state: this.state(),
        inventory_cursor: null,
      });
    }
    if (parts[0] === 'operations') {
      const op = this.operations.get(parts[1]!);
      return op
        ? this.send(res, op.status, op.body)
        : this.refuse(res, 404, 'SOURCE_UNAVAILABLE', 'no such operation');
    }
    if (route === '/mode/check')
      return this.send(res, 200, {
        check: sha('check:' + this.version + ':' + body.mode),
        expected_state: this.version,
        mode: body.mode,
        personal_bytes: this.state().used_bytes,
        directory_grants: 0,
        pending_shares: null,
        team_copies_preserved: 0,
      });
    if (route === '/mode') {
      const done = this.operations.get(body.operation_id);
      if (done) return this.send(res, done.status, done.body);
      if (body.mode === 'local' && this.mode === 'hub') {
        if (body.expected_state !== this.version)
          return this.refuse(res, 409, 'SYNC_VERSION_CONFLICT', '内容已变化。');
        // purge-confirmation: recorded once, performed only after the holder confirms.
        if (!this.purge)
          this.purge = {
            digest,
            operation: body.operation_id,
            expires: Date.now() + 600_000,
            body,
          };
        return this.send(res, 403, {
          code: 'SYNC_PURGE_CONFIRMATION_REQUIRED',
          detail: '清除服务器上的私人空间需要本人确认。',
          confirmation: {
            url: this.confirmationUrl,
            expires_at: new Date(this.purge.expires).toISOString(),
          },
        });
      }
      return this.refuse(
        res,
        422,
        'SYNC_OBJECT_INVALID',
        'unsupported mode change',
      );
    }
    if (!session || !this.sessions.has(session))
      return this.refuse(res, 404, 'SOURCE_UNAVAILABLE', 'no such session');
    const frozen = this.sessions.get(session)!;
    const kind = parts[2];
    if (kind === 'inventory')
      return this.send(res, 200, {
        snapshot: frozen.snapshot,
        objects: [...this.committed].sort().map((id) => ({
          id,
          kind: this.kind(id),
          bytes: this.objects.get(id)!.length,
        })),
        next: null,
      });
    if (kind === 'missing')
      return this.send(res, 200, {
        missing: body.objects.filter((id: string) => !this.objects.has(id)),
      });
    if (kind === 'download')
      return this.send(res, 200, {
        objects: body.objects
          .filter((id: string) => this.objects.has(id))
          .map((id: string) => ({
            id,
            bytes_base64: this.objects.get(id)!.toString('base64'),
          })),
        missing: body.objects.filter((id: string) => !this.objects.has(id)),
      });
    const done = this.operations.get(body.operation_id);
    if (done) {
      if (done.digest !== digest)
        return this.refuse(
          res,
          422,
          'IDEMPOTENCY_MISMATCH',
          '同一键内容不同。',
        );
      return this.send(res, done.status, done.body);
    }
    if (kind === 'upload') {
      let accepted = 0,
        existing = 0,
        bytes = 0;
      const decoded = body.objects.map(
        (o: { id: string; bytes_base64: string }) => ({
          id: o.id,
          bytes: Buffer.from(o.bytes_base64, 'base64'),
        }),
      );
      if (
        decoded.some(
          (o: { id: string; bytes: Buffer }) => sha(o.bytes) !== o.id,
        )
      )
        return this.refuse(res, 422, 'SYNC_OBJECT_HASH_MISMATCH', '摘要不符。');
      for (const o of decoded) {
        bytes += o.bytes.length;
        if (this.objects.has(o.id)) existing++;
        else {
          accepted++;
          this.objects.set(o.id, o.bytes);
        }
      }
      const answer = this.receipt(body.operation_id, digest, this.version, {
        accepted,
        existing,
        downloaded: 0,
        bytes,
      });
      this.operations.set(body.operation_id, {
        digest,
        status: 200,
        body: answer,
      });
      return this.send(res, 200, answer);
    }
    if (kind === 'commit') {
      if (body.expected_state !== this.version)
        return this.send(res, 409, {
          code: 'SYNC_VERSION_CONFLICT',
          detail: '同步期间内容已变化。取得最新内容并合并后重试。',
          state: this.state(),
        });
      if (!this.objects.has(body.snapshot))
        return this.refuse(res, 422, 'SYNC_OBJECT_MISSING', '对象尚未齐全。');
      const previous = this.version;
      this.snapshot = body.snapshot;
      for (const id of this.objects.keys()) this.committed.add(id);
      this.version = sha('state:' + body.snapshot + ':' + randomUUID());
      this.lastSyncedAt = new Date().toISOString();
      const answer = {
        state: this.state(),
        receipt: this.receipt(body.operation_id, digest, previous, {
          accepted: 0,
          existing: 0,
          downloaded: 0,
          bytes: 0,
        }),
        verification: [],
        conflicts: [],
        next: null,
      };
      this.operations.set(body.operation_id, {
        digest,
        status: 200,
        body: answer,
      });
      return this.send(res, 200, answer);
    }
    if (kind === 'abort') {
      this.sessions.delete(session);
      const answer = this.receipt(body.operation_id, digest, this.version, {
        accepted: 0,
        existing: 0,
        downloaded: 0,
        bytes: 0,
      });
      this.operations.set(body.operation_id, {
        digest,
        status: 200,
        body: answer,
      });
      return this.send(res, 200, answer);
    }
    return this.refuse(res, 404, 'SOURCE_UNAVAILABLE', 'unknown route');
  }
}
