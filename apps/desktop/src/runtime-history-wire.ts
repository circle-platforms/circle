import type {
  Message,
  WorkbenchSnapshot,
} from '../../workbench/src/model/types';
import type { RuntimeUpdate } from './runtime-protocol';

/**
 * What one history became since revision `base`: its first `keep` rows stay and these rows
 * follow them. With no base, these rows are all of it.
 */
export interface HistoryDelta {
  key: string;
  base?: number;
  keep: number;
  messages: Message[];
  branchKeep: number;
  branchIds?: string[];
}
/**
 * Stored history is nearly all of a snapshot and nearly none of it changes between two
 * publications, so a publication leaves it out of the sessions and agents and says what
 * changed. The worker writes this, and the main process and every window put the rows back.
 * Without `deltas`, as in a reply to a window asking for the state, the rows are in place.
 */
export interface RuntimeHistory {
  revisions: [key: string, revision: number][];
  deltas?: HistoryDelta[];
}
interface HistoryRow {
  id: string;
  messages: Message[];
  branchIds?: string[];
}
interface Published {
  revision: number;
  messages: readonly Message[];
  branchIds?: readonly string[];
}

function sharedStart<T>(
  before: readonly T[],
  after: readonly T[],
  same: (one: T, other: T) => boolean,
): number {
  const limit = Math.min(before.length, after.length);
  let index = 0;
  while (index < limit && same(before[index]!, after[index]!)) index++;
  return index;
}
// The controller hands back the same object for a row that did not change. A row it builds
// again each time, a notice or a stream, is compared by what it says. Calling a row changed
// is always safe: the receiver is only sent more.
const sameRow = (one: Message, other: Message) =>
  one === other || JSON.stringify(one) === JSON.stringify(other);
const sameId = (one: string, other: string) => one === other;

/** In the worker: each publication against the one before it. */
export class HistoryCompactor {
  private published = new Map<string, Published>();
  private revision = 0;
  /** The next publication carries every history whole, for a receiver that lost its place. */
  reset() {
    this.published.clear();
  }
  compact(update: RuntimeUpdate): RuntimeUpdate {
    const published = new Map<string, Published>();
    const deltas: HistoryDelta[] = [];
    const revisions: [string, number][] = [];
    const leaveOut = <T extends HistoryRow>(kind: string, row: T): T => {
      const key = `${kind}:${row.id}`;
      const last = this.published.get(key);
      const delta = this.delta(key, last, row);
      if (delta) deltas.push(delta);
      const revision = delta ? ++this.revision : last!.revision;
      published.set(key, {
        revision,
        messages: row.messages,
        branchIds: row.branchIds,
      });
      revisions.push([key, revision]);
      return {
        ...row,
        messages: [],
        ...(row.branchIds ? { branchIds: [] } : {}),
      };
    };
    const snapshot: WorkbenchSnapshot = {
      ...update.snapshot,
      sessions: update.snapshot.sessions.map((row) => leaveOut('session', row)),
      agents: update.snapshot.agents.map((row) => leaveOut('agent', row)),
    };
    this.published = published;
    return { ...update, snapshot, history: { revisions, deltas } };
  }
  private delta(
    key: string,
    last: Published | undefined,
    row: HistoryRow,
  ): HistoryDelta | undefined {
    if (!last)
      return {
        key,
        keep: 0,
        messages: row.messages,
        branchKeep: 0,
        ...(row.branchIds ? { branchIds: row.branchIds } : {}),
      };
    const keep =
      last.messages === row.messages
        ? row.messages.length
        : sharedStart(last.messages, row.messages, sameRow);
    const branches = row.branchIds ?? [];
    const branchesBefore = last.branchIds ?? [];
    const branchKeep =
      last.branchIds === row.branchIds
        ? branches.length
        : sharedStart(branchesBefore, branches, sameId);
    if (
      keep === last.messages.length &&
      keep === row.messages.length &&
      branchKeep === branchesBefore.length &&
      branchKeep === branches.length
    )
      return undefined;
    return {
      key,
      base: last.revision,
      keep,
      messages: row.messages.slice(keep),
      branchKeep,
      ...(row.branchIds ? { branchIds: branches.slice(branchKeep) } : {}),
    };
  }
}

function applied<T>(before: T[], keep: number, rows: T[]): T[] {
  return keep === before.length && !rows.length
    ? before
    : before.slice(0, keep).concat(rows);
}
/**
 * The publication with its rows back, on the rows `previous` holds, and the revisions it
 * now holds. Undefined when it was made on rows this receiver does not have: it missed a
 * publication and has to ask for the state.
 */
export function restoreHistory(
  update: RuntimeUpdate,
  previous: RuntimeUpdate | undefined,
  held: ReadonlyMap<string, number>,
): { update: RuntimeUpdate; revisions: Map<string, number> } | undefined {
  const history = update.history;
  if (!history) return { update, revisions: new Map() };
  const revisions = new Map(history.revisions);
  if (!history.deltas) return { update, revisions };
  // Revision numbers mean nothing to the next worker: its first publication is whole.
  const sameWorker = previous?.tokenStream?.epoch === update.tokenStream?.epoch;
  const deltas = new Map(history.deltas.map((delta) => [delta.key, delta]));
  let missing = false;
  const restore = <T extends HistoryRow>(
    kind: string,
    row: T,
    before: T | undefined,
  ): T => {
    const key = `${kind}:${row.id}`;
    const delta = deltas.get(key);
    if (delta && delta.base === undefined)
      return {
        ...row,
        messages: delta.messages,
        ...(delta.branchIds ? { branchIds: delta.branchIds } : {}),
      };
    const expected = delta ? delta.base : revisions.get(key);
    if (
      !sameWorker ||
      !before ||
      expected === undefined ||
      held.get(key) !== expected ||
      (delta &&
        (delta.keep > before.messages.length ||
          delta.branchKeep > (before.branchIds?.length ?? 0)))
    ) {
      missing = true;
      return row;
    }
    if (!delta)
      return {
        ...row,
        messages: before.messages,
        ...(before.branchIds ? { branchIds: before.branchIds } : {}),
      };
    return {
      ...row,
      messages: applied(before.messages, delta.keep, delta.messages),
      ...(before.branchIds && delta.branchIds
        ? {
            branchIds: applied(
              before.branchIds,
              delta.branchKeep,
              delta.branchIds,
            ),
          }
        : {}),
    };
  };
  const byId = <T extends { id: string }>(rows: readonly T[] | undefined) =>
    new Map((rows ?? []).map((row) => [row.id, row]));
  const sessions = byId(previous?.snapshot.sessions);
  const agents = byId(previous?.snapshot.agents);
  const snapshot: WorkbenchSnapshot = {
    ...update.snapshot,
    sessions: update.snapshot.sessions.map((row) =>
      restore('session', row, sessions.get(row.id)),
    ),
    agents: update.snapshot.agents.map((row) =>
      restore('agent', row, agents.get(row.id)),
    ),
  };
  if (missing) return undefined;
  return {
    update: { ...update, snapshot, history: { revisions: history.revisions } },
    revisions,
  };
}
