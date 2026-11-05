import { createHash } from 'node:crypto';
import { decodeBase64 } from './protocol.js';
import {
  itemKind,
  type ItemObject,
  type SyncItem,
  type SyncObject,
} from './types.js';

export interface SnapshotGraph {
  snapshot: string;
  items: SyncItem[];
  objects: ReadonlyMap<string, SyncObject>;
  paths: Map<string, string | null>;
  conflicts: { item_id: string; heads: string[]; structural?: true }[];
}
export interface ValidateGraphOptions {
  allowStructuralConflicts?: boolean;
  trustedObjects?: ReadonlySet<string>;
  cacheBytes?: number;
}
const MAX_GRAPH_OBJECTS = 100_000;
const MAX_GRAPH_DEPTH = 512;
export const MAX_LOCAL_SOURCE_BYTES = 32 * 1024 * 1024;
class GraphObjects implements ReadonlyMap<string, SyncObject> {
  private readonly ids = new Set<string>();
  private readonly cache = new Map<
    string,
    { object: SyncObject; bytes: number }
  >();
  private bytes = 0;
  constructor(
    private readonly read: (id: string) => SyncObject,
    private readonly maxCacheBytes = 8 * 1024 * 1024,
  ) {}
  get size(): number {
    return this.ids.size;
  }
  has(id: string): boolean {
    return this.ids.has(id);
  }
  add(id: string, object: SyncObject): void {
    this.ids.add(id);
    this.remember(id, object);
  }
  private remember(id: string, object: SyncObject): void {
    const bytes = Buffer.byteLength(JSON.stringify(object));
    while (this.bytes + bytes > this.maxCacheBytes && this.cache.size) {
      const oldest = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
    if (bytes <= this.maxCacheBytes) {
      this.cache.set(id, { object, bytes });
      this.bytes += bytes;
    }
  }
  get(id: string): SyncObject | undefined {
    if (!this.ids.has(id)) return undefined;
    const kept = this.cache.get(id);
    if (kept) return kept.object;
    const object = this.read(id);
    this.remember(id, object);
    return object;
  }
  keys(): SetIterator<string> {
    return this.ids.keys();
  }
  *values(): MapIterator<SyncObject> {
    for (const id of this.ids) yield this.get(id)!;
  }
  *entries(): MapIterator<[string, SyncObject]> {
    for (const id of this.ids) yield [id, this.get(id)!];
  }
  [Symbol.iterator](): MapIterator<[string, SyncObject]> {
    return this.entries();
  }
  forEach(
    callback: (
      value: SyncObject,
      key: string,
      map: ReadonlyMap<string, SyncObject>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const id of this.ids) callback.call(thisArg, this.get(id)!, id, this);
  }
}
export const itemKey = (item: Pick<SyncItem, 'kind' | 'item_id'>): string =>
  `${item.kind}:${item.item_id}`;
export const objectParents = (object: SyncObject): string[] =>
  'parents' in object.body ? object.body.parents : [];
function failure(rule: string): never {
  throw new TypeError(`invalid knowledge graph: ${rule}`);
}

function references(object: SyncObject): string[] {
  const parents = objectParents(object);
  switch (object.kind) {
    case 'snapshot':
      return [...parents, ...object.body.pages];
    case 'inventory_page':
      return object.body.items.flatMap((item) => item.heads);
    case 'source_revision':
      return parents;
    case 'entry_revision':
      return [
        ...parents,
        ...object.body.grounds.flatMap((g) => [
          ...('source' in g ? [g.source] : 'entry' in g ? [g.entry] : []),
          g.quotation,
        ]),
      ];
    default:
      return parents;
  }
}
function isItem(object: SyncObject): object is ItemObject {
  return 'item_id' in object.body;
}
function requireKind(
  objects: ReadonlyMap<string, SyncObject>,
  id: string,
  kind: SyncObject['kind'],
): SyncObject {
  const object = objects.get(id);
  if (object?.kind !== kind) return failure(`expected ${kind}`);
  return object;
}
function inventory(
  snapshot: SyncObject<'snapshot'>,
  objects: ReadonlyMap<string, SyncObject>,
): SyncItem[] {
  const items: SyncItem[] = [],
    ids = new Set<string>();
  for (const id of snapshot.body.pages) {
    const page = requireKind(
      objects,
      id,
      'inventory_page',
    ) as SyncObject<'inventory_page'>;
    for (const item of page.body.items) {
      if (ids.has(item.item_id)) failure('duplicate inventory identity');
      ids.add(item.item_id);
      items.push(item);
      for (const head of item.heads) {
        const object = objects.get(head)!;
        if (
          !isItem(object) ||
          object.body.item_id !== item.item_id ||
          itemKind(object) !== item.kind
        )
          failure('head identity');
      }
      for (const head of item.heads)
        if (
          item.heads.some(
            (other) => other !== head && hasAncestor(objects, other, head),
          )
        )
          failure('redundant ancestor head');
    }
  }
  return items.sort((a, b) =>
    itemKey(a) < itemKey(b) ? -1 : itemKey(a) > itemKey(b) ? 1 : 0,
  );
}
function pathName(name: string): boolean {
  return (
    name.length > 0 &&
    !['.', '..'].includes(name) &&
    !/[\/\\\u0000-\u001f\u007f]/.test(name)
  );
}
export function validateGraph(
  snapshotId: string,
  read: (id: string) => SyncObject,
  options: boolean | ValidateGraphOptions = false,
): SnapshotGraph {
  const allowStructuralConflicts =
    typeof options === 'boolean'
      ? options
      : (options.allowStructuralConflicts ?? false);
  const trustedObjects =
    typeof options === 'boolean' ? undefined : options.trustedObjects;
  const cacheBytes =
    typeof options === 'boolean' ? undefined : options.cacheBytes;
  const objects = new GraphObjects(read, cacheBytes),
    active = new Set<string>();
  const visit = (id: string, depth: number): void => {
    if (active.has(id)) failure('object cycle');
    if (objects.has(id)) return;
    if (depth > MAX_GRAPH_DEPTH || objects.size >= MAX_GRAPH_OBJECTS)
      failure('graph limit');
    active.add(id);
    const object = read(id);
    objects.add(id, object);
    if (
      object.kind === 'source_revision' &&
      object.body.size > MAX_LOCAL_SOURCE_BYTES
    )
      failure('local source byte limit');
    for (const child of references(object)) visit(child, depth + 1);
    if (object.kind === 'source_revision') {
      if (
        trustedObjects?.has(id) &&
        object.body.chunks.every((chunk) => trustedObjects.has(chunk))
      ) {
        for (const chunk of object.body.chunks) {
          visit(chunk, depth + 1);
          requireKind(objects, chunk, 'bytes');
        }
      } else {
        const hash = createHash('sha256');
        let size = 0;
        for (const chunk of object.body.chunks) {
          visit(chunk, depth + 1);
          const bytes = requireKind(
            objects,
            chunk,
            'bytes',
          ) as SyncObject<'bytes'>;
          const raw = decodeBase64(bytes.body.bytes_base64);
          size += raw.length;
          if (size > object.body.size || size > MAX_LOCAL_SOURCE_BYTES)
            failure('raw source size');
          hash.update(raw);
        }
        if (
          size !== object.body.size ||
          hash.digest('hex') !== object.body.raw_sha256
        )
          failure('raw source size or hash');
      }
    }
    active.delete(id);
  };
  visit(snapshotId, 0);
  const snapshot = requireKind(
    objects,
    snapshotId,
    'snapshot',
  ) as SyncObject<'snapshot'>;
  for (const object of objects.values()) {
    for (const id of objectParents(object)) {
      const parent = objects.get(id)!;
      if (object.kind === 'snapshot') {
        if (parent.kind !== 'snapshot') failure('snapshot parent');
      } else if (
        !isItem(object) ||
        !isItem(parent) ||
        object.body.item_id !== parent.body.item_id ||
        itemKind(object) !== itemKind(parent)
      )
        failure('revision parent');
    }
    if (object.kind === 'snapshot') inventory(object, objects);
    if (object.kind === 'entry_revision')
      for (const ground of object.body.grounds) {
        if ('source' in ground)
          requireKind(objects, ground.source, 'source_revision');
        if ('entry' in ground)
          requireKind(objects, ground.entry, 'entry_revision');
        requireKind(objects, ground.quotation, 'bytes');
      }
  }
  const items = inventory(snapshot, objects);
  const directories = new Map<string, SyncItem>(
    items
      .filter((item) => item.kind === 'directory_revision')
      .map((item) => [item.item_id, item]),
  );
  const paths = new Map<string, string | null>(),
    roots = new Set<string>(),
    names = new Set<string>();
  for (const item of directories.values())
    for (const head of item.heads) {
      const object = objects.get(head)!;
      if (object.kind === 'deletion') continue;
      if (object.kind !== 'directory_revision') failure('directory head');
      if (object.body.parent_directory === null) {
        roots.add(item.item_id);
        if (object.body.name !== '') failure('root name');
      } else if (
        !pathName(object.body.name) ||
        !directories.has(object.body.parent_directory)
      )
        failure('directory parent or name');
    }
  if (
    (directories.size > 0 && roots.size !== 1) ||
    (directories.size === 0 &&
      items.some((item) => item.kind !== 'pack_manifest'))
  )
    failure('exactly one root directory');
  const resolving = new Set<string>();
  const locate = (id: string, depth = 0): string | null => {
    if (paths.has(id)) return paths.get(id)!;
    if (resolving.has(id) || depth > MAX_GRAPH_DEPTH)
      failure('directory cycle or depth');
    const item = directories.get(id);
    if (!item) return failure('directory missing');
    resolving.add(id);
    let result: string | null = null;
    for (const head of item.heads) {
      const object = objects.get(head)!;
      if (object.kind === 'deletion') continue;
      if (object.kind !== 'directory_revision')
        return failure('directory head');
      const parent =
        object.body.parent_directory === null
          ? ''
          : locate(object.body.parent_directory, depth + 1);
      if (item.heads.length === 1)
        result =
          parent === null
            ? null
            : `${parent === '/' ? '' : parent}/${object.body.name}` || '/';
    }
    resolving.delete(id);
    paths.set(id, result);
    return result;
  };
  for (const id of directories.keys()) {
    const path = locate(id);
    if (path !== null) {
      if (names.has(path) && !allowStructuralConflicts)
        failure('duplicate directory path');
      names.add(path);
    }
  }
  for (const item of items)
    for (const head of item.heads) {
      const object = objects.get(head)!;
      if (
        'directory_id' in object.body &&
        !directories.has(object.body.directory_id)
      )
        failure('item directory missing');
    }
  const conflicted = new Set(
    items.filter((i) => i.heads.length > 1).map((i) => i.item_id),
  );
  const entries = new Map<string, string[]>();
  for (const item of items)
    if (item.heads.length === 1) {
      const object = objects.get(item.heads[0]!)!;
      if (object.kind === 'entry_revision') {
        const path = paths.get(object.body.directory_id);
        if (path !== null && path !== undefined) {
          const key = path + '\0' + JSON.stringify(object.body.content);
          entries.set(key, [...(entries.get(key) ?? []), item.item_id]);
        }
      }
    }
  for (const ids of entries.values())
    if (ids.length > 1) for (const id of ids) conflicted.add(id);
  const locations = new Map<string, string[]>();
  for (const [id, path] of paths)
    if (path !== null)
      locations.set(path, [...(locations.get(path) ?? []), id]);
  for (const ids of locations.values())
    if (ids.length > 1) for (const id of ids) conflicted.add(id);
  for (let n = 0; n < items.length; n++) {
    let changed = false;
    for (const item of items)
      for (const head of item.heads) {
        const object = objects.get(head)!;
        const dependency =
          'directory_id' in object.body
            ? object.body.directory_id
            : object.kind === 'directory_revision'
              ? object.body.parent_directory
              : null;
        if (
          dependency &&
          (conflicted.has(dependency) || paths.get(dependency) === null)
        ) {
          if (!conflicted.has(item.item_id)) {
            conflicted.add(item.item_id);
            changed = true;
          }
          if (directories.has(dependency)) conflicted.add(dependency);
        }
      }
    for (const id of conflicted) if (directories.has(id)) paths.set(id, null);
    if (!changed) break;
  }
  return {
    snapshot: snapshotId,
    items,
    objects,
    paths,
    conflicts: items
      .filter((i) => conflicted.has(i.item_id))
      .map((i) => ({
        item_id: i.item_id,
        heads: i.heads,
        ...(i.heads.length === 1 ? { structural: true as const } : {}),
      })),
  };
}

export function hasAncestor(
  objects: ReadonlyMap<string, SyncObject>,
  head: string,
  ancestor: string,
): boolean {
  const seen = new Set<string>(),
    queue = [head];
  while (queue.length) {
    const id = queue.pop()!;
    if (id === ancestor) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const object = objects.get(id);
    if (object) queue.push(...objectParents(object));
  }
  return false;
}

export function findLowestCommonAncestor(
  objects: ReadonlyMap<string, SyncObject>,
  heads: readonly string[],
): string | null {
  if (heads.length === 0) return null;
  if (heads.length === 1) return heads[0]!;
  const ancestorSets = heads.map((head) => {
    const seen = new Set<string>(),
      queue = [head];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const object = objects.get(id);
      if (object) queue.push(...objectParents(object));
    }
    return seen;
  });
  const common = [...ancestorSets[0]!].filter((id) =>
    ancestorSets.every((set) => set.has(id)),
  );
  const maxima = common.filter(
    (id) =>
      !common.some((other) => other !== id && hasAncestor(objects, other, id)),
  );
  return maxima.length === 1 ? maxima[0]! : null;
}

export function resolveEffectiveHead(
  graph: SnapshotGraph,
  item: SyncItem,
): { head: string | null; conflicted: boolean } {
  if (
    item.heads.length === 1 &&
    !graph.conflicts.some((c) => c.item_id === item.item_id)
  )
    return { head: item.heads[0]!, conflicted: false };
  const lca = findLowestCommonAncestor(graph.objects, item.heads);
  return {
    head: lca && graph.objects.get(lca)?.kind !== 'deletion' ? lca : null,
    conflicted: true,
  };
}

export function assertSuccessor(
  previous: SnapshotGraph,
  next: SnapshotGraph,
): void {
  const candidates = new Map(next.items.map((item) => [itemKey(item), item]));
  for (const item of previous.items) {
    const candidate = candidates.get(itemKey(item));
    if (
      !candidate ||
      item.heads.some(
        (head) =>
          !candidate.heads.some((id) => hasAncestor(next.objects, id, head)),
      )
    )
      failure('previous revision omitted');
  }
  if (!hasAncestor(next.objects, next.snapshot, previous.snapshot))
    failure('snapshot ancestry');
}
