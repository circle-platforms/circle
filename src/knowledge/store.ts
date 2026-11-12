import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { decodeSyncObject, encodeSyncObject, sha256 } from './canonical.js';
import {
  assertSuccessor,
  MAX_LOCAL_SOURCE_BYTES,
  validateGraph,
  type SnapshotGraph,
  type ValidateGraphOptions,
} from './graph.js';
import { ObjectFiles, privateDirectory } from './objects.js';
import { decodeBase64, SYNC_LIMITS, SYNC_PROTOCOL } from './protocol.js';
import { indexTerms, knowledgeTokens, searchExpression } from './search.js';
import {
  verifyLocal,
  LOCAL_VERIFIER,
  type Verification,
} from './verification.js';
import type { SyncItem, SyncObject } from './types.js';

const DATABASE_VERSION = 4;
const APPLICATION_ID = 0x434b4e31;
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, kind TEXT NOT NULL, bytes INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS versions(sequence INTEGER PRIMARY KEY, snapshot TEXT NOT NULL UNIQUE REFERENCES objects(id)) STRICT;
  CREATE TABLE IF NOT EXISTS current_items(item_id TEXT PRIMARY KEY, kind TEXT NOT NULL, heads TEXT NOT NULL, path TEXT) STRICT;
  CREATE TABLE IF NOT EXISTS search_documents(id INTEGER PRIMARY KEY, item_id TEXT NOT NULL UNIQUE, object_id TEXT NOT NULL REFERENCES objects(id), path TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, statement TEXT NOT NULL) STRICT;
  CREATE VIRTUAL TABLE IF NOT EXISTS search_terms USING fts5(terms, tokenize='ascii');
  CREATE INDEX IF NOT EXISTS search_scope ON search_documents(path,kind,status);
  CREATE TABLE IF NOT EXISTS verification_observations(snapshot TEXT NOT NULL REFERENCES objects(id), object_id TEXT NOT NULL REFERENCES objects(id), rule TEXT NOT NULL, observation TEXT NOT NULL, PRIMARY KEY(snapshot,object_id,rule)) STRICT;
  CREATE TABLE IF NOT EXISTS personal_pack_installations(object_id TEXT PRIMARY KEY REFERENCES objects(id), path TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;
  CREATE TABLE IF NOT EXISTS sync_journal(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS sync_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS local_revision_times(object_id TEXT PRIMARY KEY REFERENCES objects(id), updated_at TEXT NOT NULL) STRICT;
`;
export interface SearchOptions {
  path?: string;
  kind?: string;
  status?: 'verified' | 'unverified';
  limit?: number;
  cursor?: string;
}
export interface SearchHit {
  itemId: string;
  objectId: string;
  path: string;
  kind: string;
  status: 'verified' | 'unverified';
  statement: string;
}
export class KnowledgeVersionConflict extends Error {
  constructor(readonly current: string | null) {
    super('knowledge version changed; read and merge before committing');
  }
}
export interface StoreOptions {
  /** Fault-injection seam for crash/transaction checks; never supplied by a model or renderer. */
  onPhase?: (phase: 'object-published' | 'projection-written') => void;
}
export class KnowledgeStore {
  readonly directory: string;
  readonly databasePath: string;
  readonly recoveredObjects: number;
  private readonly db: DatabaseSync;
  private readonly files: ObjectFiles;
  private inTransaction = false;
  private closed = false;
  constructor(
    home: string,
    private readonly options: StoreOptions = {},
  ) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.directory = join(realpathSync.native(home), 'knowledge');
    privateDirectory(this.directory);
    this.databasePath = join(this.directory, 'knowledge.sqlite');
    if (
      existsSync(this.databasePath) &&
      (!lstatSync(this.databasePath).isFile() ||
        lstatSync(this.databasePath).isSymbolicLink())
    )
      throw Error('invalid knowledge database file');
    this.db = new DatabaseSync(this.databasePath);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      this.checkVersion();
      chmodSync(this.databasePath, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
      this.files = new ObjectFiles(join(this.directory, 'objects'));
      this.recoveredObjects = this.transaction(() => {
        this.checkVersion();
        const version = this.version();
        if (version < DATABASE_VERSION) {
          this.db.exec(SCHEMA_SQL);
          this.db.exec(
            `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${DATABASE_VERSION};`,
          );
        }
        this.db
          .prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)')
          .run('client_id', randomUUID());
        return this.files.recover((id) => this.has(id));
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private version(): number {
    return Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
  }
  private checkVersion(): void {
    const version = this.version();
    if (version > DATABASE_VERSION)
      throw Error('knowledge database requires a newer Circle version');
    const app = Number(
      this.db.prepare('PRAGMA application_id').get()!.application_id,
    );
    const populated = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
      )
      .get();
    if (
      (version > 0 && app !== APPLICATION_ID) ||
      (version === 0 && (app !== 0 || populated))
    )
      throw Error('not a Circle knowledge database');
  }
  private transaction<T>(action: () => T): T {
    if (this.closed) throw Error('knowledge store is closed');
    if (this.inTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const value = action();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  get clientId(): string {
    return this.db
      .prepare("SELECT value FROM metadata WHERE key='client_id'")
      .get()!.value as string;
  }
  get head(): string | null {
    return (
      (this.db.prepare("SELECT value FROM metadata WHERE key='head'").get()
        ?.value as string) ?? null
    );
  }
  has(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM objects WHERE id=?').get(id));
  }
  readBytes(id: string): Buffer {
    if (!this.has(id)) throw Error('knowledge object unavailable');
    return this.files.readBytes(id);
  }
  read(id: string): SyncObject {
    return decodeSyncObject(this.readBytes(id), id);
  }
  /** A batch as sync transfers it: within a sync batch's object and byte limits. */
  putBatch(inputs: readonly unknown[]): string[] {
    if (inputs.length > SYNC_LIMITS.batchObjects)
      throw new RangeError('knowledge batch object limit');
    let total = 0;
    return this.publish(
      inputs.map((input) => {
        const encoded = this.encode(input);
        total += encoded.bytes.length;
        if (total > SYNC_LIMITS.objectBytes)
          throw new RangeError('knowledge batch byte limit');
        return encoded;
      }),
    );
  }
  /**
   * The objects of a local change with those it generates, in one transaction. A change is not a sync batch: sync
   * uploads in batches of its own, so only each object's own limits apply here (#525).
   */
  putChange(inputs: readonly unknown[]): string[] {
    return this.publish(inputs.map((input) => this.encode(input)));
  }
  private encode(input: unknown) {
    const bytes = encodeSyncObject(input);
    return { bytes, id: sha256(bytes), kind: (input as SyncObject).kind };
  }
  private publish(
    encoded: readonly { bytes: Buffer; id: string; kind: string }[],
  ): string[] {
    return this.transaction(() =>
      encoded.map(({ id, bytes, kind }) => {
        this.files.publish(id, bytes);
        this.options.onPhase?.('object-published');
        this.db
          .prepare('INSERT OR IGNORE INTO objects(id,kind,bytes) VALUES(?,?,?)')
          .run(id, kind, bytes.length);
        return id;
      }),
    );
  }
  put(input: unknown): string {
    return this.putBatch([input])[0]!;
  }
  importBytes(bytes: Uint8Array, id: string): string {
    const object = decodeSyncObject(bytes, id);
    const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return this.transaction(() => {
      this.files.publish(id, raw);
      this.options.onPhase?.('object-published');
      this.db
        .prepare('INSERT OR IGNORE INTO objects(id,kind,bytes) VALUES(?,?,?)')
        .run(id, object.kind, raw.length);
      return id;
    });
  }
  graph(snapshot: string, options?: ValidateGraphOptions): SnapshotGraph {
    return validateGraph(snapshot, (id) => this.read(id), {
      allowStructuralConflicts: true,
      ...options,
    });
  }
  commit(
    snapshot: string,
    expected: string | null,
    sync = false,
    prevalidatedGraph?: SnapshotGraph,
    prevalidatedCurrent?: SnapshotGraph | null,
  ): void {
    this.transaction(() => {
      const current = this.head;
      if (current !== expected) throw new KnowledgeVersionConflict(current);
      const currentGraph =
        prevalidatedCurrent !== undefined
          ? prevalidatedCurrent
          : current
            ? this.graph(current)
            : null;
      const trustedObjects = currentGraph
        ? new Set(currentGraph.objects.keys())
        : undefined;
      const next =
        prevalidatedGraph ??
        validateGraph(snapshot, (id) => this.read(id), {
          allowStructuralConflicts: sync,
          trustedObjects,
        });
      if (currentGraph) assertSuccessor(currentGraph, next);
      if (!sync) {
        const priorHeads = new Set(
          currentGraph ? currentGraph.items.flatMap((item) => item.heads) : [],
        );
        const updatedAt = new Date().toISOString();
        for (const item of next.items)
          for (const head of item.heads) {
            if (!priorHeads.has(head))
              this.db
                .prepare(
                  'INSERT OR IGNORE INTO local_revision_times VALUES(?,?)',
                )
                .run(head, updatedAt);
          }
      }
      this.project(next);
      this.options.onPhase?.('projection-written');
      this.db
        .prepare(
          "INSERT INTO metadata(key,value) VALUES('head',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(snapshot);
      this.db
        .prepare('INSERT OR IGNORE INTO versions(snapshot) VALUES(?)')
        .run(snapshot);
    });
  }
  localUpdatedAt(object: string): string | null {
    return (
      (this.db
        .prepare(
          'SELECT updated_at FROM local_revision_times WHERE object_id=?',
        )
        .get(object)?.updated_at as string) ?? null
    );
  }
  apply(expected: string | null, action: () => string): string {
    try {
      return this.transaction(() => {
        if (this.head !== expected)
          throw new KnowledgeVersionConflict(this.head);
        const currentGraph = expected ? this.graph(expected) : null;
        const snapshot = action();
        const trustedObjects = currentGraph
          ? new Set(currentGraph.objects.keys())
          : undefined;
        const graph = validateGraph(snapshot, (id) => this.read(id), {
          allowStructuralConflicts: false,
          trustedObjects,
        });
        const priorObservations = expected
          ? new Map(this.observations(expected).map((o) => [o.object, o]))
          : undefined;
        const observations = verifyLocal(graph, priorObservations);
        for (const observation of observations)
          this.db
            .prepare(
              'INSERT OR REPLACE INTO verification_observations VALUES(?,?,?,?)',
            )
            .run(
              snapshot,
              observation.object,
              observation.rule,
              JSON.stringify(observation),
            );
        this.commit(snapshot, expected, false, graph, currentGraph);
        return snapshot;
      });
    } catch (error) {
      this.transaction(() => this.files.recover((id) => this.has(id)));
      throw error;
    }
  }
  syncRead<T>(key: string): T | null {
    const row = this.db
      .prepare('SELECT value FROM sync_journal WHERE key=?')
      .get(key);
    return row ? (JSON.parse(row.value as string) as T) : null;
  }
  syncProjection(
    epoch: string,
    snapshot: string,
    state: string,
    item: string,
    object: string,
  ): unknown | null {
    const rows = this.db
      .prepare(
        `SELECT p.value AS projection FROM sync_journal AS j, json_each(j.value,'$.projections') AS p WHERE j.key LIKE 'result:%' AND json_extract(j.value,'$.state.epoch')=? AND json_extract(j.value,'$.state.snapshot')=? AND json_extract(j.value,'$.state.state_version')=? AND json_extract(p.value,'$.item_id')=? AND json_extract(p.value,'$.object')=? LIMIT 2`,
      )
      .all(epoch, snapshot, state, item, object);
    if (rows.length !== 1) return null;
    return JSON.parse(rows[0]!.projection as string);
  }
  syncWrite(key: string, value: unknown): void {
    if (value === null)
      this.db.prepare('DELETE FROM sync_journal WHERE key=?').run(key);
    else
      this.db
        .prepare(
          'INSERT INTO sync_journal VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(key, JSON.stringify(value));
  }
  acquireSyncLease(token: string, now: number, duration: number): boolean {
    return this.transaction(
      () =>
        Number(
          this.db
            .prepare(
              'INSERT INTO sync_lease VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE sync_lease.expires<=?',
            )
            .run(token, now + duration, now).changes,
        ) === 1,
    );
  }
  renewSyncLease(token: string, now: number, duration: number): boolean {
    return (
      Number(
        this.db
          .prepare(
            'UPDATE sync_lease SET expires=? WHERE singleton=1 AND token=? AND expires>?',
          )
          .run(now + duration, token, now).changes,
      ) === 1
    );
  }
  assertSyncLease(token: string, now: number): void {
    if (
      !this.db
        .prepare(
          'SELECT 1 FROM sync_lease WHERE singleton=1 AND token=? AND expires>?',
        )
        .get(token, now)
    )
      throw Error('knowledge sync lease lost');
  }
  releaseSyncLease(token: string): void {
    this.db
      .prepare('DELETE FROM sync_lease WHERE singleton=1 AND token=?')
      .run(token);
  }
  syncAtomic<T>(token: string, now: () => number, action: () => T): T {
    return this.transaction(() => {
      this.assertSyncLease(token, now());
      const result = action();
      this.assertSyncLease(token, now());
      return result;
    });
  }
  publishSync(snapshot: string, expected: string | null): void {
    const currentGraph =
      expected && this.has(expected) ? this.graph(expected) : null;
    const trustedObjects = currentGraph
      ? new Set(currentGraph.objects.keys())
      : undefined;
    const graph = this.graph(snapshot, {
      allowStructuralConflicts: true,
      trustedObjects,
    });
    const priorObservations = expected
      ? new Map(this.observations(expected).map((o) => [o.object, o]))
      : undefined;
    for (const observation of verifyLocal(graph, priorObservations))
      this.db
        .prepare(
          'INSERT OR REPLACE INTO verification_observations VALUES(?,?,?,?)',
        )
        .run(
          snapshot,
          observation.object,
          observation.rule,
          JSON.stringify(observation),
        );
    this.commit(
      snapshot,
      expected,
      true,
      graph,
      this.head === expected ? currentGraph : undefined,
    );
  }
  installPack(
    expected: string,
    object: string,
    path: string,
    publish: () => void,
    enabled = true,
  ): void {
    this.transaction(() => {
      if (this.head !== expected) throw new KnowledgeVersionConflict(this.head);
      if (
        !this.items().some(
          (row) =>
            row.kind === 'pack_manifest' &&
            row.heads.length === 1 &&
            row.heads[0] === object,
        )
      )
        throw Error('personal pack unavailable or conflicted');
      publish();
      this.db
        .prepare(
          'INSERT INTO personal_pack_installations VALUES(?,?,?) ON CONFLICT(object_id) DO UPDATE SET path=excluded.path,enabled=excluded.enabled',
        )
        .run(object, path, enabled ? 1 : 0);
    });
  }
  packInstallations(): { object: string; path: string; enabled: boolean }[] {
    return this.db
      .prepare('SELECT * FROM personal_pack_installations ORDER BY object_id')
      .all()
      .map((row) => ({
        object: row.object_id as string,
        path: row.path as string,
        enabled: row.enabled === 1,
      }));
  }
  observations(snapshot = this.head): Verification[] {
    if (!snapshot) return [];
    return this.db
      .prepare(
        'SELECT observation FROM verification_observations WHERE snapshot=? AND rule=? ORDER BY object_id',
      )
      .all(snapshot, LOCAL_VERIFIER)
      .map((row) => JSON.parse(row.observation as string));
  }
  private project(graph: SnapshotGraph): void {
    const existingItems = new Map(
      this.db
        .prepare('SELECT item_id, kind, heads, path FROM current_items')
        .all()
        .map((row) => [
          row.item_id as string,
          {
            kind: row.kind as string,
            heads: row.heads as string,
            path: (row.path as string | null) ?? null,
          },
        ]),
    );
    const existingDocs = new Map(
      this.db
        .prepare(
          'SELECT d.id, d.item_id, d.object_id, d.path, d.kind, d.status, d.statement, length(CAST(t.terms AS BLOB)) AS term_bytes FROM search_documents d LEFT JOIN search_terms t ON t.rowid=d.id',
        )
        .all()
        .map((row) => [
          row.item_id as string,
          {
            id: Number(row.id),
            object_id: row.object_id as string,
            path: row.path as string,
            kind: row.kind as string,
            status: row.status as string,
            statement: row.statement as string,
            termBytes:
              row.term_bytes === null || row.term_bytes === undefined
                ? null
                : Number(row.term_bytes),
          },
        ]),
    );
    const seenItems = new Set<string>();
    const conflictedIds = new Set(graph.conflicts.map((c) => c.item_id));
    let indexBytes = 0;
    const observations = new Map(
      this.observations(graph.snapshot).map((row) => [row.object, row]),
    );
    const deleteItemStmt = this.db.prepare(
      'DELETE FROM current_items WHERE item_id=?',
    );
    const upsertItemStmt = this.db.prepare(
      'INSERT OR REPLACE INTO current_items(item_id,kind,heads,path) VALUES(?,?,?,?)',
    );
    const deleteDocStmt = this.db.prepare(
      'DELETE FROM search_documents WHERE id=?',
    );
    const deleteTermsStmt = this.db.prepare(
      'DELETE FROM search_terms WHERE rowid=?',
    );
    const insertDocStmt = this.db.prepare(
      'INSERT INTO search_documents(item_id,object_id,path,kind,status,statement) VALUES(?,?,?,?,?,?)',
    );
    const insertTermsStmt = this.db.prepare(
      'INSERT INTO search_terms(rowid,terms) VALUES(?,?)',
    );
    for (const item of graph.items) {
      seenItems.add(item.item_id);
      const object =
        item.heads.length === 1
          ? graph.objects.get(item.heads[0]!)!
          : undefined;
      const directory =
        object && 'directory_id' in object.body
          ? object.body.directory_id
          : item.kind === 'directory_revision'
            ? item.item_id
            : undefined;
      const path = directory ? (graph.paths.get(directory) ?? null) : null;
      const headsJson = JSON.stringify(item.heads);
      const prevItem = existingItems.get(item.item_id);
      if (
        !prevItem ||
        prevItem.kind !== item.kind ||
        prevItem.heads !== headsJson ||
        prevItem.path !== path
      ) {
        upsertItemStmt.run(item.item_id, item.kind, headsJson, path);
      }
      const prevDoc = existingDocs.get(item.item_id);
      if (
        !object ||
        object.kind !== 'entry_revision' ||
        path === null ||
        conflictedIds.has(item.item_id)
      ) {
        if (prevDoc) {
          deleteTermsStmt.run(prevDoc.id);
          deleteDocStmt.run(prevDoc.id);
          existingDocs.delete(item.item_id);
        }
        continue;
      }
      const objectId = item.heads[0]!;
      const content = object.body.content;
      const status =
        observations.get(objectId)?.status === 'verified'
          ? 'verified'
          : 'unverified';
      if (
        prevDoc &&
        prevDoc.object_id === objectId &&
        prevDoc.path === path &&
        prevDoc.kind === content.kind &&
        prevDoc.status === status &&
        prevDoc.statement === content.statement &&
        prevDoc.termBytes !== null
      ) {
        indexBytes += prevDoc.termBytes;
        if (indexBytes > 64 * 1024 * 1024)
          throw new RangeError('knowledge space index limit');
        continue;
      }
      if (prevDoc) {
        deleteTermsStmt.run(prevDoc.id);
        deleteDocStmt.run(prevDoc.id);
        existingDocs.delete(item.item_id);
      }
      const quotations: string[] = [];
      for (const ground of object.body.grounds) {
        const quote = graph.objects.get(
          ground.quotation,
        ) as SyncObject<'bytes'>;
        try {
          quotations.push(
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
              decodeBase64(quote.body.bytes_base64),
            ),
          );
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
      }
      const tokens = knowledgeTokens(
        [content.statement, JSON.stringify(content.data), ...quotations].join(
          '\n',
        ),
      );
      const terms = indexTerms(tokens);
      indexBytes += Buffer.byteLength(terms);
      if (indexBytes > 64 * 1024 * 1024)
        throw new RangeError('knowledge space index limit');
      const result = insertDocStmt.run(
        item.item_id,
        objectId,
        path,
        content.kind,
        status,
        content.statement,
      );
      insertTermsStmt.run(result.lastInsertRowid, terms);
    }
    for (const itemId of existingItems.keys()) {
      if (!seenItems.has(itemId)) {
        deleteItemStmt.run(itemId);
        const prevDoc = existingDocs.get(itemId);
        if (prevDoc) {
          deleteTermsStmt.run(prevDoc.id);
          deleteDocStmt.run(prevDoc.id);
        }
      }
    }
  }
  rebuildSearch(): void {
    this.transaction(() => {
      const head = this.head;
      if (head) {
        this.db.exec(
          'DELETE FROM current_items; DELETE FROM search_terms; DELETE FROM search_documents;',
        );
        this.project(this.graph(head));
      }
    });
  }
  items(): (SyncItem & { path: string | null })[] {
    return this.db
      .prepare('SELECT * FROM current_items ORDER BY kind,item_id')
      .all()
      .map((row) => ({
        kind: row.kind as SyncItem['kind'],
        item_id: row.item_id as string,
        heads: JSON.parse(row.heads as string),
        path: row.path as string | null,
      }));
  }
  history(): string[] {
    return this.db
      .prepare('SELECT snapshot FROM versions ORDER BY sequence')
      .all()
      .map((row) => row.snapshot as string);
  }
  sourceBytes(source: string, maximumBytes = MAX_LOCAL_SOURCE_BYTES): Buffer {
    const object = this.read(source);
    if (object.kind !== 'source_revision')
      throw Error('not a knowledge source');
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 0 ||
      object.body.size > Math.min(maximumBytes, MAX_LOCAL_SOURCE_BYTES)
    )
      throw new RangeError('knowledge source read limit');
    let total = 0;
    const chunks = object.body.chunks.map((id) => {
      const chunk = this.read(id);
      if (chunk.kind !== 'bytes') throw Error('source chunk type');
      const bytes = decodeBase64(chunk.body.bytes_base64);
      total += bytes.length;
      if (total > maximumBytes || total > object.body.size)
        throw new RangeError('knowledge source read limit');
      return bytes;
    });
    const bytes = Buffer.concat(chunks);
    if (
      bytes.length !== object.body.size ||
      sha256(bytes) !== object.body.raw_sha256
    )
      throw Error('raw source hash mismatch');
    return bytes;
  }
  search(
    query: string,
    options: SearchOptions = {},
  ): { snapshot: string | null; items: SearchHit[]; next: string | null } {
    const limit = options.limit ?? 50,
      path = options.path ?? '/';
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('knowledge page limit');
    if (!path.startsWith('/') || path.includes('\0') || path.length > 4000)
      throw new TypeError('invalid search path');
    if (options.kind && !SYNC_PROTOCOL.entryKinds.includes(options.kind))
      throw new TypeError('invalid entry kind');
    if (options.status && !['verified', 'unverified'].includes(options.status))
      throw new TypeError('invalid verification status');
    const signature = sha256(
      JSON.stringify([
        query,
        path,
        options.kind ?? null,
        options.status ?? null,
      ]),
    );
    // One read transaction binds the cursor, local head and FTS projection to the same snapshot.
    this.db.exec('BEGIN');
    try {
      const snapshot = this.head;
      let offset = 0;
      if (options.cursor) {
        if (options.cursor.length > 4096)
          throw Error('knowledge search cursor invalid');
        const cursor = JSON.parse(
          Buffer.from(options.cursor, 'base64url').toString('utf8'),
        );
        if (
          cursor.snapshot !== snapshot ||
          cursor.query !== signature ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0
        )
          throw Error('knowledge search cursor stale');
        offset = cursor.offset;
      }
      const expression = searchExpression(query);
      if (!expression || !snapshot) return { snapshot, items: [], next: null };
      const clauses = ['search_terms MATCH ?'],
        params: SQLInputValue[] = [expression];
      if (path !== '/') {
        clauses.push("(d.path=? OR substr(d.path,1,length(?)+1)=?||'/')");
        params.push(path, path, path);
      }
      if (options.kind) {
        clauses.push('d.kind=?');
        params.push(options.kind);
      }
      if (options.status) {
        clauses.push('d.status=?');
        params.push(options.status);
      }
      const rows = this.db
        .prepare(
          `SELECT d.* FROM search_terms JOIN search_documents d ON d.id=search_terms.rowid WHERE ${clauses.join(' AND ')} ORDER BY d.item_id LIMIT ? OFFSET ?`,
        )
        .all(...params, limit + 1, offset);
      const more = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => ({
        itemId: row.item_id as string,
        objectId: row.object_id as string,
        path: row.path as string,
        kind: row.kind as string,
        status: row.status as SearchHit['status'],
        statement: row.statement as string,
      }));
      return {
        snapshot,
        items,
        next: more
          ? Buffer.from(
              JSON.stringify({
                snapshot,
                query: signature,
                offset: offset + limit,
              }),
            ).toString('base64url')
          : null,
      };
    } finally {
      this.db.exec('COMMIT');
    }
  }
}
