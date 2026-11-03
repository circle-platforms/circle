import { hasAncestor, itemKey } from './graph.js';
import { KnowledgeStore } from './store.js';
import { SYNC_LIMITS } from './protocol.js';
import type { SyncItem, SyncObject } from './types.js';

/** Ancestry union implements the pinned three-way rule without selecting content or using clocks. */
export function mergeSnapshots(
  store: KnowledgeStore,
  local: string | null,
  remote: string | null,
  base: string | null,
): string {
  const left = local ? store.graph(local) : null;
  const right = remote ? store.graph(remote) : null;
  const previous = base ? store.graph(base) : null;
  if (previous && (!left || !right))
    throw new TypeError('sync branch omitted the base snapshot');
  const objects = {
    get: (id: string) => left?.objects.get(id) ?? right?.objects.get(id),
  } as ReadonlyMap<string, SyncObject>;
  for (const branch of [left, right])
    if (previous && branch) {
      for (const item of previous.items) {
        const row = branch.items.find((i) => itemKey(i) === itemKey(item));
        if (
          !row ||
          item.heads.some(
            (h) => !row.heads.some((n) => hasAncestor(branch.objects, n, h)),
          )
        )
          throw new TypeError('sync branch omitted a base revision');
      }
    }
  const rows = new Map<string, SyncItem>();
  for (const item of [...(left?.items ?? []), ...(right?.items ?? [])]) {
    const prior = rows.get(item.item_id);
    if (prior && prior.kind !== item.kind)
      throw new TypeError('sync identity kind changed');
    const all = [...new Set([...(prior?.heads ?? []), ...item.heads])].sort();
    rows.set(item.item_id, {
      kind: item.kind,
      item_id: item.item_id,
      heads: all.filter(
        (id) =>
          !all.some((other) => other !== id && hasAncestor(objects, other, id)),
      ),
    });
  }
  const items = [...rows.values()].sort((a, b) =>
    itemKey(a) < itemKey(b) ? -1 : 1,
  );
  const parents = [
    ...new Set([local, remote].filter((v): v is string => v !== null)),
  ].sort();
  // Reusing an already complete descendant prevents heartbeat-only snapshot chains.
  for (const graph of [left, right])
    if (
      graph &&
      graph.items.length === items.length &&
      graph.items.every(
        (row, i) =>
          itemKey(row) === itemKey(items[i]!) &&
          row.heads.join() === items[i]!.heads.join(),
      ) &&
      parents.every((p) => hasAncestor(objects, graph.snapshot, p))
    )
      return graph.snapshot;
  const pages: string[] = [];
  for (let i = 0; i < items.length; i += SYNC_LIMITS.pageItems)
    pages.push(
      store.put({
        schema: 'personal-sync-object@1',
        kind: 'inventory_page',
        body: { items: items.slice(i, i + SYNC_LIMITS.pageItems) },
      }),
    );
  const snapshot = store.put({
    schema: 'personal-sync-object@1',
    kind: 'snapshot',
    body: { parents, pages: pages.sort() },
  });
  store.graph(snapshot);
  return snapshot;
}
