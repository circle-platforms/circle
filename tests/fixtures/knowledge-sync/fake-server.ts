// Synthetic protocol peer, deliberately not a server implementation or proof of its authorization/atomicity.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { KnowledgeStore } from '../../../src/knowledge/store.js';
import { sha256, decodeSyncObject } from '../../../src/knowledge/canonical.js';
import { validateSync, decodeBase64 } from '../../../src/knowledge/protocol.js';
import { operationDigest } from '../../../src/knowledge/sync-http.js';
import type {
  SyncState,
  SyncReceipt,
} from '../../../src/knowledge/sync-types.js';

export class FakeSyncServer {
  readonly store: KnowledgeStore;
  readonly calls: {
    route: string;
    body: any;
    headers: IncomingMessage['headers'];
    url: string;
  }[] = [];
  readonly sessions = new Map<
    string,
    { snapshot: string | null; expires: string; objects: Set<string> }
  >();
  readonly operations = new Map<string, { digest: string; result: any }>();
  readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => {
      if (!res.headersSent) this.send(res, 500, { code: 'SOURCE_RETRYABLE' });
      else res.destroy();
    });
  });
  epoch = randomUUID();
  mode: 'hub' | 'local' = 'hub';
  revision = 0;
  now = 1700000000000;
  limits = {
    object_bytes: 8388608,
    batch_bytes: 8388608,
    batch_objects: 64,
    page_items: 500,
    session_seconds: 86400,
  };
  modeImpact = {
    personal_bytes: 123,
    directory_grants: 2,
    pending_shares: null as number | null,
    team_copies_preserved: 1,
  };
  dropNext: string | null = null;
  errorNext: {
    route: string;
    status: number;
    code: string;
    retry?: number;
    /** The server's own explanation (capability error-detail) and a purge's confirmation page. */
    detail?: string;
    confirmation?: { url: string; expires_at: string };
  } | null = null;
  onRequest: ((route: string, body: any) => void | Promise<void>) | null = null;
  purging = false;
  purgingOnLocal = false;
  resultPageSize = 500;
  project:
    | ((
        item: import('../../../src/knowledge/types.js').SyncItem,
      ) => Record<string, unknown>)
    | undefined;
  damageDownload = false;
  token = 'synthetic-sync-token';
  origin = '';
  constructor(home: string) {
    this.store = new KnowledgeStore(home);
  }
  state(): SyncState {
    return {
      epoch: this.epoch,
      mode: this.mode,
      status: this.purging ? 'purging' : 'idle',
      state_version: sha256(
        JSON.stringify([this.epoch, this.mode, this.store.head, this.revision]),
      ),
      snapshot: this.mode === 'hub' ? this.store.head : null,
      last_synced_at: null,
      used_bytes: 0,
      capacity_bytes: 1e9,
      limits: this.limits,
    };
  }
  async listen(): Promise<void> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address() as { port: number };
    this.origin = `http://127.0.0.1:${address.port}`;
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.store.close();
  }
  send(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
  }
  private pageResult(value: any, cursor: string | null): unknown {
    if (!value?.verification) return value;
    const offset = Number(cursor ?? 0),
      end = offset + this.resultPageSize,
      count = Math.max(
        value.verification.length,
        value.conflicts.length,
        value.projections?.length ?? 0,
      );
    return {
      ...value,
      verification: value.verification.slice(offset, end),
      conflicts: value.conflicts.slice(offset, end),
      ...(value.projections
        ? { projections: value.projections.slice(offset, end) }
        : {}),
      next: end < count ? String(end) : null,
    };
  }
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url!, this.origin),
      part = url.pathname.slice('/api/sync/v1/'.length).split('/');
    const route =
      part[0] === 'clients'
        ? 'client'
        : part[0] === 'sessions'
          ? (part[2] ?? 'session')
          : part[0] === 'operations'
            ? 'operation'
            : part[0] === 'mode'
              ? part[1] === 'check'
                ? 'modeCheck'
                : 'mode'
              : part[0]!;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    this.calls.push({ route, body, headers: req.headers, url: req.url! });
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      this.send(res, 401, { code: 'SOURCE_UNAVAILABLE' });
      return;
    }
    await this.onRequest?.(route, body);
    if (this.errorNext?.route === route) {
      const error = this.errorNext;
      this.errorNext = null;
      this.send(res, error.status, {
        code: error.code,
        ...(error.retry ? { retry_after_seconds: error.retry } : {}),
        ...(error.detail ? { detail: error.detail } : {}),
        ...(error.confirmation ? { confirmation: error.confirmation } : {}),
      });
      return;
    }
    if (route === 'state') {
      this.send(res, 200, this.state());
      return;
    }
    const id = part[1]!;
    if (route === 'operation') {
      const op = this.operations.get(url.searchParams.get('epoch') + ':' + id);
      this.send(
        res,
        op ? 200 : 404,
        op
          ? this.pageResult(op.result, url.searchParams.get('cursor'))
          : { code: 'SOURCE_UNAVAILABLE' },
      );
      return;
    }
    if (route === 'modeCheck') {
      validateSync('personal-sync-mode-check@1', body);
      this.send(res, 200, {
        check: sha256('checked:' + this.state().state_version),
        expected_state: this.state().state_version,
        mode: body.mode,
        ...this.modeImpact,
      });
      return;
    }
    if (route === 'mode') {
      validateSync('personal-sync-mode-change@1', body);
      const before = this.state();
      if (body.expected_state !== before.state_version) {
        this.send(res, 409, { code: 'SYNC_VERSION_CONFLICT', state: before });
        return;
      }
      if (
        body.mode === 'local' &&
        body.check !== sha256('checked:' + before.state_version)
      ) {
        this.send(res, 409, { code: 'SYNC_VERSION_CONFLICT', state: before });
        return;
      }
      const digest = operationDigest('mode', null, body);
      this.mode = body.mode;
      this.purging = body.mode === 'local' && this.purgingOnLocal;
      if (body.mode === 'hub' && before.mode === 'local')
        this.epoch = randomUUID();
      this.revision++;
      const state = this.state(),
        receipt = {
          operation_id: body.operation_id,
          epoch: body.epoch,
          request: digest,
          previous_state: before.state_version,
          state_version: state.state_version,
          counts: { accepted: 0, existing: 0, downloaded: 0, bytes: 0 },
          at: new Date(this.now).toISOString(),
        };
      const result = { state, receipt };
      this.operations.set(body.epoch + ':' + body.operation_id, {
        digest,
        result,
      });
      if (this.dropNext === route) {
        this.dropNext = null;
        res.destroy();
        return;
      }
      this.send(res, 200, result);
      return;
    }
    if (this.mode === 'local') {
      this.send(res, 409, { code: 'SYNC_MODE_LOCAL' });
      return;
    }
    if (body?.epoch && body.epoch !== this.epoch) {
      this.send(res, 409, { code: 'SYNC_EPOCH_CHANGED' });
      return;
    }
    let result: any;
    if (route === 'client') {
      validateSync('personal-sync-client@1', body);
      result = body;
    } else if (route === 'session') {
      validateSync('personal-sync-session@1', body);
      const state = this.state(),
        session_id = randomUUID(),
        expires_at = new Date(this.now + 86400000).toISOString();
      this.sessions.set(session_id, {
        snapshot: state.snapshot,
        expires: expires_at,
        objects: new Set(
          state.snapshot ? this.store.graph(state.snapshot).objects.keys() : [],
        ),
      });
      result = {
        session_id,
        expires_at,
        state,
        inventory_cursor: state.snapshot ? '0' : null,
      };
    } else {
      const session = this.sessions.get(id);
      if (!session || Date.parse(session.expires) <= this.now) {
        this.send(res, 422, { code: 'SYNC_SESSION_EXPIRED' });
        return;
      }
      if (route === 'inventory') {
        const ids = [...session.objects].sort(),
          offset = Number(url.searchParams.get('cursor') ?? 0),
          end = offset + this.limits.page_items;
        result = {
          snapshot: session.snapshot,
          objects: ids.slice(offset, end).map((id) => ({
            id,
            bytes: this.store.readBytes(id).length,
            kind: this.store.read(id).kind,
          })),
          next: end < ids.length ? String(end) : null,
        };
      } else if (route === 'missing') {
        validateSync('personal-sync-missing@1', body);
        for (const id of body.objects)
          if (this.store.has(id)) session.objects.add(id);
        result = {
          missing: body.objects.filter((id: string) => !this.store.has(id)),
        };
      } else if (route === 'download') {
        validateSync('personal-sync-download@1', body);
        result = {
          objects: body.objects
            .filter((id: string) => session.objects.has(id))
            .map((id: string) => ({
              id,
              bytes_base64: (this.damageDownload
                ? Buffer.from('{}')
                : this.store.readBytes(id)
              ).toString('base64'),
            })),
          missing: body.objects.filter(
            (id: string) => !session.objects.has(id),
          ),
        };
      } else {
        validateSync(`personal-sync-${route}@1`, body);
        const digest = operationDigest(route, id, body),
          key = this.epoch + ':' + body.operation_id,
          previous = this.operations.get(key);
        if (previous) {
          this.send(
            res,
            previous.digest === digest ? 200 : 422,
            previous.digest === digest
              ? previous.result
              : { code: 'IDEMPOTENCY_MISMATCH' },
          );
          return;
        }
        const before = this.state();
        let accepted = 0,
          bytes = 0;
        if (route === 'upload') {
          const objects = body.objects.map((o: any) => {
            const bytes = decodeBase64(o.bytes_base64);
            return decodeSyncObject(bytes, o.id);
          });
          accepted = body.objects.filter(
            (o: any) => !this.store.has(o.id),
          ).length;
          bytes = body.objects.reduce(
            (n: number, o: any) => n + decodeBase64(o.bytes_base64).length,
            0,
          );
          if (
            bytes > this.limits.batch_bytes ||
            objects.length > this.limits.batch_objects
          ) {
            this.send(res, 413, { code: 'SYNC_BATCH_LIMIT' });
            return;
          }
          this.store.putBatch(objects);
          for (const o of body.objects) session.objects.add(o.id);
        } else if (route === 'commit') {
          if (body.expected_state !== before.state_version) {
            this.send(res, 409, {
              code: 'SYNC_VERSION_CONFLICT',
              state: before,
            });
            return;
          }
          this.store.commit(body.snapshot, this.store.head, true);
        } else if (route === 'abort') this.sessions.delete(id);
        const state = this.state();
        const receipt: SyncReceipt = {
          operation_id: body.operation_id,
          epoch: this.epoch,
          request: digest,
          previous_state: before.state_version,
          state_version: state.state_version,
          counts: {
            accepted,
            existing: route === 'upload' ? body.objects.length - accepted : 0,
            downloaded: 0,
            bytes,
          },
          at: new Date(this.now).toISOString(),
        };
        result =
          route === 'commit'
            ? {
                state,
                receipt,
                verification: [],
                projections: this.store.graph(body.snapshot).items.map(
                  (i) =>
                    this.project?.(i) ?? {
                      kind: i.kind,
                      item_id: i.item_id,
                      object: i.heads[0]!,
                    },
                ),
                conflicts: this.store.graph(body.snapshot).conflicts,
                next: null,
              }
            : receipt;
        this.operations.set(key, { digest, result });
      }
    }
    if (this.dropNext === route) {
      this.dropNext = null;
      res.destroy();
      return;
    }
    this.send(res, 200, this.pageResult(result, null));
  }
}
