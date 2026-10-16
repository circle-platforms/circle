import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ensureHome, normalizeWorkspace } from './paths.js';
import type { Message } from './types.js';
import type { LegacyImportPlan } from './legacy_sessions.js';
import { createHash } from 'node:crypto';
import {
  acquireSessionLease,
  sessionOccupied,
  type SessionLease,
} from './session_lock.js';
import { InputOutbox } from './input_outbox.js';
import {
  validateSessionGraph,
  orderedCheckpoints,
  type SessionGraph,
  type SessionGraphNode,
} from './session_graph.js';
import {
  firstUserSource,
  mightBeStaleTitle,
  repairedTitle,
} from './session_title.js';
export interface Session {
  id: string;
  workspace: string;
  title: string;
  model: string;
  head: string | null;
  created: number;
  updated: number;
  /**
   * When the last user or assistant message was written. `list` fills this in.
   * Opening a session, a title repair and an internal marker do not move it.
   */
  activity?: number;
  parent_id: string | null;
  /** 1 after /name or /rename. Automatic titles stay unset and can be replaced. */
  title_locked?: number;
}
export interface Checkpoint {
  id: string;
  session_id: string;
  parent: string | null;
  message: Message | null;
  created: number;
}
export interface ContextState {
  subagentSessionIds?: string[];
  compactionCalls?: {
    id: string;
    model: string;
    usage: import('./types.js').Usage;
    cost?: import('./pricing.js').PriceReceipt;
  }[];
  summary?: {
    cutoffMessageId: string;
    text: string;
    historyPath?: string;
    usage?: import('./types.js').Usage;
    response?: Message;
    model?: string;
  };
  prunedIds: string[];
  stripThinkingIds: string[];
  offloaded: Record<string, string>;
  /** Messages whose images and PDFs requests leave out, to make room for newer ones. */
  droppedMedia?: string[];
}
export const emptyContextState = (): ContextState => ({
  prunedIds: [],
  stripThinkingIds: [],
  offloaded: {},
});
export class CheckpointStore {
  readonly inputs: InputOutbox;
  private db: DatabaseSync;
  private readonly home?: string;
  private readonly ownership = new Map<string, SessionLease>();
  private readonly ownershipHandlers = new Map<
    string,
    (error: Error) => void
  >();
  private closed = false;
  // The messages of each session's current head, so a repaint does not walk the checkpoint
  // chain (one query per message) again. The array and its messages are shared: callers
  // must not modify them. Invalidated by every write that moves a head.
  private messageCache = new Map<
    string,
    { head: string | null; messages: Message[] }
  >();
  // Moved on every write, so callers can tell whether a derived view of the store
  // (the subagent rows) is still current without re-querying.
  private writeVersion = 0;
  get version(): number {
    return this.writeVersion;
  }
  constructor(home?: string) {
    this.home = home;
    this.db = new DatabaseSync(
      home ? join(ensureHome(home), 'circle.sqlite') : ':memory:',
    );
    this.db
      .exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL, head TEXT, created REAL NOT NULL, updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, parent TEXT REFERENCES checkpoints(id), message TEXT NOT NULL, created REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS checkpoints_session ON checkpoints(session_id);
      CREATE TABLE IF NOT EXISTS context_projections (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, at_checkpoint TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_versions (version INTEGER PRIMARY KEY AUTOINCREMENT, checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE, state TEXT NOT NULL, created REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS context_versions_checkpoint ON context_versions(checkpoint_id, version);
      CREATE TABLE IF NOT EXISTS labels (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, message_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(session_id, message_id));
      CREATE TABLE IF NOT EXISTS legacy_imports (source_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, receipt TEXT NOT NULL, created REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_checkpoints (source_key TEXT NOT NULL, legacy_id TEXT NOT NULL, native_head TEXT, PRIMARY KEY(source_key, legacy_id));
      `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const version = Number(
        this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0,
      );
      const columns = this.db.prepare('PRAGMA table_info(sessions)').all();
      if (!columns.some((row) => row.name === 'parent_id'))
        this.db.exec('ALTER TABLE sessions ADD COLUMN parent_id TEXT');
      if (!columns.some((row) => row.name === 'title_locked'))
        this.db.exec(
          'ALTER TABLE sessions ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0',
        );
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id);',
      );
      // Upgrade native children once, without changing history or replaying work.
      if (version < 4)
        for (const row of this.db
          .prepare(
            'SELECT c.session_id,v.state FROM context_versions v JOIN checkpoints c ON c.id=v.checkpoint_id ORDER BY v.version',
          )
          .all()) {
          const state = JSON.parse(String(row.state)) as ContextState;
          for (const child of state.subagentSessionIds ?? [])
            if (child !== row.session_id)
              this.db
                .prepare(
                  'UPDATE sessions SET parent_id=? WHERE id=? AND parent_id IS NULL',
                )
                .run(String(row.session_id), child);
        }
      this.db.exec('PRAGMA user_version = 4; COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.inputs = new InputOutbox(
      this.db,
      (id, action) => this.writing([id], action),
      {
        deferred: (id) => this.deferred.has(id) && !this.row(id),
        materialize: (id) => this.materialize(id, true),
        committed: (id) => {
          if (this.deferred.delete(id)) this.writeVersion++;
        },
      },
    );
  }
  /** Sessions kept in memory until the first message, so an unused /new leaves no row. */
  private deferred = new Map<string, Session>();
  /**
   * Delete untitled sessions that never received a message. A live runtime still
   * holds the lease, so opening another store does not remove a conversation
   * that simply has not been written yet. The terminal calls this on startup.
   */
  purgeEmptySessions(): void {
    const ids = (
      this.db
        .prepare(
          `SELECT id FROM sessions WHERE parent_id IS NULL AND head IS NULL AND title = '' AND NOT EXISTS (SELECT 1 FROM input_outbox WHERE session_id = sessions.id AND state IN ('queued','recovery_pending'))`,
        )
        .all() as { id: string }[]
    ).filter(({ id }) => !this.home || !sessionOccupied(this.home, id));
    if (!ids.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { id } of ids)
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      this.writeVersion++;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Drop a session that was never written, or one whose only turn failed before a reply. */
  abandonUnanswered(sessionId: string): boolean {
    const session = this.get(sessionId);
    if (!session) return false;
    const messages = session.head ? this.messages(sessionId) : [];
    if (
      messages.some(
        (message) =>
          message.role === 'assistant' ||
          message.role === 'tool' ||
          Boolean(message.tool_calls?.length),
      )
    )
      return false;
    this.writing([sessionId], () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      this.messageCache.delete(sessionId);
      this.deferred.set(sessionId, {
        ...session,
        title: '',
        head: null,
        updated: Date.now(),
      });
      this.writeVersion++;
    });
    return true;
  }
  dropDeferred(sessionId: string): void {
    this.deferred.delete(sessionId);
  }
  /** Hold execution ownership through turns, background tasks and shutdown. */
  claimSession(
    sessionId: string,
    onCompromised?: (error: Error) => void,
  ): void {
    if (!this.home) return;
    if (!this.ownership.has(sessionId))
      this.ownership.set(
        sessionId,
        acquireSessionLease(this.home, sessionId, (error) =>
          this.ownershipHandlers.get(sessionId)?.(error),
        ),
      );
    if (onCompromised) this.ownershipHandlers.set(sessionId, onCompromised);
  }
  releaseSession(sessionId: string): void {
    this.ownership.get(sessionId)?.release();
    this.ownership.delete(sessionId);
    this.ownershipHandlers.delete(sessionId);
  }
  private writing<T>(sessionIds: string[], operation: () => T): T {
    const temporary: SessionLease[] = [];
    try {
      for (const id of [...new Set(sessionIds)].sort()) {
        const owned = this.ownership.get(id);
        if (owned) owned.assertActive();
        else if (this.home) temporary.push(acquireSessionLease(this.home, id));
      }
      return operation();
    } finally {
      for (const lease of temporary.reverse()) lease.release();
    }
  }
  create(
    workspace: string,
    model: string,
    title = '',
    id = 'circle-' + randomUUID().slice(0, 8),
    parentId: string | null = null,
    defer = false,
  ): Session {
    if (defer && !parentId && !this.row(id)) {
      const now = Date.now();
      const session: Session = {
        id,
        workspace: normalizeWorkspace(workspace),
        title,
        model,
        head: null,
        created: now,
        updated: now,
        parent_id: null,
        title_locked: 0,
      };
      this.deferred.set(id, session);
      return { ...session };
    }
    if (parentId && this.ownership.has(parentId))
      this.claimSession(id, this.ownershipHandlers.get(parentId));
    return this.writing(parentId ? [parentId, id] : [id], () =>
      this.createOwned(workspace, model, title, id, parentId),
    );
  }
  private row(id: string): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      Session | undefined;
  }
  private materialize(sessionId: string, retainUntilCommit = false): void {
    const pending = this.deferred.get(sessionId);
    if (!pending || this.row(sessionId)) {
      if (!retainUntilCommit) this.deferred.delete(sessionId);
      return;
    }
    this.db
      .prepare(
        'INSERT INTO sessions (id,workspace,title,model,head,created,updated,parent_id,title_locked) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)',
      )
      .run(
        pending.id,
        pending.workspace,
        pending.title,
        pending.model,
        pending.created,
        Date.now(),
        pending.parent_id,
        pending.title_locked ? 1 : 0,
      );
    if (!retainUntilCommit) this.deferred.delete(sessionId);
  }
  private createOwned(
    workspace: string,
    model: string,
    title: string,
    id: string,
    parentId: string | null,
  ): Session {
    const existing = this.get(id);
    if (existing) {
      if (existing.workspace !== normalizeWorkspace(workspace))
        throw new Error('session belongs to a different workspace');
      if (existing.parent_id !== parentId)
        throw new Error('session belongs to a different parent');
      return existing;
    }
    const now = Date.now();
    if (parentId && !this.get(parentId))
      throw new Error('parent session is missing');
    this.db
      .prepare(
        'INSERT INTO sessions (id,workspace,title,model,head,created,updated,parent_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
      )
      .run(id, normalizeWorkspace(workspace), title, model, now, now, parentId);
    return this.get(id)!;
  }
  get(id: string): Session | undefined {
    const stored = this.row(id);
    if (stored) return stored;
    const pending = this.deferred.get(id);
    return pending ? { ...pending } : undefined;
  }
  find(suffix: string): Session | undefined {
    // list() hides an untitled session with no messages. Opening one by id,
    // including a live empty session another process still leases, must see it.
    // Child sessions stay out of discovery; children() is how a parent finds them.
    const sessions = [
      ...(this.db
        .prepare('SELECT * FROM sessions WHERE parent_id IS NULL')
        .all() as unknown as Session[]),
      ...[...this.deferred.values()].filter((session) => !session.parent_id),
    ].filter((session) => session.id === suffix || session.id.endsWith(suffix));
    const unique = [
      ...new Map(sessions.map((session) => [session.id, session])).values(),
    ];
    if (unique.length > 1) throw new Error('session id is ambiguous');
    return unique[0];
  }
  /**
   * Root sessions, newest message first. An untitled session with no message is
   * left out unless `empty` is set: the terminal never lists one, while the
   * desktop shows the open conversation before its first message.
   */
  list(workspace?: string, includeChildren = false, empty = false): Session[] {
    // Last message, not last open. A mode boundary or an interrupted marker
    // written while opening must not jump the row to the top.
    const activity = `COALESCE((SELECT MAX(c.created) FROM checkpoints c WHERE c.session_id = sessions.id AND json_extract(c.message, '$.role') IN ('user', 'assistant') AND IFNULL(json_extract(c.message, '$.internal'), '') = ''), sessions.created)`;
    const hidden = includeChildren
      ? ''
      : empty
        ? 'AND parent_id IS NULL'
        : "AND parent_id IS NULL AND NOT (head IS NULL AND title = '' AND NOT EXISTS (SELECT 1 FROM input_outbox WHERE session_id = sessions.id AND state IN ('queued','recovery_pending')))";
    return (workspace
      ? this.db
          .prepare(
            `SELECT sessions.*, ${activity} AS activity FROM sessions WHERE workspace = ? ${hidden} ORDER BY activity DESC, sessions.created DESC`,
          )
          .all(normalizeWorkspace(workspace))
      : this.db
          .prepare(
            `SELECT sessions.*, ${activity} AS activity FROM sessions WHERE 1 = 1 ${hidden} ORDER BY activity DESC, sessions.created DESC`,
          )
          .all()) as unknown as Session[];
  }
  children(parentId: string): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE parent_id=? ORDER BY created,id')
      .all(parentId) as unknown as Session[];
  }
  /**
   * Replace a title saved by an older build (reasoning text, or `150` cut from
   * `1500`) with the short title of the first message. A rename is not
   * activity, so the row stays where it was.
   */
  repairStaleTitles(): void {
    for (const session of this.list()) {
      if (
        !session.head ||
        session.title_locked ||
        !mightBeStaleTitle(session.title)
      )
        continue;
      const source = firstUserSource(this.messages(session.id));
      const next = source ? repairedTitle(session.title, source) : undefined;
      if (next) this.rename(session.id, next);
    }
  }
  rename(id: string, title: string, locked = false): void {
    const pending = this.deferred.get(id);
    if (pending && !this.row(id)) {
      pending.title = title;
      pending.title_locked = locked ? 1 : 0;
      return;
    }
    // Leave `updated` alone. The session list is newest-activity first, and a
    // rename is not activity: bumping it jumped the row to the top.
    // `locked` is set when the person chose the name. A generated title stays
    // unlocked so a later open can replace a bad one.
    this.db
      .prepare('UPDATE sessions SET title = ?, title_locked = ? WHERE id = ?')
      .run(title, locked ? 1 : 0, id);
    this.writeVersion++;
  }
  private decode(row: Record<string, unknown>): Checkpoint {
    return {
      id: String(row.id),
      session_id: String(row.session_id),
      parent: row.parent === null ? null : String(row.parent),
      message: JSON.parse(String(row.message)) as Message,
      created: Number(row.created),
    };
  }
  checkpoint(id: string): Checkpoint | undefined {
    const row = this.db
      .prepare('SELECT * FROM checkpoints WHERE id = ?')
      .get(id);
    return row ? this.decode(row) : undefined;
  }
  tree(session: string): (Checkpoint & { message: Message })[] {
    return this.db
      .prepare(
        'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created, rowid',
      )
      .all(session)
      .map((row) => this.decode(row))
      .filter(
        (row): row is Checkpoint & { message: Message } => row.message !== null,
      );
  }
  append(
    sessionId: string,
    messages: Message[],
    expectedHead?: string | null,
  ): string | null {
    if (!messages.length) return this.get(sessionId)?.head ?? null;
    return this.writing([sessionId], () =>
      this.appendOwned(sessionId, messages, expectedHead),
    );
  }
  /** Commit a queued user message and its consumed receipt in one SQLite transaction. */
  appendInput(
    sessionId: string,
    inputId: string,
    epoch: string,
    message: Message,
  ): string | null {
    if (message.role !== 'user' || message.id !== inputId)
      throw new Error('queued input must append its stable user message id');
    return this.writing([sessionId], () =>
      this.appendOwned(sessionId, [message], undefined, { id: inputId, epoch }),
    );
  }
  private appendOwned(
    sessionId: string,
    messages: Message[],
    expectedHead?: string | null,
    input?: { id: string; epoch: string },
  ): string | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.materialize(sessionId, true);
      const session = this.get(sessionId);
      if (!session) throw new Error('unknown session');
      if (expectedHead !== undefined && expectedHead !== session.head)
        throw new Error('session changed in another process');
      if (input)
        this.inputs.consumeInTransaction(sessionId, input.id, input.epoch);
      let head = session.head;
      const stored = messages.map((message) => JSON.stringify(message));
      for (const text of stored) {
        const id = randomUUID();
        this.db
          .prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?)')
          .run(id, sessionId, head, text, Date.now());
        head = id;
      }
      this.db
        .prepare('UPDATE sessions SET head = ?, updated = ? WHERE id = ?')
        .run(head, Date.now(), sessionId);
      this.db.exec('COMMIT');
      this.deferred.delete(sessionId);
      // When the cache holds the head this append started from, the new messages extend
      // it; otherwise the chain is walked again on the next read. It extends with what was
      // written, decoded, not the caller's objects: a read returns what the database holds.
      const cached = this.messageCache.get(sessionId);
      if (cached && cached.head === session.head) {
        cached.head = head;
        cached.messages = cached.messages.concat(
          stored.map((text) => JSON.parse(text) as Message),
        );
      } else this.messageCache.delete(sessionId);
      this.writeVersion++;
      return head;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  messages(sessionId: string, head?: string | null): Message[] {
    const resolved =
      head === undefined ? (this.get(sessionId)?.head ?? null) : head;
    const cached = this.messageCache.get(sessionId);
    if (cached && cached.head === resolved) return cached.messages;
    const messages: Message[] = [];
    const seen = new Set<string>();
    let cursor = resolved;
    while (cursor) {
      if (seen.has(cursor)) throw new Error('checkpoint ancestry cycle');
      seen.add(cursor);
      const row = this.checkpoint(cursor);
      if (!row || row.session_id !== sessionId)
        throw new Error('invalid checkpoint ancestry');
      if (row.message) messages.push(row.message);
      cursor = row.parent;
    }
    messages.reverse();
    this.messageCache.set(sessionId, { head: resolved, messages });
    return messages;
  }
  select(sessionId: string, head: string | null): void {
    this.writing([sessionId], () => this.selectOwned(sessionId, head));
  }
  private selectOwned(sessionId: string, head: string | null): void {
    const messages = this.messages(sessionId, head);
    this.requireBalancedTools(messages);
    // Choosing an earlier head is not a new message.
    this.db
      .prepare('UPDATE sessions SET head = ? WHERE id = ?')
      .run(head, sessionId);
    this.writeVersion++;
  }
  fork(sessionId: string, workspace: string, head?: string | null): Session {
    const parent = this.get(sessionId);
    if (!parent) throw new Error('unknown session');
    return this.importGraph(this.exportGraph(sessionId, head, true), workspace);
  }
  delete(sessionId: string, beforeDelete?: (ids: string[]) => void): void {
    this.writing([sessionId], () => this.deleteTree(sessionId, beforeDelete));
  }
  private deleteTree(
    sessionId: string,
    beforeDelete?: (ids: string[]) => void,
  ): void {
    const ids = new Set<string>();
    const collect = (id: string): void => {
      if (ids.has(id)) throw new Error('session parent cycle');
      ids.add(id);
      for (const child of this.children(id)) collect(child.id);
    };
    collect(sessionId);
    // The root is already leased, so a second store cannot attach new children
    // between discovery and delete. Nested acquisition only needs descendants.
    this.writing(
      [...ids].filter((id) => id !== sessionId),
      () => {
        beforeDelete?.([...ids]);
        this.deleteOwned(sessionId);
      },
    );
  }
  private deleteOwned(sessionId: string): void {
    const visit = (id: string, seen: Set<string>): void => {
      if (seen.has(id)) throw new Error('session parent cycle');
      seen.add(id);
      for (const child of this.children(id)) visit(child.id, seen);
      this.messageCache.delete(id);
      this.deferred.delete(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      visit(sessionId, new Set());
      this.db.exec('COMMIT');
      this.writeVersion++;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  labels(sessionId: string): Record<string, string> {
    return Object.fromEntries(
      this.db
        .prepare('SELECT message_id, label FROM labels WHERE session_id = ?')
        .all(sessionId)
        .map((row) => [String(row.message_id), String(row.label)]),
    );
  }
  setLabel(sessionId: string, messageId: string, label: string): void {
    const clean = label.trim().replace(/\s+/gu, ' ').slice(0, 40);
    if (
      !this.tree(sessionId).some(
        (checkpoint) => checkpoint.message.id === messageId,
      )
    )
      throw new Error('label names no message');
    if (clean)
      this.db
        .prepare('INSERT OR REPLACE INTO labels VALUES (?, ?, ?)')
        .run(sessionId, messageId, clean);
    else
      this.db
        .prepare('DELETE FROM labels WHERE session_id = ? AND message_id = ?')
        .run(sessionId, messageId);
  }
  migrationReceipts(): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT receipt FROM legacy_imports ORDER BY created')
      .all()
      .map((row) => JSON.parse(String(row.receipt)) as Record<string, unknown>);
  }
  importedLegacyKeys(): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT source_key FROM legacy_imports')
        .all()
        .map((row) => String(row.source_key)),
    );
  }
  legacyHead(
    sourceKey: string,
    checkpointId: string,
  ): string | null | undefined {
    const row = this.db
      .prepare(
        'SELECT native_head FROM legacy_checkpoints WHERE source_key = ? AND legacy_id = ?',
      )
      .get(sourceKey, checkpointId);
    return row
      ? row.native_head === null
        ? null
        : String(row.native_head)
      : undefined;
  }
  importLegacy(plan: LegacyImportPlan): 'imported' | 'skipped' {
    return this.writing(
      plan.parentId
        ? [plan.parentId, plan.session.thread_id]
        : [plan.session.thread_id],
      () => this.importLegacyOwned(plan),
    );
  }
  private importLegacyOwned(plan: LegacyImportPlan): 'imported' | 'skipped' {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        this.db
          .prepare('SELECT source_key FROM legacy_imports WHERE source_key = ?')
          .get(plan.sourceKey)
      ) {
        this.db.exec('ROLLBACK');
        return 'skipped';
      }
      if (this.get(plan.session.thread_id))
        throw new Error(
          'legacy session ID conflicts with an existing native session',
        );
      const session = plan.session;
      if (plan.parentId && !this.get(plan.parentId))
        throw new Error('legacy parent session is missing');
      this.db
        .prepare(
          'INSERT INTO sessions (id,workspace,title,model,head,created,updated,parent_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
        )
        .run(
          session.thread_id,
          session.workspace,
          session.title,
          session.model,
          session.created * 1000,
          session.updated * 1000,
          plan.parentId ?? null,
        );
      const paths = new Map<
        string,
        { messages: Message[]; ids: string[]; head: string | null }
      >();
      const maps = new Map<string, string | null>();
      for (const snapshot of plan.snapshots) {
        const parent = snapshot.parent ? paths.get(snapshot.parent) : undefined;
        if (snapshot.parent && !parent)
          throw new Error('migration checkpoint parent is missing');
        const parentMessages = parent?.messages ?? [];
        const ids = parent?.ids ?? [];
        let prefix = 0;
        while (
          prefix < Math.min(parentMessages.length, snapshot.messages.length) &&
          JSON.stringify(parentMessages[prefix]) ===
            JSON.stringify(snapshot.messages[prefix])
        )
          prefix++;
        const current = ids.slice(0, prefix);
        let head =
          parent && prefix === parentMessages.length
            ? parent.head
            : (current.at(-1) ?? null);
        for (let index = prefix; index < snapshot.messages.length; index++) {
          const message = snapshot.messages[index]!;
          const id =
            'legacy-' +
            createHash('sha256')
              .update(
                plan.sourceKey +
                  ':' +
                  snapshot.id +
                  ':' +
                  index +
                  ':' +
                  JSON.stringify(message),
              )
              .digest('hex');
          this.db
            .prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?)')
            .run(
              id,
              session.thread_id,
              head,
              JSON.stringify(message),
              snapshot.timestamp || session.updated * 1000,
            );
          current.push(id);
          head = id;
        }
        const boundary =
          'legacy-boundary-' +
          createHash('sha256')
            .update(plan.sourceKey + ':' + snapshot.id)
            .digest('hex');
        this.db
          .prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?)')
          .run(
            boundary,
            session.thread_id,
            head,
            'null',
            snapshot.timestamp || session.updated * 1000,
          );
        head = boundary;
        paths.set(snapshot.id, {
          messages: snapshot.messages,
          ids: current,
          head,
        });
        maps.set(snapshot.id, head);
        this.db
          .prepare('INSERT INTO legacy_checkpoints VALUES (?, ?, ?)')
          .run(plan.sourceKey, snapshot.id, head);
        if (head)
          this.db
            .prepare(
              'INSERT INTO context_versions (checkpoint_id,state,created) VALUES (?, ?, ?)',
            )
            .run(
              head,
              JSON.stringify(snapshot.context),
              snapshot.timestamp || session.updated * 1000,
            );
      }
      if (!maps.has(plan.selected))
        throw new Error('migration selected checkpoint is missing');
      this.db
        .prepare('UPDATE sessions SET head = ? WHERE id = ?')
        .run(maps.get(plan.selected)!, session.thread_id);
      this.messageCache.delete(session.thread_id);
      for (const [id, label] of Object.entries(plan.labels))
        this.db
          .prepare('INSERT INTO labels VALUES (?, ?, ?)')
          .run(session.thread_id, id, label);
      this.db
        .prepare('INSERT INTO legacy_imports VALUES (?, ?, ?, ?)')
        .run(
          plan.sourceKey,
          session.thread_id,
          JSON.stringify(plan.receipt),
          Date.now(),
        );
      this.db.exec('COMMIT');
      this.writeVersion++;
      return 'imported';
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  requireBalancedTools(messages: Message[]): void {
    const pending = new Set<string>();
    for (const message of messages) {
      for (const call of message.tool_calls ?? []) pending.add(call.id);
      if (message.role === 'tool') pending.delete(message.tool_call_id!);
    }
    if (pending.size)
      throw new Error('cannot select a checkpoint with pending tool calls');
  }
  exportGraph(
    sessionId: string,
    head?: string | null,
    branchOnly = false,
  ): SessionGraph {
    this.db.exec('BEGIN');
    try {
      const graph: SessionGraph = { root: sessionId, sessions: [] };
      const queue: {
        id: string;
        parent: string | null;
        head?: string | null;
      }[] = [{ id: sessionId, parent: null, head }];
      const owners = new Map<string, string | null>();
      while (queue.length) {
        const item = queue.shift()!;
        if (owners.has(item.id)) {
          if (owners.get(item.id) !== item.parent)
            throw new Error('child session has multiple owners');
          continue;
        }
        owners.set(item.id, item.parent);
        const session = this.get(item.id);
        if (!session) throw new Error('referenced session is missing');
        const selected = item.head === undefined ? session.head : item.head;
        let checkpoints = this.db
          .prepare(
            'SELECT * FROM checkpoints WHERE session_id=? ORDER BY rowid',
          )
          .all(item.id)
          .map((row) => this.decode(row));
        if (branchOnly) {
          const byId = new Map(
            checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
          );
          const included = new Set<string>();
          let cursor = selected;
          while (cursor) {
            if (included.has(cursor))
              throw new Error('checkpoint ancestry cycle');
            included.add(cursor);
            const checkpoint = byId.get(cursor);
            if (!checkpoint) throw new Error('checkpoint is missing');
            cursor = checkpoint.parent;
          }
          checkpoints = checkpoints.filter((checkpoint) =>
            included.has(checkpoint.id),
          );
        }
        const checkpointIds = new Set(
          checkpoints.map((checkpoint) => checkpoint.id),
        );
        const contexts = this.db
          .prepare(
            'SELECT v.checkpoint_id,v.state,v.created FROM context_versions v JOIN checkpoints c ON c.id=v.checkpoint_id WHERE c.session_id=? ORDER BY v.version',
          )
          .all(item.id)
          .filter((row) => checkpointIds.has(String(row.checkpoint_id)))
          .map((row) => ({
            checkpoint_id: String(row.checkpoint_id),
            state: JSON.parse(String(row.state)) as ContextState,
            created: Number(row.created),
          }));
        const effective = this.contextState(item.id, selected);
        if (selected && !contexts.some((row) => row.checkpoint_id === selected))
          contexts.push({
            checkpoint_id: selected,
            state: effective,
            created: Date.now(),
          });
        const messageIds = new Set(
          checkpoints.flatMap((checkpoint) =>
            checkpoint.message ? [checkpoint.message.id] : [],
          ),
        );
        const labels = Object.fromEntries(
          Object.entries(this.labels(item.id)).filter(([id]) =>
            messageIds.has(id),
          ),
        );
        const node: SessionGraphNode = {
          session: { ...session, head: selected, parent_id: item.parent },
          checkpoints,
          contexts,
          labels,
        };
        graph.sessions.push(node);
        const children = new Set(
          contexts.flatMap((row) => row.state.subagentSessionIds ?? []),
        );
        if (!branchOnly)
          for (const child of this.children(item.id)) children.add(child.id);
        for (const id of children) queue.push({ id, parent: item.id });
      }
      validateSessionGraph(graph);
      this.db.exec('COMMIT');
      return graph;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  importGraph(graph: SessionGraph, workspace: string): Session {
    validateSessionGraph(graph);
    const sessionIds = new Map(
      graph.sessions.map((node) => [node.session.id, 'circle-' + randomUUID()]),
    );
    const checkpointIds = new Map(
      graph.sessions.flatMap((node) =>
        node.checkpoints.map(
          (checkpoint) => [checkpoint.id, randomUUID()] as const,
        ),
      ),
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const node of graph.sessions) {
        const session = node.session;
        this.db
          .prepare(
            'INSERT INTO sessions (id,workspace,title,model,head,created,updated,parent_id) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            sessionIds.get(session.id)!,
            normalizeWorkspace(workspace),
            session.title,
            session.model,
            session.head ? checkpointIds.get(session.head)! : null,
            session.created,
            session.updated,
            session.parent_id ? sessionIds.get(session.parent_id)! : null,
          );
      }
      for (const node of graph.sessions) {
        for (const checkpoint of orderedCheckpoints(node))
          this.db
            .prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?)')
            .run(
              checkpointIds.get(checkpoint.id)!,
              sessionIds.get(node.session.id)!,
              checkpoint.parent ? checkpointIds.get(checkpoint.parent)! : null,
              JSON.stringify(checkpoint.message),
              checkpoint.created,
            );
        for (const context of node.contexts) {
          const state = structuredClone(context.state);
          if (state.subagentSessionIds)
            state.subagentSessionIds = state.subagentSessionIds.map((id) =>
              sessionIds.get(id)!,
            );
          this.db
            .prepare(
              'INSERT INTO context_versions (checkpoint_id,state,created) VALUES (?,?,?)',
            )
            .run(
              checkpointIds.get(context.checkpoint_id)!,
              JSON.stringify(state),
              context.created,
            );
        }
        for (const [id, label] of Object.entries(node.labels))
          this.db
            .prepare('INSERT INTO labels VALUES (?,?,?)')
            .run(sessionIds.get(node.session.id)!, id, label);
      }
      this.db.exec('COMMIT');
      this.writeVersion++;
      return this.get(sessionIds.get(graph.root)!)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  repairInterrupted(sessionId: string): void {
    const messages = this.messages(sessionId);
    const pending = new Map<string, string>();
    for (const message of messages) {
      for (const call of message.tool_calls ?? [])
        pending.set(call.id, call.name);
      if (message.role === 'tool') pending.delete(message.tool_call_id!);
    }
    if (pending.size) {
      this.append(
        sessionId,
        [...pending].map(([id, name]) => ({
          id: randomUUID(),
          role: 'tool',
          tool_call_id: id,
          name,
          status: 'error',
          content:
            'Interrupted before a tool result was saved. The tool is not replayed.',
        })),
      );
      return;
    }
    if (messages.some((message) => message.internal === 'interrupted')) return;
    const last = messages.filter((message) => !message.internal).at(-1);
    // A turn stopped while the assistant was still streaming saves that partial
    // reply. The last message is then the assistant, and the marker was skipped.
    const stopped =
      last?.role === 'user' ||
      (last?.role === 'assistant' && last.interrupted === true);
    if (!stopped) return;
    this.append(sessionId, [
      {
        id: randomUUID(),
        role: 'user',
        content:
          'The previous turn was interrupted before a reply was saved. Continue from the last user message if they ask again.',
        display: 'Interrupted',
        internal: 'interrupted',
      },
    ]);
  }
  setSummary(sessionId: string, at: string, summary: string): void {
    const checkpoint = this.checkpoint(at);
    if (checkpoint?.session_id !== sessionId || !checkpoint.message)
      throw new Error('invalid summary checkpoint');
    if (
      !this.messages(sessionId).some(
        (message) => message.id === checkpoint.message?.id,
      )
    )
      throw new Error('summary checkpoint is not on the active branch');
    this.setContextState(sessionId, {
      ...this.contextState(sessionId),
      summary: { cutoffMessageId: checkpoint.message.id, text: summary },
    });
  }
  contextState(sessionId: string, head?: string | null): ContextState {
    let cursor = head === undefined ? this.get(sessionId)?.head : head;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) throw new Error('checkpoint ancestry cycle');
      seen.add(cursor);
      const checkpoint = this.checkpoint(cursor);
      if (!checkpoint || checkpoint.session_id !== sessionId)
        throw new Error('invalid checkpoint ancestry');
      const row = this.db
        .prepare(
          'SELECT state FROM context_versions WHERE checkpoint_id = ? ORDER BY version DESC LIMIT 1',
        )
        .get(cursor);
      if (row) return JSON.parse(String(row.state)) as ContextState;
      cursor = checkpoint.parent;
    }
    const legacy = this.db
      .prepare(
        'SELECT at_checkpoint, summary FROM context_projections WHERE session_id = ?',
      )
      .get(sessionId);
    if (legacy) {
      const checkpoint = this.checkpoint(String(legacy.at_checkpoint));
      if (
        checkpoint?.message &&
        this.messages(sessionId, head).some(
          (message) => message.id === checkpoint.message?.id,
        )
      )
        return {
          ...emptyContextState(),
          summary: {
            cutoffMessageId: checkpoint.message.id,
            text: String(legacy.summary),
          },
        };
    }
    return emptyContextState();
  }
  setContextState(
    sessionId: string,
    state: ContextState,
    expectedHead?: string | null,
  ): void {
    this.writing([sessionId], () =>
      this.setContextStateOwned(sessionId, state, expectedHead),
    );
  }
  private setContextStateOwned(
    sessionId: string,
    state: ContextState,
    expectedHead?: string | null,
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.get(sessionId);
      if (!session) throw new Error('unknown session');
      if (expectedHead !== undefined && session.head !== expectedHead)
        throw new Error('session changed in another process');
      if (!session.head) throw new Error('context state needs a checkpoint');
      this.db
        .prepare(
          'INSERT INTO context_versions (checkpoint_id, state, created) VALUES (?, ?, ?)',
        )
        .run(session.head, JSON.stringify(state), Date.now());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  projectedMessages(sessionId: string): Message[] {
    const raw = this.messages(sessionId);
    const projection = this.contextState(sessionId).summary;
    if (!projection) return raw;
    const index = raw.findIndex(
      (message) => message.id === projection.cutoffMessageId,
    );
    if (index < 0) return raw;
    return [
      {
        id: 'summary-' + projection.cutoffMessageId,
        role: 'user',
        content: `Earlier conversation summary:\n${projection.text}${projection.historyPath ? '\nFull earlier history: ' + projection.historyPath : ''}`,
        internal: 'summary',
      },
      ...raw.slice(index + 1),
    ];
  }
  close(): void {
    if (this.closed) return;
    this.db.close();
    for (const id of this.ownership.keys()) this.releaseSession(id);
    this.closed = true;
  }
}
