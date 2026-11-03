import { randomUUID } from 'node:crypto';
import { KnowledgeService } from './service.js';
import type { KnowledgeConnection } from './connection.js';
import { isObjectId } from './protocol.js';
import { requireClean } from './verification.js';
import { wellFormedText } from './unicode.js';
import type { KnowledgeShareRefusal } from './desktop-contract.js';

/** The server refused, and said why: its text is shown as it came, never rewritten. */
export class KnowledgeShareRefused extends Error {
  constructor(readonly refusal: KnowledgeShareRefusal) {
    super(`refused: ${refusal.message}${refusal.fix ? ' ' + refusal.fix : ''}`);
  }
}
export interface PreparedKnowledgeShare {
  title: string;
  replaces: boolean;
  run: () => Promise<{ shared: true; reference?: string }>;
}
const fail = (code: string): never => {
  throw Error(code);
};
const text = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 8000 &&
  wellFormedText(value)
    ? value
    : undefined;
/** The first explanation among the server's errors, of any code, or nothing. */
function refusalOf(candidates: unknown[]): KnowledgeShareRefusal | undefined {
  for (const error of candidates as any[]) {
    const message = text(error?.message);
    if (!message) continue;
    const fix = text(error?.fix) ?? '';
    requireClean(Buffer.from(message + '\n' + fix));
    return {
      code:
        typeof error.code === 'string' &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
          ? error.code
          : 'REFUSED',
      message,
      fix,
    };
  }
  return undefined;
}
function payload(value: any): any {
  let result: any;
  try {
    result =
      value?.structuredContent ??
      (value?.content?.length === 1 && value.content[0].type === 'text'
        ? JSON.parse(value.content[0].text)
        : undefined);
  } catch {
    result = undefined;
  }
  if (value?.isError || result?.call_result !== 'ok') {
    const refusal = refusalOf(
      Array.isArray(result?.errors) ? result.errors : [],
    );
    if (refusal) throw new KnowledgeShareRefused(refusal);
    return fail('knowledge-remote-unavailable');
  }
  return result;
}
/** A completed call whose outcome is not the one asked for: its own explanation, if any. */
function refuse(candidates: unknown[], code: string): never {
  const refusal = refusalOf(candidates);
  if (refusal) throw new KnowledgeShareRefused(refusal);
  return fail(code);
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
/** The local observation is insufficient: map the exact current object through its confirmed receipt and let the server recheck it. */
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
  // The server says which tool shares what (discovery `mcp.capabilities`); a server with
  // no discovery document gets the shapes earlier servers used.
  const discovery = await connection.discovery(signal);
  let operation: 'entry-share' | 'memory-share',
    members: Record<string, unknown>,
    replaces = false;
  if (selected.revision.kind === 'entry_revision') {
    const match = /^tree:([a-f0-9]{64})(\/.*)@([a-f0-9]{64})$/.exec(
      mapping.reference ?? '',
    );
    if (!match) return fail('knowledge-share-waiting');
    operation = 'entry-share';
    if (!discovery.mcp[operation]) return fail('knowledge-share-unavailable');
    // Without a declared read, the share call itself is where the server rechecks the entry.
    if (discovery.source === 'fallback') {
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
    }
    members = {
      root: match[1],
      path: match[2],
      entry: match[3],
      ...(options.teamPath ? { team_path: options.teamPath } : {}),
    };
  } else {
    if (!isObjectId(mapping.document) || !isObjectId(mapping.version))
      return fail('knowledge-share-waiting');
    operation = 'memory-share';
    members = {
      document: mapping.document,
      version: mapping.version,
      client_key: randomUUID(),
      ...(options.teamPath ? { team_path: options.teamPath } : {}),
    };
    const answer = await connection.callOperation(
      operation,
      { ...members, check_only: true },
      signal,
      true,
    );
    if (answer === null) return fail('knowledge-share-unavailable');
    const checked = payload(answer);
    if (!checked.memory_share?.ok)
      return refuse(
        Array.isArray(checked.memory_share?.checks)
          ? checked.memory_share.checks.filter((c: any) => c?.code)
          : [],
        'knowledge-share-unverified',
      );
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
      const answer = await connection.callOperation(
        operation,
        members,
        signal,
        true,
      );
      if (answer === null) return fail('knowledge-share-unavailable');
      const result = payload(answer);
      const share =
        operation === 'entry-share' ? result.share : result.memory_share?.share;
      if (share?.status !== 'merged')
        return refuse([share], 'knowledge-share-rejected');
      return {
        shared: true,
        ...(operation === 'entry-share' && typeof share.reference === 'string'
          ? { reference: share.reference }
          : {}),
      };
    },
  };
}
