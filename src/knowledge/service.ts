import { randomUUID } from 'node:crypto';
import {
  KnowledgeStore,
  KnowledgeVersionConflict,
  type SearchOptions,
} from './store.js';
import { computeObjectDigest, encodeSyncObject, sha256 } from './canonical.js';
import { validateGraph, itemKey } from './graph.js';
import { decodeBase64, isObjectId, SYNC_LIMITS } from './protocol.js';
import { itemKind, type ItemObject, type SyncObject } from './types.js';
import { requireClean } from './verification.js';

export const SOURCE_CHUNK_BYTES = 262_144;

export interface KnowledgeAccess {
  /** Host-authored task lock; model arguments cannot relax it. */
  locked?: boolean;
  addresses?: readonly { snapshot: string; object: string }[];
}
export interface ChangeInput {
  expected_head: string | null;
  objects: unknown[];
}
export interface PreparedKnowledgeChange {
  preview: {
    expected_head: string | null;
    snapshot: string;
    objects: { id: string; object: SyncObject }[];
  };
  commit(signal: AbortSignal): string;
}
const envelope = (kind: SyncObject['kind'], body: unknown): unknown => ({
  schema: 'personal-sync-object@1',
  kind,
  body,
});
export function chunkSourceBytes(raw: Buffer): {
  chunks: { id: string; object: unknown }[];
  rawSha256: string;
  size: number;
} {
  const chunks: { id: string; object: unknown }[] = [];
  for (
    let offset = 0;
    offset < raw.length || offset === 0;
    offset += SOURCE_CHUNK_BYTES
  ) {
    const slice = raw.subarray(offset, offset + SOURCE_CHUNK_BYTES);
    const object = envelope('bytes', {
      bytes_base64: slice.toString('base64'),
    });
    chunks.push({ id: computeObjectDigest(object), object });
    if (raw.length === 0) break;
  }
  return {
    chunks,
    rawSha256: sha256(raw),
    size: raw.length,
  };
}
const normalized = (
  input: unknown,
): { id: string; bytes: Buffer; object: SyncObject } => {
  const bytes = encodeSyncObject(input),
    id = sha256(bytes);
  return {
    id,
    bytes,
    object: JSON.parse(bytes.toString('utf8')) as SyncObject,
  };
};
/** Opens only the explicitly supplied runtime home; no network or account resolution. */
export class KnowledgeService {
  constructor(
    readonly home: string,
    readonly access: () => KnowledgeAccess = () => ({}),
  ) {}
  withStore<T>(use: (store: KnowledgeStore) => T): T {
    const store = new KnowledgeStore(this.home);
    try {
      return use(store);
    } finally {
      store.close();
    }
  }
  search(query: string, options: SearchOptions = {}) {
    if (this.access().locked)
      throw Error(
        'locked tasks require an explicit immutable address; search cannot supply task inputs',
      );
    if (Buffer.byteLength(query) > 4096) throw Error('knowledge query limit');
    return this.withStore((store) => store.search(query, options));
  }
  read(snapshot: string, object: string, offset = 0, limit = 8000) {
    if (
      !isObjectId(snapshot) ||
      !isObjectId(object) ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 16000
    )
      throw Error('invalid knowledge read window');
    const access = this.access();
    if (
      access.locked &&
      !access.addresses?.some(
        (a) => a.snapshot === snapshot && a.object === object,
      )
    )
      throw Error('address is outside the task lock');
    return this.withStore((store) => {
      const graph = store.graph(snapshot);
      if (!graph.objects.has(object))
        throw Error('object is outside the addressed snapshot');
      const value = graph.objects.get(object)!;
      const content = JSON.stringify(value);
      return {
        snapshot,
        object,
        kind: value.kind,
        text: content.slice(offset, offset + limit),
        next: offset + limit < content.length ? offset + limit : null,
        verification:
          store.observations(snapshot).find((row) => row.object === object) ??
          null,
      };
    });
  }
  prepare(input: ChangeInput): PreparedKnowledgeChange {
    if (this.access().locked)
      throw Error('locked tasks cannot change personal knowledge');
    const expectedHead = input.expected_head;
    if (input.expected_head !== null && !isObjectId(input.expected_head))
      throw Error('expected_head is required');
    if (
      !Array.isArray(input.objects) ||
      !input.objects.length ||
      input.objects.length > SYNC_LIMITS.batchObjects
    )
      throw Error('knowledge change object limit');
    let size = 0;
    const proposed = input.objects.map((input) => {
      const entry = normalized(input);
      size += entry.bytes.length;
      return { id: entry.id, object: entry.object };
    });
    if (size > SYNC_LIMITS.objectBytes)
      throw Error('knowledge change byte limit');
    for (const { object } of proposed)
      requireClean(
        object.kind === 'bytes'
          ? decodeBase64(object.body.bytes_base64)
          : Buffer.from(JSON.stringify(object)),
      );
    return this.withStore((store) => {
      if (store.head !== input.expected_head)
        throw new KnowledgeVersionConflict(store.head);
      const items = store
        .items()
        .map(({ kind, item_id, heads }) => ({ kind, item_id, heads }));
      const pending = new Map(proposed.map((p) => [p.id, p.object]));
      const identities = new Set<string>();
      for (const { id, object } of proposed) {
        if (object.kind === 'bytes') continue;
        if (!('item_id' in object.body))
          throw Error(
            'submit revisions only; inventories and snapshots are generated locally',
          );
        const revision = object as ItemObject;
        if (identities.has(revision.body.item_id))
          throw Error('one new head per identity');
        identities.add(revision.body.item_id);
        const previous = items.find(
          (row) => row.item_id === revision.body.item_id,
        );
        if (previous && previous.kind !== itemKind(revision))
          throw Error('identity kind cannot change');
        if (
          JSON.stringify(revision.body.parents) !==
          JSON.stringify(previous?.heads ?? [])
        )
          throw Error('revision must continue every current conflict head');
        if (previous) previous.heads = [id];
        else
          items.push({
            kind: itemKind(revision),
            item_id: revision.body.item_id,
            heads: [id],
          });
      }
      items.sort((a, b) => (itemKey(a) < itemKey(b) ? -1 : 1));
      const generated: { id: string; object: SyncObject }[] = [];
      const add = (input: unknown) => {
        const { id, object } = normalized(input);
        pending.set(id, object);
        generated.push({ id, object });
        return id;
      };
      const pages: string[] = [];
      for (let i = 0; i < items.length; i += SYNC_LIMITS.pageItems)
        pages.push(
          add(
            envelope('inventory_page', {
              items: items.slice(i, i + SYNC_LIMITS.pageItems),
            }),
          ),
        );
      const snapshot = add(
        envelope('snapshot', {
          parents: store.head ? [store.head] : [],
          pages: pages.sort(),
        }),
      );
      const graph = validateGraph(
        snapshot,
        (id) => pending.get(id) ?? store.read(id),
      );
      let count = 0,
        total = 0;
      for (const item of graph.items) {
        let memoryBytes: number | null = null;
        for (const id of item.heads) {
          const object = graph.objects.get(id)!;
          if (object.kind === 'source_revision' && pending.has(id)) {
            const bytes = Buffer.concat(
              object.body.chunks.map((id) => {
                const chunk = graph.objects.get(id)!;
                if (chunk.kind !== 'bytes')
                  throw Error('source chunk unavailable');
                return decodeBase64(chunk.body.bytes_base64);
              }),
            );
            requireClean(bytes);
          }
          if (object.kind === 'memory_revision') {
            const path = graph.paths.get(object.body.directory_id);
            if (Buffer.byteLength(object.body.markdown) > 24000)
              throw Error('memory document exceeds 24000 UTF-8 bytes');
            if (
              item.heads.length > 1 ||
              path == null ||
              object.body.state === 'enabled'
            ) {
              const bytes =
                Buffer.byteLength(object.body.title + object.body.markdown) +
                (path == null ? 8000 : Buffer.byteLength(path));
              memoryBytes = Math.max(memoryBytes ?? 0, bytes);
            }
          }
        }
        if (memoryBytes !== null) {
          count++;
          total += memoryBytes;
        }
      }
      if (count > 20 || total > 48000)
        throw Error('memory space exceeds 20 documents or 48000 UTF-8 bytes');
      const preview = {
        expected_head: input.expected_head,
        snapshot,
        objects: proposed,
      };
      const frozen = JSON.stringify([...proposed, ...generated]);
      return {
        preview: JSON.parse(JSON.stringify(preview)),
        commit: (signal) => {
          signal.throwIfAborted();
          if (this.access().locked)
            throw Error('locked tasks cannot change personal knowledge');
          return this.withStore((current) =>
            current.apply(expectedHead, () => {
              signal.throwIfAborted();
              current.putBatch(
                (JSON.parse(frozen) as typeof proposed).map((p) => p.object),
              );
              return snapshot;
            }),
          );
        },
      };
    });
  }
  prepareMemory(args: {
    expected_head: string | null;
    item_id?: string;
    directory_id?: string;
    title?: string;
    markdown?: string;
    state?: 'enabled' | 'disabled';
    delete?: boolean;
  }): PreparedKnowledgeChange {
    const objects: unknown[] = [];
    this.withStore((store) => {
      const rows = store.items(),
        previous = args.item_id
          ? rows.find((i) => i.item_id === args.item_id)
          : undefined;
      if (args.item_id && !previous) throw Error('memory identity unavailable');
      if (previous?.kind && previous.kind !== 'memory_revision')
        throw Error('not a memory');
      const priorRevision =
        previous?.heads.length === 1
          ? store.read(previous.heads[0]!)
          : undefined;
      const priorBody =
        priorRevision?.kind === 'memory_revision'
          ? priorRevision.body
          : undefined;
      const root = rows.find(
        (i) => i.kind === 'directory_revision' && i.path === '/',
      );
      const directory =
        args.directory_id ??
        priorBody?.directory_id ??
        root?.item_id ??
        randomUUID();
      if (!root && !args.directory_id && !priorBody)
        objects.push(
          envelope('directory_revision', {
            item_id: directory,
            parents: [],
            parent_directory: null,
            name: '',
          }),
        );
      if (args.delete && !previous) throw Error('memory identity required');
      objects.push(
        args.delete
          ? envelope('deletion', {
              item_id: args.item_id,
              parents: previous!.heads,
              target_kind: 'memory_revision',
            })
          : envelope('memory_revision', {
              item_id: args.item_id ?? randomUUID(),
              parents: previous?.heads ?? [],
              directory_id: directory,
              title: args.title ?? priorBody?.title,
              markdown: args.markdown ?? priorBody?.markdown,
              state: args.state ?? priorBody?.state ?? 'enabled',
            }),
      );
    });
    return this.prepare({ expected_head: args.expected_head, objects });
  }
  prepareHostCapture(args: {
    expected_head: string | null;
    name: string;
    originKind: 'exec' | 'terminal' | 'tool';
    label: string;
    content: Buffer | string;
    directory_id?: string;
    statement?: string;
    selector?: string;
  }): PreparedKnowledgeChange {
    const raw =
      typeof args.content === 'string'
        ? Buffer.from(args.content, 'utf8')
        : args.content;
    const { chunks, rawSha256, size } = chunkSourceBytes(raw);
    const objects: unknown[] = [];
    const seenChunks = new Set<string>();
    let directory = args.directory_id;
    this.withStore((store) => {
      const rows = store.items(),
        root = rows.find(
          (i) => i.kind === 'directory_revision' && i.path === '/',
        );
      directory = directory ?? root?.item_id ?? randomUUID();
      if (!root && !args.directory_id)
        objects.push(
          envelope('directory_revision', {
            item_id: directory,
            parents: [],
            parent_directory: null,
            name: '',
          }),
        );
    });
    for (const chunk of chunks) {
      if (!seenChunks.has(chunk.id)) {
        seenChunks.add(chunk.id);
        objects.push(chunk.object);
      }
    }
    const sourceObject = envelope('source_revision', {
      item_id: randomUUID(),
      parents: [],
      directory_id: directory!,
      name: (args.name || args.label || 'capture.txt').slice(0, 300),
      media_type: `text/plain; charset=utf-8; circle-origin=${args.originKind}`,
      raw_sha256: rawSha256,
      size,
      chunks: chunks.map((c) => c.id),
    });
    const sourceId = computeObjectDigest(sourceObject);
    objects.push(sourceObject);
    if (args.statement) {
      const firstLine = Buffer.from(
        raw.toString('utf8').split(/\r?\n/)[0] ?? '',
        'utf8',
      );
      const quoteObject = envelope('bytes', {
        bytes_base64: firstLine.toString('base64'),
      });
      const quoteId = computeObjectDigest(quoteObject);
      if (!seenChunks.has(quoteId)) {
        seenChunks.add(quoteId);
        objects.push(quoteObject);
      }
      objects.push(
        envelope('entry_revision', {
          item_id: randomUUID(),
          parents: [],
          directory_id: directory!,
          content: {
            kind: 'observation',
            statement: args.statement,
            data: {
              origin: { kind: args.originKind, label: args.label },
            },
            applicability: null,
          },
          grounds: [
            {
              source: sourceId,
              quotation: quoteId,
              parser: 'text@1',
              selector: args.selector ?? 'l/1',
            },
          ],
        }),
      );
    }
    return this.prepare({ expected_head: args.expected_head, objects });
  }
  prepareMemoryPromotion(args: {
    expected_head: string | null;
    title: string;
    markdown: string;
    directory_id?: string;
  }): PreparedKnowledgeChange {
    return this.prepareMemory({
      expected_head: args.expected_head,
      directory_id: args.directory_id,
      title: args.title,
      markdown: args.markdown,
      state: 'enabled',
    });
  }
}
