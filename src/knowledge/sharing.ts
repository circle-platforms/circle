import { randomUUID } from 'node:crypto';
import { KnowledgeService } from './service.js';
import type { KnowledgeConnection } from './connection.js';
import { isObjectId } from './protocol.js';
import { requireClean } from './verification.js';
export interface PreparedKnowledgeShare {
  title: string;
  replaces: boolean;
  run: () => Promise<{ shared: true; reference?: string }>;
}
const fail = (code: string): never => {
  throw Error(code);
};
function payload(value: any): any {
  const result =
    value?.structuredContent ??
    (value?.content?.length === 1 && value.content[0].type === 'text'
      ? JSON.parse(value.content[0].text)
      : undefined);
  if (value?.isError || result?.call_result !== 'ok')
    return fail('knowledge-remote-unavailable');
  return result;
}
export function syncMapping(
  service: KnowledgeService,
  binding: string,
  item: string,
  object: string,
): any {
  return service.withStore((store) => {
    const active = store.syncRead<any>('active'),
      projection = store.syncRead<any>('projection');
    if (!active || active.binding !== binding || !active.base || !active.state)
      return null;
    if (
      projection?.binding === binding &&
      projection.epoch === active.epoch &&
      projection.snapshot === active.base &&
      projection.state === active.state
    )
      return (
        projection.projections.find(
          (p: any) => p.item_id === item && p.object === object,
        ) ?? null
      );
    return store.syncProjection(
      active.epoch,
      active.base,
      active.state,
      item,
      object,
    );
  });
}
/** The local observation is insufficient: map the exact current object through its confirmed receipt and recheck Hub qualification. */
export async function prepareKnowledgeShare(options: {
  service: KnowledgeService;
  connection: KnowledgeConnection;
  binding: () => string;
  snapshot: string;
  object: string;
  teamPath?: string;
  signal: AbortSignal;
}): Promise<PreparedKnowledgeShare> {
  const { service, connection, snapshot, object, signal } = options;
  if (service.access().locked) return fail('knowledge-read-only');
  if (!isObjectId(snapshot) || !isObjectId(object))
    return fail('knowledge-changed');
  if (options.teamPath !== undefined) {
    if (
      !options.teamPath.startsWith('/') ||
      options.teamPath.length > 2000 ||
      options.teamPath.split('/').some((p) => p === '..' || p === '.')
    )
      return fail('knowledge-unavailable');
    requireClean(Buffer.from(options.teamPath));
  }
  const selected = service.withStore((store) => {
    if (store.head !== snapshot) return fail('knowledge-changed');
    const graph = store.graph(snapshot),
      row = graph.items.find(
        (i) => i.heads.length === 1 && i.heads[0] === object,
      ),
      revision = graph.objects.get(object);
    if (
      !row ||
      !revision ||
      graph.conflicts.some((c) => c.item_id === row.item_id)
    )
      return fail('knowledge-changed');
    if (!['entry_revision', 'memory_revision'].includes(revision.kind))
      return fail('knowledge-share-unavailable');
    if (
      revision.kind === 'entry_revision' &&
      !store
        .observations(snapshot)
        .some((v) => v.object === object && v.status === 'verified')
    )
      return fail('knowledge-share-unverified');
    return { row, revision };
  });
  const state = await connection.currentState(signal);
  if (state.mode !== 'hub' || state.status === 'purging')
    return fail('knowledge-share-local');
  const binding = options.binding(),
    mapping = syncMapping(service, binding, selected.row.item_id, object);
  if (!mapping) return fail('knowledge-share-waiting');
  let args: any,
    replaces = false;
  if (selected.revision.kind === 'entry_revision') {
    const match = /^tree:([a-f0-9]{64})(\/.*)@([a-f0-9]{64})$/.exec(
      mapping.reference ?? '',
    );
    if (!match) return fail('knowledge-share-waiting');
    const read = payload(
      await connection.callForPerson(
        'get_nodes',
        { root: match[1], paths: [match[2]], depth: 0 },
        signal,
      ),
    );
    if (
      read.root !== match[1] ||
      !read.nodes
        ?.flatMap((n: any) => n.entries)
        .some((e: any) => e.entry === match[3] && e.status === 'verified')
    )
      return fail('knowledge-share-unverified');
    args = {
      share_entry: {
        root: match[1],
        path: match[2],
        entry: match[3],
        ...(options.teamPath ? { team_path: options.teamPath } : {}),
      },
    };
  } else {
    if (!isObjectId(mapping.document) || !isObjectId(mapping.version))
      return fail('knowledge-share-waiting');
    args = {
      memory_share: {
        document: mapping.document,
        version: mapping.version,
        client_key: randomUUID(),
        ...(options.teamPath ? { team_path: options.teamPath } : {}),
      },
    };
    const checked = payload(
      await connection.callForPerson(
        'upload_file',
        { memory_share: { ...args.memory_share, check_only: true } },
        signal,
        true,
      ),
    );
    if (!checked.memory_share?.ok) return fail('knowledge-share-unverified');
    replaces = !!checked.memory_share.replaces;
  }
  let used = false;
  return {
    title:
      selected.revision.kind === 'entry_revision'
        ? selected.revision.body.content.statement
        : (selected.revision as any).body.title,
    replaces,
    run: async () => {
      if (used) return fail('knowledge-preview-expired');
      used = true;
      signal.throwIfAborted();
      service.withStore((store) => {
        if (
          store.head !== snapshot ||
          !store
            .items()
            .some((i) => i.heads.length === 1 && i.heads[0] === object)
        )
          return fail('knowledge-changed');
      });
      const now = await connection.currentState(signal);
      if (
        options.binding() !== binding ||
        now.mode !== 'hub' ||
        now.status === 'purging' ||
        now.epoch !== state.epoch ||
        now.state_version !== state.state_version
      )
        return fail('knowledge-changed');
      const result = payload(
        await connection.callForPerson('upload_file', args, signal, true),
      );
      if (
        args.share_entry
          ? result.share?.status !== 'merged'
          : result.memory_share?.share?.status !== 'merged'
      )
        return fail('knowledge-share-rejected');
      return {
        shared: true,
        ...(args.share_entry && typeof result.share.reference === 'string'
          ? { reference: result.share.reference }
          : {}),
      };
    },
  };
}
