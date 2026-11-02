import { loadCredentials } from '../../../src/settings.js';
import { loadSecrets } from '../../../src/secrets.js';
import { keptFor } from '../../../src/mcp_auth.js';
import { resolveHeaders } from '../../../src/mcp_loader.js';
import { homedir } from 'node:os';
import { canonicalPath } from '../../../src/paths.js';
import { assertExternalSelectionPath } from './workspace/external-file-grants';
import {
  prepareKnowledgeShare,
  syncMapping,
} from '../../../src/knowledge/sharing.js';
import { randomUUID, createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import type { AgentRuntime } from '../../../src/runtime.js';
import { KnowledgeService } from '../../../src/knowledge/service.js';
import { KnowledgeVersionConflict } from '../../../src/knowledge/store.js';
import { decodeBase64, isObjectId } from '../../../src/knowledge/protocol.js';
import { syncObjectId, sha256 } from '../../../src/knowledge/canonical.js';
import { requireClean } from '../../../src/knowledge/verification.js';
import {
  installPersonalPack,
  inspectPersonalPack,
  inspectPersonalPackFolder,
  installedPersonalPacks,
  setPersonalPackEnabled,
} from '../../../src/knowledge/packs.js';
import { forgetAuthorization } from '../../../src/mcp_auth.js';
import { buildMcpConnections } from '../../../src/mcp_loader.js';
import { secretLookingName } from '../../../src/sandbox.js';
import { readFileBytes } from '../../../src/file_access.js';
import {
  validateKnowledgeRequest,
  type KnowledgeRow,
  type KnowledgeDetail,
  type KnowledgeList,
  type KnowledgePreview,
  type KnowledgeSyncView,
  type KnowledgeKind,
} from '../../../src/knowledge/desktop-contract.js';
import type { SyncObject, SyncItem } from '../../../src/knowledge/types.js';

type Local = { snapshot: string; object: string; item: string };
type Remote = {
  binding: string;
  scope: string;
  kind: 'memory' | 'entry' | 'folder';
  root?: string;
  space?: string;
  path: string;
  entry?: string;
  document?: string;
  version?: string;
  title: string;
  state: string;
  auto?: boolean;
};
type Held = {
  expires: number;
  owner: string;
  run: () => unknown | Promise<unknown>;
};
const fail = (code = 'knowledge-unavailable'): never => {
  throw Error(code);
};
const envelope = (value: any): any => {
  let result = value?.structuredContent;
  if (
    result === undefined &&
    value?.content?.length === 1 &&
    value.content[0].type === 'text'
  )
    result = JSON.parse(value.content[0].text);
  if (value?.isError || result?.call_result !== 'ok')
    return fail('knowledge-remote-unavailable');
  return result;
};
const label = (o: SyncObject): string =>
  o.kind === 'entry_revision'
    ? o.body.content.statement
    : o.kind === 'memory_revision'
      ? o.body.title
      : o.kind === 'directory_revision'
        ? o.body.name || '/'
        : o.kind === 'source_revision'
          ? o.body.name || 'source'
          : o.kind === 'pack_manifest'
            ? o.body.manifest.title
            : 'deleted';
const kind = (o: SyncObject, row: SyncItem): KnowledgeKind =>
  row.kind === 'memory_revision'
    ? 'memory'
    : row.kind === 'entry_revision'
      ? 'entry'
      : row.kind === 'directory_revision'
        ? 'folder'
        : row.kind === 'source_revision'
          ? 'source'
          : o.kind === 'pack_manifest'
            ? o.body.manifest.kind
            : 'workflow';
const bounded = (value: string, maximum = 24000) => {
  const bytes = Buffer.from(value);
  let end = Math.min(maximum, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    text: bytes.subarray(0, end).toString(),
    truncated: end < bytes.length,
  };
};
/** A host-owned capability table. DTOs contain no disk paths, object hashes, credentials or HTTP dispatcher. */
export class DesktopKnowledge {
  constructor(private readonly protectedRoots: () => string[] = () => []) {}
  private nativePath(runtime: AgentRuntime, path: string) {
    assertExternalSelectionPath(canonicalPath(path), {
      credentialFiles: runtime.options.settings.credential_files,
      protectedRoots: [
        runtime.options.home,
        ...this.protectedRoots(),
        join(homedir(), '.circle'),
        join(homedir(), 'Library', 'Application Support', 'Circle'),
        join(homedir(), 'Library', 'Application Support', 'Circle Beta'),
      ],
    });
  }
  private refs = new Map<string, Local>();
  private refKeys = new Map<string, string>();
  private remote = new Map<string, Remote>();
  private tickets = new Map<string, Held>();
  private sources = new Map<
    string,
    { local?: Local; remote?: Remote; reference?: string }
  >();
  private safe(runtime: AgentRuntime, value: unknown): void {
    const needles = Object.values({
      ...loadCredentials(runtime.options.home),
      ...loadSecrets(runtime.options.home),
    });
    for (const c of buildMcpConnections(runtime.options.settings.mcp_servers)
      .connections) {
      let headers: Record<string, string> = {};
      try {
        headers = resolveHeaders(
          c.headers,
          process.env,
          loadSecrets(runtime.options.home),
        );
      } catch {
        /* An unresolved, unselected MCP profile cannot block offline local browsing. */
      }
      for (const [name, value] of Object.entries(headers))
        if (
          /^(?:proxy-)?authorization$/i.test(name) ||
          secretLookingName(name)
        ) {
          needles.push(value);
          if (/^Bearer /i.test(value)) needles.push(value.slice(7));
        }
      if (c.url) {
        const kept = keptFor(runtime.options.home, new URL(c.url).href);
        for (const value of [
          kept.tokens?.access_token,
          kept.tokens?.refresh_token,
          kept.client && 'client_secret' in kept.client
            ? kept.client.client_secret
            : undefined,
        ])
          if (typeof value === 'string') needles.push(value);
      }
    }
    const text = JSON.stringify(value);
    if (
      needles.some(
        (n) =>
          n &&
          (text.includes(n) || text.includes(JSON.stringify(n).slice(1, -1))),
      )
    )
      fail('knowledge-credential-rejected');
  }
  private loaded(
    runtime: AgentRuntime,
    id: string,
    version: string,
  ): {
    loaded: boolean;
    loadState: 'loaded' | 'partial' | 'earlier' | 'not-loaded';
  } {
    const snapshot = runtime.loadedSessionMemory,
      context = runtime.sessionMemoryContext;
    const current = snapshot?.documents.find(
        (d) => d.id === id && d.version === version,
      ),
      old = snapshot?.documents.find((d) => d.id === id);
    const marker = (v: string) => ' id="' + id + '" version="' + v + '"';
    if (!current) {
      return {
        loaded: false,
        loadState:
          old && context.includes(marker(old.version))
            ? 'earlier'
            : 'not-loaded',
      };
    }
    const start = context.indexOf(marker(version));
    if (start < 0) return { loaded: false, loadState: 'not-loaded' };
    const end = context.indexOf('\n</preference>', start),
      block = context.slice(start, end),
      escaped = current.markdown
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;');
    const full = block.endsWith('\n' + escaped);
    return { loaded: true, loadState: full ? 'loaded' : 'partial' };
  }
  private service(runtime: AgentRuntime) {
    return new KnowledgeService(
      runtime.options.home,
      runtime.options.knowledgeAccess,
    );
  }
  status(runtime: AgentRuntime): KnowledgeSyncView {
    return runtime.knowledge.status();
  }
  private reference(value: Local): string {
    const key = value.snapshot + ':' + value.object,
      prior = this.refKeys.get(key);
    if (prior) return prior;
    if (this.refs.size >= 4000) {
      this.refs.clear();
      this.refKeys.clear();
    }
    const token = randomUUID();
    this.refs.set(token, value);
    this.refKeys.set(key, token);
    return token;
  }
  private current(runtime: AgentRuntime, id: string, token: string): Local {
    const ref = this.refs.get(token);
    if (!ref || ref.item !== id) return fail('knowledge-changed');
    this.service(runtime).withStore((store) => {
      if (
        store.head !== ref.snapshot ||
        !store
          .items()
          .some((i) => i.item_id === id && i.heads.includes(ref.object))
      )
        fail('knowledge-changed');
    });
    return ref;
  }
  private hold(
    runtime: AgentRuntime,
    preview: Omit<KnowledgePreview, 'ticket'>,
    run: Held['run'],
  ): KnowledgePreview {
    this.safe(runtime, preview);
    const now = Date.now();
    for (const [key, value] of this.tickets)
      if (value.expires <= now) this.tickets.delete(key);
    if (this.tickets.size >= 32) return fail('knowledge-too-many-previews');
    const ticket = randomUUID();
    this.tickets.set(ticket, {
      owner: runtime.session.id,
      expires: now + 300000,
      run: () => {
        this.safe(runtime, preview);
        return run();
      },
    });
    return { ticket, ...preview };
  }
  private editable(runtime: AgentRuntime) {
    if (
      runtime.busy ||
      runtime.viewOnly ||
      runtime.options.knowledgeAccess?.().locked
    )
      fail('knowledge-read-only');
  }
  private localRow(
    runtime: AgentRuntime,
    store: any,
    graph: any,
    row: SyncItem,
    cache?: {
      deferTokens?: boolean;
      observations: Map<string, any>;
      installations: Map<string, any>;
      available: Set<string>;
    },
  ): KnowledgeRow {
    const object = graph.objects.get(row.heads[0]) as SyncObject,
      conflicted =
        graph.conflicts.some((c: any) => c.item_id === row.item_id) ||
        row.heads.length !== 1;
    const observed =
      cache?.observations.get(row.heads[0]!) ??
      (!cache
        ? store
            .observations(graph.snapshot)
            .find((o: any) => o.object === row.heads[0])
        : undefined);
    const receipt =
      cache?.installations.get(row.heads[0]!) ??
      (!cache
        ? store.packInstallations().find((p: any) => p.object === row.heads[0])
        : undefined);
    const available = receipt?.enabled
      ? (
          cache?.available ??
          new Set(
            installedPersonalPacks(runtime.options.home).map((p) => p.object),
          )
        ).has(row.heads[0]!)
      : false;
    return {
      id: row.item_id,
      token: cache?.deferTokens
        ? ''
        : this.reference({
            snapshot: graph.snapshot,
            object: row.heads[0]!,
            item: row.item_id,
          }),
      kind: kind(object, row),
      title: label(object).slice(0, 1024),
      path:
        graph.paths.get(
          'directory_id' in object.body
            ? object.body.directory_id
            : row.item_id,
        ) ?? '/',
      status: conflicted
        ? 'conflicted'
        : object.kind === 'deletion'
          ? 'deleted'
          : object.kind === 'memory_revision'
            ? object.body.state
            : (observed?.status ?? 'unverified'),
      sources:
        object.kind === 'entry_revision' ? object.body.grounds.length : 0,
      ...(row.kind === 'pack_manifest'
        ? {
            installed: !!receipt,
            enabled: available,
            availability: conflicted
              ? 'conflicted'
              : !receipt
                ? 'manifest-only'
                : !receipt.enabled
                  ? 'disabled'
                  : available
                    ? 'available'
                    : 'unavailable',
          }
        : {}),
      ...(row.kind === 'memory_revision'
        ? { ...this.loaded(runtime, row.item_id, row.heads[0]!) }
        : {}),
    };
  }
  private list(runtime: AgentRuntime, p: any): KnowledgeList {
    return this.service(runtime).withStore((store) => {
      if (!store.head)
        return {
          rows: [],
          total: 0,
          more: false,
          folder: '/',
          sync: this.status(runtime),
          incomplete: false,
        };
      const graph = store.graph(store.head),
        query = String(p.query ?? '').trim(),
        section = p.section ?? 'knowledge';
      let search: Set<string> | undefined;
      if (query && section === 'knowledge')
        search = new Set(
          store.search(query, { limit: 100 }).items.map((i) => i.itemId),
        );
      let all = graph.items.filter((i) =>
        section === 'memory'
          ? i.kind === 'memory_revision'
          : section === 'workflows'
            ? i.kind === 'pack_manifest'
            : !['memory_revision', 'pack_manifest'].includes(i.kind),
      );
      const folder = p.folder ? graph.paths.get(p.folder) : '/';
      if (p.folder && !folder) return fail();
      const cache = {
        deferTokens: true,
        observations: new Map(
          store.observations(graph.snapshot).map((o) => [o.object, o]),
        ),
        installations: new Map(
          store.packInstallations().map((o) => [o.object, o]),
        ),
        available: new Set(
          installedPersonalPacks(runtime.options.home).map((p) => p.object),
        ),
      };
      let rows = all
        .map((i) => this.localRow(runtime, store, graph, i, cache))
        .filter((r) => r.status !== 'deleted');
      if (query)
        rows = rows.filter((r) =>
          search
            ? search.has(r.id) ||
              r.title.toLowerCase().includes(query.toLowerCase())
            : (r.title + '\n' + r.path)
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
        );
      else if (section === 'knowledge')
        rows = rows.filter((r) =>
          r.kind === 'folder'
            ? graph.objects.get(
                graph.items.find((i) => i.item_id === r.id)!.heads[0]!,
              )!.kind === 'directory_revision' &&
              (
                graph.objects.get(
                  graph.items.find((i) => i.item_id === r.id)!.heads[0]!,
                ) as any
              ).body.parent_directory ===
                (p.folder ||
                  graph.items.find(
                    (i) =>
                      i.kind === 'directory_revision' &&
                      graph.paths.get(i.item_id) === '/',
                  )?.item_id)
            : r.path === folder,
        );
      if (p.filter && p.filter !== 'all')
        rows = rows.filter((r) => r.status === p.filter || r.kind === p.filter);
      rows.sort(
        (a, b) =>
          Number(b.kind === 'folder') - Number(a.kind === 'folder') ||
          (p.sort === 'kind'
            ? a.kind.localeCompare(b.kind)
            : p.sort === 'status'
              ? a.status.localeCompare(b.status)
              : a.title.localeCompare(b.title)) *
            (p.direction === 'desc' ? -1 : 1) ||
          a.id.localeCompare(b.id),
      );
      const offset = p.offset ?? 0;
      const itemById = new Map(all.map((i) => [i.item_id, i]));
      return {
        rows: rows.slice(offset, offset + 100).map((row) => ({
          ...row,
          token: this.reference({
            snapshot: graph.snapshot,
            object: itemById.get(row.id)!.heads[0]!,
            item: row.id,
          }),
        })),
        total: rows.length,
        more: rows.length > offset + 100,
        folder: folder ?? '/',
        sync: this.status(runtime),
        incomplete: !!query && search?.size === 100,
      };
    });
  }
  private detail(
    runtime: AgentRuntime,
    id: string,
    token: string,
  ): KnowledgeDetail {
    if (this.sources.size > 2000) this.sources.clear();
    const ref = this.current(runtime, id, token);
    return this.service(runtime).withStore((store) => {
      const graph = store.graph(ref.snapshot),
        row = graph.items.find((i) => i.item_id === id)!,
        object = graph.objects.get(ref.object)!,
        view = this.localRow(runtime, store, graph, row);
      const text =
        object.kind === 'memory_revision'
          ? object.body.markdown
          : object.kind === 'entry_revision'
            ? object.body.content.statement
            : object.kind === 'pack_manifest'
              ? object.body.manifest.description
              : object.kind === 'source_revision'
                ? new TextDecoder('utf-8', {
                    fatal: true,
                    ignoreBOM: true,
                  }).decode(store.sourceBytes(ref.object))
                : '';
      const sourcesList: KnowledgeDetail['sourcesList'] = [];
      if (object.kind === 'entry_revision')
        for (const ground of object.body.grounds) {
          const source =
            'source' in ground
              ? graph.objects.get(ground.source)
              : 'entry' in ground
                ? graph.objects.get(ground.entry)
                : undefined;
          const sourceId = randomUUID();
          if (source && ('source' in ground || 'entry' in ground))
            this.sources.set(sourceId, {
              local: {
                snapshot: ref.snapshot,
                object: 'source' in ground ? ground.source : ground.entry,
                item: 'item_id' in source.body ? source.body.item_id : '',
              },
            });
          const quote = bounded(
            graph.objects.get(ground.quotation)?.kind === 'bytes'
              ? decodeBase64(
                  (graph.objects.get(ground.quotation) as any).body
                    .bytes_base64,
                ).toString('utf8')
              : '',
            16000,
          );
          sourcesList.push({
            id: sourceId,
            name: source ? label(source) : '',
            location: 'selector' in ground ? ground.selector : '',
            quotation: quote.text,
            truncated: quote.truncated,
            available: !!source,
          });
        }
      const candidates = row.heads.map((hash) => {
        const o = graph.objects.get(hash)!;
        return {
          token: this.reference({
            snapshot: ref.snapshot,
            object: hash,
            item: id,
          }),
          title: label(o).slice(0, 512),
          text: bounded(
            o.kind === 'memory_revision'
              ? o.body.markdown
              : o.kind === 'entry_revision'
                ? o.body.content.statement
                : label(o),
            4000,
          ).text,
        };
      });
      const seen = new Set<string>(),
        history: KnowledgeDetail['history'] = [];
      for (const snapshot of store.history().slice(-50).reverse()) {
        const g = store.graph(snapshot),
          r = g.items.find((i) => i.item_id === id);
        if (!r) continue;
        for (const object of r.heads)
          if (history.length < 11 && !seen.has(object)) {
            seen.add(object);
            history.push({
              token: this.reference({ snapshot, object, item: id }),
              title: label(g.objects.get(object)!),
              current: row.heads.includes(object),
            });
          }
        if (history.length >= 11) break;
      }
      const mode = this.status(runtime).mode;
      return {
        ...view,
        ...bounded(text, 64000),
        sourcesList,
        candidates,
        history: history.slice(0, 10),
        historyMore: history.length > 10,
        share:
          mode === 'local'
            ? 'local'
            : view.status === 'conflicted' ||
                !['entry', 'memory'].includes(view.kind)
              ? 'unavailable'
              : this.mapping(runtime, ref)
                ? 'ready'
                : 'waiting',
        ...(object.kind === 'pack_manifest'
          ? {
              files: object.body.manifest.files.map((f) => ({
                name: f.path,
                bytes: f.size,
              })),
              description: object.body.manifest.description,
            }
          : {}),
      };
    });
  }
  private mapping(runtime: AgentRuntime, ref: Local): any {
    return syncMapping(
      this.service(runtime),
      runtime.options.settings.knowledge_sync.binding,
      ref.item,
      ref.object,
    );
  }
  private async remoteList(
    runtime: AgentRuntime,
    p: any,
  ): Promise<KnowledgeList> {
    const scope = p.scope ?? 'team',
      section = p.section ?? 'knowledge',
      signal = runtime.knowledgeSignal;
    const base = {
      rows: [] as KnowledgeRow[],
      total: 0,
      more: false,
      folder: '/',
      sync: this.status(runtime),
      incomplete: false,
    };
    if (section === 'workflows') return { ...base, incomplete: true };
    const saved = runtime.options.settings.knowledge_sync.binding;
    const add = (r: Remote, status: KnowledgeRow['status']): KnowledgeRow => {
      if (this.remote.size >= 2000) this.remote.clear();
      const id =
        'remote-' +
        createHash('sha256')
          .update(
            JSON.stringify([
              r.binding,
              r.scope,
              r.kind,
              r.space,
              r.path,
              r.document,
              r.entry,
            ]),
          )
          .digest('hex')
          .slice(0, 24);
      this.remote.set(id, r);
      return {
        id,
        token: id,
        kind: r.kind,
        title: r.title.slice(0, 1024),
        path: r.path,
        status,
        sources: 0,
        ...(r.kind === 'memory'
          ? scope === 'team'
            ? this.loaded(runtime, r.document!, r.version!)
            : { loaded: false }
          : {}),
      };
    };
    if (section === 'memory') {
      const out = envelope(
        await runtime.knowledge.callForPerson(
          'get_nodes',
          { memory: { scope, for_session: false } },
          signal,
        ),
      );
      const page = out.memory_page;
      if (
        !page ||
        page.scope !== scope ||
        !Array.isArray(page.items) ||
        page.items.length > 50
      )
        return fail('knowledge-remote-unavailable');
      for (const row of page.items) {
        if (
          !isObjectId(row.document) ||
          !isObjectId(row.version) ||
          typeof row.title !== 'string' ||
          typeof row.path !== 'string' ||
          (scope === 'team' && row.space !== 'team')
        )
          return fail('knowledge-remote-unavailable');
        base.rows.push(
          add(
            {
              binding: saved,
              scope,
              kind: 'memory',
              document: row.document,
              version: row.version,
              space: row.space,
              path: row.path,
              title: row.title,
              state: row.state,
              auto: row.auto_load_allowed,
            },
            row.state === 'enabled' ? 'enabled' : 'disabled',
          ),
        );
      }
      base.incomplete = page.next !== null;
    } else {
      const query = String(p.query ?? '').trim();
      if (scope === 'shared' && !query) return { ...base, incomplete: true };
      const folder = p.folder ? { path: p.folder } : undefined;
      if (
        folder &&
        (!folder.path.startsWith('/') ||
          folder.path
            .split('/')
            .some((part: string) => part === '..' || part === '.') ||
          folder.path.length > 2000)
      )
        return fail('knowledge-changed');
      const args = query
        ? { search: query, scope }
        : { space: 'team', paths: [folder?.path ?? '/'], depth: 1 };
      const out = envelope(
        await runtime.knowledge.callForPerson('get_nodes', args, signal),
      );
      if (query) {
        for (const row of (out.matches ?? []).slice(0, 100)) {
          if (
            !isObjectId(row.root) ||
            !isObjectId(row.entry) ||
            typeof row.statement !== 'string' ||
            typeof row.path !== 'string' ||
            (scope === 'team' && row.space !== 'team')
          )
            return fail('knowledge-remote-unavailable');
          base.rows.push(
            add(
              {
                binding: saved,
                scope,
                kind: 'entry',
                root: row.root,
                entry: row.entry,
                space: row.space,
                path: row.path,
                title: row.statement,
                state: row.status,
              },
              row.status === 'verified' ? 'verified' : 'unverified',
            ),
          );
        }
        base.incomplete = !!out.warnings?.length;
      } else
        for (const node of (out.nodes ?? []).filter(
          (n: any) => n.path === (folder?.path ?? '/'),
        )) {
          if (
            !isObjectId(out.root) ||
            !Array.isArray(node.entries) ||
            !Array.isArray(node.children)
          )
            return fail('knowledge-remote-unavailable');
          for (const child of node.children.slice(0, 100))
            base.rows.push(
              add(
                {
                  binding: saved,
                  scope,
                  kind: 'folder',
                  root: out.root,
                  space: 'team',
                  path: child.path,
                  title: child.name,
                  state: 'unverified',
                },
                'unverified',
              ),
            );
          for (const row of node.entries.slice(0, 100)) {
            if (!isObjectId(row.entry) || typeof row.statement !== 'string')
              return fail('knowledge-remote-unavailable');
            base.rows.push(
              add(
                {
                  binding: saved,
                  scope,
                  kind: 'entry',
                  root: out.root,
                  entry: row.entry,
                  space: 'team',
                  path: node.path,
                  title: row.statement,
                  state: row.status,
                },
                row.status === 'verified' ? 'verified' : 'unverified',
              ),
            );
          }
        }
    }
    if (p.query && section === 'memory')
      base.rows = base.rows.filter((r) =>
        r.title.toLowerCase().includes(p.query.toLowerCase()),
      );
    base.total = base.rows.length;
    return base;
  }
  private async remoteDetail(
    runtime: AgentRuntime,
    id: string,
  ): Promise<KnowledgeDetail> {
    const r = this.remote.get(id);
    if (!r || r.binding !== runtime.options.settings.knowledge_sync.binding)
      return fail('knowledge-changed');
    let text = '',
      sourcesList: KnowledgeDetail['sourcesList'] = [],
      status: KnowledgeRow['status'] =
        r.state === 'verified'
          ? 'verified'
          : r.state === 'enabled'
            ? 'enabled'
            : r.state === 'disabled'
              ? 'disabled'
              : 'unverified';
    if (r.kind === 'memory') {
      let cursor: string | undefined;
      const seen = new Set<string>();
      let bytes = 0;
      do {
        const out = envelope(
          await runtime.knowledge.callForPerson(
            'get_nodes',
            {
              memory: {
                document: r.document,
                version: r.version,
                ...(cursor ? { cursor } : {}),
              },
            },
            runtime.knowledgeSignal,
          ),
        );
        const d = out.memory_document;
        if (
          !d ||
          d.document !== r.document ||
          d.version !== r.version ||
          d.current_version !== r.version ||
          d.space !== r.space ||
          d.offset !== bytes ||
          typeof d.markdown !== 'string'
        )
          return fail('knowledge-changed');
        bytes += Buffer.byteLength(d.markdown);
        if (bytes > 24000) return fail('knowledge-remote-unavailable');
        text += d.markdown;
        cursor = d.next ?? undefined;
        if (cursor && (seen.has(cursor) || !d.markdown))
          return fail('knowledge-remote-unavailable');
        if (cursor) seen.add(cursor);
      } while (cursor);
    } else if (r.kind === 'entry') {
      const out = envelope(
        await runtime.knowledge.callForPerson(
          'get_nodes',
          { root: r.root, space: r.space, paths: [r.path], depth: 0 },
          runtime.knowledgeSignal,
        ),
      );
      if (out.root !== r.root) return fail('knowledge-changed');
      const entry = out.nodes
        ?.flatMap((n: any) => n.entries)
        .find((e: any) => e.entry === r.entry);
      if (!entry) return fail('knowledge-unavailable');
      text = entry.statement;
      for (const ground of (entry.grounds ?? []).slice(0, 100)) {
        if (
          typeof ground.reference !== 'string' ||
          ground.reference.length > 4000 ||
          typeof ground.quotation !== 'string'
        )
          return fail();
        const key = randomUUID();
        this.sources.set(key, { remote: r, reference: ground.reference });
        sourcesList.push({
          id: key,
          name: '',
          location: '',
          quotation: bounded(ground.quotation, 16000).text,
          truncated: bounded(ground.quotation, 16000).truncated,
          available: true,
        });
      }
    }
    requireClean(Buffer.from(text));
    return {
      id,
      token: id,
      kind: r.kind,
      title: r.title.slice(0, 1024),
      path: r.path,
      status,
      sources: sourcesList.length,
      ...bounded(text, 64000),
      sourcesList,
      candidates: [],
      history: [],
      share: 'unavailable',
      ...(r.kind === 'memory'
        ? r.scope === 'team'
          ? this.loaded(runtime, r.document!, r.version!)
          : { loaded: false }
        : {}),
    };
  }
  private async prepare(
    runtime: AgentRuntime,
    p: any,
  ): Promise<KnowledgePreview> {
    this.editable(runtime);
    const service = this.service(runtime),
      signal = runtime.knowledgeSignal;
    if (p.action === 'mode') {
      if (!['hub', 'local'].includes(p.mode)) return fail();
      const preview = await runtime.knowledge.checkMode(p.mode, signal);
      return this.hold(
        runtime,
        {
          action: 'mode',
          title: p.mode,
          impact: {
            bytes: preview.personal_bytes,
            grants: preview.directory_grants,
            pending: preview.pending_shares,
            teamCopies: preview.team_copies_preserved,
          },
        },
        async () => {
          if (!(await runtime.knowledge.changeMode(p.mode, preview, signal)))
            fail('knowledge-changed');
          return { saved: true };
        },
      );
    }
    if (p.action === 'connect') {
      const selected = runtime.knowledge.preview(p.server);
      return this.hold(
        runtime,
        { action: 'connect', title: p.server },
        async () => {
          await runtime.knowledge.select(p.server, selected.binding);
          return { saved: true };
        },
      );
    }
    if (p.action === 'create-memory') {
      const expected = service.withStore((s) => s.head),
        prepared = service.prepareMemory({
          expected_head: expected,
          title: p.title,
          markdown: p.text,
        });
      return this.hold(
        runtime,
        { action: p.action, title: p.title, text: p.text },
        () => {
          prepared.commit(signal);
          runtime.knowledge.notify();
          return { saved: true };
        },
      );
    }
    if (p.action === 'create-entry' || p.action === 'create-folder') {
      const data = service.withStore((s) => ({
        head: s.head,
        items: s.items(),
        graph: s.head ? s.graph(s.head) : null,
      }));
      const objects: unknown[] = [];
      let root = data.items.find(
        (i) =>
          i.kind === 'directory_revision' &&
          data.graph?.paths.get(i.item_id) === '/',
      )?.item_id;
      if (!root) {
        if (data.items.some((i) => i.kind === 'directory_revision'))
          return fail('knowledge-changed');
        root = randomUUID();
        objects.push({
          schema: 'personal-sync-object@1',
          kind: 'directory_revision',
          body: {
            item_id: root,
            parents: [],
            name: '',
            parent_directory: null,
          },
        });
      }
      const directory = p.destination || root;
      if (
        p.destination &&
        !data.items.some(
          (i) => i.item_id === p.destination && i.kind === 'directory_revision',
        )
      )
        return fail();
      objects.push({
        schema: 'personal-sync-object@1',
        kind:
          p.action === 'create-folder'
            ? 'directory_revision'
            : 'entry_revision',
        body:
          p.action === 'create-folder'
            ? {
                item_id: randomUUID(),
                parents: [],
                parent_directory: directory,
                name: p.title,
              }
            : {
                item_id: randomUUID(),
                parents: [],
                directory_id: directory,
                content: {
                  kind: 'observation',
                  statement: p.text,
                  data: {},
                  applicability: null,
                },
                grounds: [],
              },
      });
      const prepared = service.prepare({ expected_head: data.head, objects });
      return this.hold(
        runtime,
        { action: p.action, title: p.title || p.text, text: p.text },
        () => {
          prepared.commit(signal);
          runtime.knowledge.notify();
          return { saved: true };
        },
      );
    }
    const ref = this.current(runtime, p.id, p.token),
      data = service.withStore((store) => {
        const graph = store.graph(ref.snapshot),
          row = graph.items.find((i) => i.item_id === ref.item)!;
        return { row, object: store.read(ref.object), graph };
      });
    if (p.action === 'share') {
      const prepared = await prepareKnowledgeShare({
        service,
        connection: runtime.knowledge,
        binding: () => runtime.options.settings.knowledge_sync.binding,
        snapshot: ref.snapshot,
        object: ref.object,
        teamPath: p.teamPath,
        signal,
      });
      return this.hold(
        runtime,
        {
          action: 'share',
          title: prepared.title,
          text: p.teamPath || '/',
          replaces: prepared.replaces,
        },
        prepared.run,
      );
    }
    if (p.action === 'pack-enabled') {
      if (
        data.object.kind !== 'pack_manifest' ||
        typeof p.enabled !== 'boolean'
      )
        return fail();
      return this.hold(
        runtime,
        { action: p.enabled ? 'enable' : 'disable', title: label(data.object) },
        async () => {
          await setPersonalPackEnabled({
            home: runtime.options.home,
            snapshot: ref.snapshot,
            object: ref.object,
            enabled: p.enabled,
            signal,
            approve: async () => 'approve',
          });
          runtime.refreshPrompt();
          return { saved: true };
        },
      );
    }
    if (data.row.heads.length > 1 && p.action !== 'resolve')
      return fail('knowledge-resolve-first');
    let object: any = structuredClone(data.object);
    if (p.action === 'resolve') {
      const candidate = this.refs.get(p.candidate);
      if (
        !candidate ||
        candidate.item !== ref.item ||
        candidate.snapshot !== ref.snapshot ||
        !data.row.heads.includes(candidate.object)
      )
        return fail('knowledge-changed');
      object = service.withStore((s) => s.read(candidate.object));
      object = structuredClone(object);
      if (p.text !== undefined && object.kind === 'memory_revision')
        object.body.markdown = p.text;
      if (p.text !== undefined && object.kind === 'entry_revision')
        object.body.content.statement = p.text;
    } else if (p.action === 'delete')
      object = {
        schema: 'personal-sync-object@1',
        kind: 'deletion',
        body: {
          item_id: ref.item,
          target_kind: data.row.kind,
          parents: data.row.heads,
        },
      };
    else if (p.action === 'edit') {
      if (object.kind === 'memory_revision') {
        object.body.markdown = p.text;
        object.body.title = p.title ?? object.body.title;
      } else if (object.kind === 'entry_revision')
        object.body.content.statement = p.text;
      else if (
        object.kind === 'directory_revision' ||
        object.kind === 'source_revision'
      )
        object.body.name = p.title;
      else return fail();
    } else if (p.action === 'enabled') {
      if (object.kind !== 'memory_revision' || typeof p.enabled !== 'boolean')
        return fail();
      object.body.state = p.enabled ? 'enabled' : 'disabled';
    } else if (p.action === 'move') {
      const destination = data.graph.items.find(
        (i) => i.item_id === p.destination && i.kind === 'directory_revision',
      );
      if (!destination) return fail();
      if (object.kind === 'directory_revision')
        object.body.parent_directory = destination.item_id;
      else if ('directory_id' in object.body)
        object.body.directory_id = destination.item_id;
      else return fail();
    } else return fail();
    object.body.parents = data.row.heads;
    const prepared = service.prepare({
      expected_head: ref.snapshot,
      objects: [object],
    });
    return this.hold(
      runtime,
      { action: p.action, title: label(data.object), text: p.text },
      () => {
        prepared.commit(signal);
        runtime.knowledge.notify();
        return { saved: true };
      },
    );
  }
  async execute(
    runtime: AgentRuntime,
    value: unknown,
    nativeSelection = false,
  ): Promise<unknown> {
    const result = await this.executeHost(runtime, value, nativeSelection);
    this.safe(runtime, result);
    return result;
  }
  private async executeHost(
    runtime: AgentRuntime,
    value: unknown,
    nativeSelection = false,
  ): Promise<unknown> {
    const p = validateKnowledgeRequest(value, nativeSelection);
    try {
      if (p.op === 'settings')
        return {
          sync: this.status(runtime),
          connections: runtime.knowledge
            .connections()
            .map((c) => ({ name: c.name })),
          folders: this.service(runtime).withStore((s) =>
            s.head
              ? s
                  .graph(s.head)
                  .items.filter(
                    (i) =>
                      i.kind === 'directory_revision' && i.heads.length === 1,
                  )
                  .map((i) => ({
                    id: i.item_id,
                    path: s.graph(s.head!).paths.get(i.item_id) ?? '/',
                  }))
              : [],
          ),
        };
      if (p.op === 'list')
        return p.scope && p.scope !== 'personal'
          ? await this.remoteList(runtime, p)
          : this.list(runtime, p);
      if (p.op === 'detail')
        return this.remote.has(p.id)
          ? await this.remoteDetail(runtime, p.id)
          : this.detail(runtime, p.id, p.token);
      if (p.op === 'edit-body') {
        const ref = this.current(runtime, p.id, p.token);
        return this.service(runtime).withStore((s) => {
          const o = s.read(ref.object);
          return {
            title: label(o),
            text:
              o.kind === 'entry_revision'
                ? o.body.content.statement
                : o.kind === 'memory_revision'
                  ? o.body.markdown
                  : '',
          };
        });
      }
      if (p.op === 'history')
        return this.detail(runtime, p.id, p.token).history;
      if (p.op === 'source') {
        const source =
          this.sources.get(p.id) ??
          (this.refs.has(p.id)
            ? {
                local: this.refs.get(p.id),
                remote: undefined,
                reference: undefined,
              }
            : undefined);
        if (!source) return fail();
        if (source.local)
          return this.service(runtime).withStore((s) => {
            const object = s
              .graph(source.local!.snapshot)
              .objects.get(source.local!.object);
            if (!object) return fail();
            return {
              name: label(object),
              ...bounded(
                object.kind === 'source_revision'
                  ? new TextDecoder('utf-8', {
                      fatal: true,
                      ignoreBOM: true,
                    }).decode(s.sourceBytes(source.local!.object))
                  : object.kind === 'entry_revision'
                    ? object.body.content.statement
                    : object.kind === 'memory_revision'
                      ? object.body.markdown
                      : '',
                64000,
              ),
            };
          });
        if (
          source.remote?.binding !==
          runtime.options.settings.knowledge_sync.binding
        )
          return fail();
        const out = envelope(
          await runtime.knowledge.callForPerson(
            'get_nodes',
            { reference: source.reference },
            runtime.knowledgeSignal,
          ),
        );
        if (!out.content?.readable || typeof out.content.text !== 'string')
          return fail();
        return { name: '', ...bounded(out.content.text, 64000) };
      }
      if (p.op === 'prepare') return await this.prepare(runtime, p);
      if (p.op === 'cancel') {
        this.tickets.delete(p.ticket);
        return { saved: false };
      }
      if (p.op === 'confirm') {
        this.editable(runtime);
        const ticket = this.tickets.get(p.ticket);
        this.tickets.delete(p.ticket);
        if (
          p.confirmed !== true ||
          !ticket ||
          ticket.owner !== runtime.session.id ||
          ticket.expires <= Date.now()
        )
          return fail('knowledge-preview-expired');
        return await ticket.run();
      }
      if (p.op === 'sync') {
        await runtime.knowledge.synchronize();
        return this.status(runtime);
      }
      if (p.op === 'refresh-memory') {
        await runtime.refreshSessionMemory();
        return { saved: true };
      }
      if (p.op === 'disconnect') {
        await runtime.knowledge.disconnect();
        return this.status(runtime);
      }
      if (p.op === 'login') {
        this.editable(runtime);
        const configured = buildMcpConnections(
          runtime.options.settings.mcp_servers,
        ).connections.find((c) => c.name === runtime.knowledge.status().server);
        if (!configured?.url) return fail('knowledge-select-connection');
        if (
          Object.keys(configured.headers ?? {}).some(
            (n) =>
              /^(?:proxy-)?authorization$/i.test(n) || secretLookingName(n),
          )
        )
          return fail('knowledge-configured-credential');
        await runtime.knowledge.close();
        forgetAuthorization(runtime.options.home, new URL(configured.url).href);
        await runtime.reloadIntegrations();
        return { saved: true };
      }
      if (p.op === 'prepare-import') {
        this.editable(runtime);
        this.nativePath(runtime, p.path);
        const { path, bytes } = await readFileBytes(
          runtime.sandbox,
          undefined,
          p.path,
          { signal: runtime.knowledgeSignal, sessionId: runtime.session.id },
          1 << 20,
        );
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const service = this.service(runtime),
          data = service.withStore((s) => ({
            head: s.head,
            graph: s.head ? s.graph(s.head) : null,
            items: s.items(),
          })),
          objects: SyncObject[] = [];
        let directory =
          p.destination ??
          data.items.find(
            (i) =>
              i.kind === 'directory_revision' &&
              data.graph?.paths.get(i.item_id) === '/',
          )?.item_id;
        if (
          p.destination &&
          !data.items.some(
            (i) =>
              i.item_id === p.destination && i.kind === 'directory_revision',
          )
        )
          return fail('knowledge-changed');
        if (!directory) {
          if (data.items.some((i) => i.kind === 'directory_revision'))
            return fail('knowledge-changed');
          directory = randomUUID();
          objects.push({
            schema: 'personal-sync-object@1',
            kind: 'directory_revision',
            body: {
              item_id: directory,
              parents: [],
              name: '',
              parent_directory: null,
            },
          });
        }
        const chunk: SyncObject = {
          schema: 'personal-sync-object@1',
          kind: 'bytes',
          body: { bytes_base64: bytes.toString('base64') },
        };
        objects.push(chunk, {
          schema: 'personal-sync-object@1',
          kind: 'source_revision',
          body: {
            item_id: randomUUID(),
            parents: [],
            directory_id: directory,
            name: basename(path),
            media_type:
              extname(path) === '.json'
                ? 'application/json'
                : extname(path) === '.md'
                  ? 'text/markdown'
                  : 'text/plain',
            raw_sha256: sha256(bytes),
            size: bytes.length,
            chunks: [syncObjectId(chunk)],
          },
        });
        const prepared = service.prepare({ expected_head: data.head, objects });
        return this.hold(
          runtime,
          {
            action: 'import',
            title: basename(path),
            text: bytes.toString('utf8'),
          },
          () => {
            prepared.commit(runtime.knowledgeSignal);
            runtime.knowledge.notify();
            return { saved: true };
          },
        );
      }
      if (p.op === 'prepare-register') {
        this.editable(runtime);
        this.nativePath(runtime, p.directory);
        const manifest = await inspectPersonalPackFolder(p.directory),
          service = this.service(runtime),
          expected = service.withStore((s) => s.head);
        const prepared = service.prepare({
          expected_head: expected,
          objects: [
            {
              schema: 'personal-sync-object@1',
              kind: 'pack_manifest',
              body: { item_id: randomUUID(), parents: [], manifest },
            },
          ],
        });
        return this.hold(
          runtime,
          {
            action: 'register-pack',
            title: manifest.title,
            files: manifest.files.map((f) => ({ name: f.path, bytes: f.size })),
          },
          async () => {
            const current = await inspectPersonalPackFolder(p.directory);
            if (JSON.stringify(current) !== JSON.stringify(manifest))
              return fail('knowledge-changed');
            prepared.commit(runtime.knowledgeSignal);
            runtime.knowledge.notify();
            return { saved: true };
          },
        );
      }
      if (p.op === 'prepare-install') {
        this.editable(runtime);
        this.nativePath(runtime, p.directory);
        const ref = this.current(runtime, p.id, p.token),
          object = this.service(runtime).withStore((s) => s.read(ref.object));
        if (object.kind !== 'pack_manifest') return fail();
        await inspectPersonalPack({
          home: runtime.options.home,
          snapshot: ref.snapshot,
          object: ref.object,
          directory: p.directory,
          workspace: runtime.options.workspace,
          userHome: runtime.options.userHome ?? runtime.options.home,
        });
        return this.hold(
          runtime,
          {
            action: 'install',
            title: object.body.manifest.title,
            files: object.body.manifest.files.map((f) => ({
              name: f.path,
              bytes: f.size,
            })),
          },
          async () => {
            this.current(runtime, p.id, p.token);
            await installPersonalPack({
              home: runtime.options.home,
              snapshot: ref.snapshot,
              object: ref.object,
              directory: p.directory,
              workspace: runtime.options.workspace,
              userHome: runtime.options.userHome ?? runtime.options.home,
              signal: runtime.knowledgeSignal,
              approve: async () => 'approve',
            });
            runtime.refreshPrompt();
            return { saved: true };
          },
        );
      }
      return fail();
    } catch (error) {
      if (error instanceof KnowledgeVersionConflict)
        throw Error('knowledge-changed');
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith('knowledge-')) throw error;
      if (/credential|scan incomplete/.test(message))
        throw Error('knowledge-credential-rejected');
      if (/limit|oversized|too large/.test(message))
        throw Error('knowledge-limit');
      throw Error('knowledge-unavailable');
    }
  }
}
