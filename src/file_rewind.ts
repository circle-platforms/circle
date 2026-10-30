import { randomUUID } from 'node:crypto';
import type {
  FileMutations,
  FileMutationSnapshot,
  FileMutationRestore,
} from './file_mutations.js';

export interface RewindEntry {
  before: FileMutationSnapshot;
  after: FileMutationSnapshot;
}

export interface FileRewindPreview {
  id: string;
  turnId: string;
  paths: string[];
  conflicts: string[];
  unsupported: string[];
}

/** Where a turn's entries live past this process: the session's own database. */
export interface RewindLedger {
  rewindLoad(sessionId: string): { turnId: string; entries: RewindEntry[] }[];
  rewindSave(sessionId: string, turnId: string, entries: RewindEntry[]): void;
  rewindDrop(sessionId: string, turnId: string): void;
}

export interface RewindJournalOptions {
  /** The conversation this journal writes to; undefined while none is open. */
  session?: () => string | undefined;
  /** What keeps turns past a restart. Without it the journal is memory only, as before. */
  ledger?: () => RewindLedger | undefined;
}

/** Text-tool journal. Never reads Git state or pretends shell effects are reversible. */
export class FileRewindJournal {
  private turns = new Map<string, Map<string, RewindEntry>>();
  private previews = new Map<
    string,
    { turnId: string; entries: RewindEntry[] }
  >();
  private activeTurn: string | undefined;
  private invalid = new Set<string>();
  private reasons = new Map<string, string>();
  private loaded: string | undefined;
  readonly files: FileMutations;
  constructor(
    private backend: FileMutations,
    private options: RewindJournalOptions = {},
  ) {
    this.files = {
      authorize: this.backend.authorize?.bind(this.backend),
      read: (path, signal) => this.backend.read(path, signal),
      apply: async (changes, signal) => {
        const turnId = this.activeTurn;
        const before = await Promise.all(
          changes.map((change) => this.backend.read(change.path, signal)),
        );
        try {
          await this.backend.apply(changes, signal);
        } catch (error) {
          if (turnId) this.invalid.add(turnId);
          throw error;
        }
        if (!turnId) return;
        const entries =
          this.turns.get(turnId) ?? new Map<string, RewindEntry>();
        this.turns.set(turnId, entries);
        for (const [index, change] of changes.entries()) {
          try {
            const after = await this.backend.read(change.path, signal);
            const previous = entries.get(change.path);
            // Do not capture another writer's result as our own after-image.
            if (
              after.content !== change.content ||
              (previous && previous.after.revision !== before[index]!.revision)
            ) {
              this.invalid.add(turnId);
              continue;
            }
            entries.set(change.path, {
              before: previous?.before ?? before[index]!,
              after,
            });
          } catch {
            // A successful file write stays successful; incomplete receipts only
            // disable undo, rather than misreporting committed effects as failed.
            this.invalid.add(turnId);
          }
        }
        if (!this.invalid.has(turnId)) this.persist(turnId, entries);
      },
    };
  }

  beginTurn(turnId: string): void {
    if (!turnId) throw Error('a real turn ID is required');
    this.ensureLoaded();
    this.activeTurn = turnId;
  }
  availableTurns(): string[] {
    this.ensureLoaded();
    return [...this.turns.keys()].filter((id) => !this.invalid.has(id));
  }
  /** The paths one turn changed, from what is already recorded: no file is read again. */
  recordedPaths(turnId: string): string[] {
    this.ensureLoaded();
    return [...(this.turns.get(turnId)?.keys() ?? [])];
  }
  endTurn(): void {
    this.activeTurn = undefined;
  }

  /**
   * Record what `write` changes in `paths`, under the turn now running. The terminal's
   * file tools write straight to the disk, so they come here instead of through
   * `files.apply`. A change that cannot be recorded still happens: only its turn loses
   * the rewind, and `why` says what stopped it.
   */
  async capture<T>(
    paths: string[],
    signal: AbortSignal,
    write: () => T | Promise<T>,
  ): Promise<T> {
    this.ensureLoaded();
    const turnId = this.activeTurn;
    const before = turnId ? await this.images(paths, signal) : [];
    const result = await write();
    if (!turnId) return result;
    const after = await this.images(paths, signal);
    const entries = this.turns.get(turnId) ?? new Map<string, RewindEntry>();
    this.turns.set(turnId, entries);
    for (const [index, path] of paths.entries()) {
      const b = before[index];
      const a = after[index];
      if (!b || !a) {
        this.unavailable(turnId, `${path} could not be read`);
        continue;
      }
      if (this.unrecordable(b) || this.unrecordable(a)) {
        this.unavailable(
          turnId,
          `${path} is not text Circle can bring back byte for byte`,
        );
        continue;
      }
      const previous = entries.get(path);
      // Do not capture another writer's result as our own after-image.
      if (previous && previous.after.revision !== b.revision) {
        this.unavailable(turnId, `${path} changed outside this turn`);
        continue;
      }
      entries.set(path, { before: previous?.before ?? b, after: a });
    }
    // A turn that cannot be undone is not offered, and keeps no receipts: one
    // unrecordable file, or one written by someone else, is enough to forget the turn.
    if (this.invalid.has(turnId) || !entries.size) this.forget(turnId);
    else this.persist(turnId, entries);
    return result;
  }

  /** Bind one journal to one runtime session. Use beginTurn only at actual turn entry. */

  async preview(
    turnId: string,
    signal: AbortSignal,
  ): Promise<FileRewindPreview> {
    if (this.activeTurn)
      throw Error('wait until the running turn finishes before undoing files');
    this.ensureLoaded();
    if (this.invalid.has(turnId)) throw Error(this.reason(turnId));
    const entries = [...(this.turns.get(turnId)?.values() ?? [])];
    if (!entries.length)
      throw Error('this turn has no recorded text-tool file changes');
    const conflicts: string[] = [];
    for (const entry of entries) {
      const current = await this.backend.read(entry.after.path, signal);
      if (current.revision !== entry.after.revision)
        conflicts.push(entry.after.path);
    }
    const id = randomUUID();
    this.previews.set(id, { turnId, entries });
    return {
      id,
      turnId,
      paths: entries.map((entry) => entry.after.path),
      conflicts,
      unsupported: ['shell commands, external services and unrecorded edits'],
    };
  }

  async restore(
    previewId: string,
    signal: AbortSignal,
  ): Promise<{ turnId: string; paths: string[] }> {
    if (this.activeTurn)
      throw Error('wait until the running turn finishes before undoing files');
    const preview = this.previews.get(previewId);
    if (!preview)
      throw Error('file undo preview expired; preview the turn again');
    const changes: FileMutationRestore[] = [];
    // Validate every file again at commit, including changes made after preview.
    for (const entry of preview.entries) {
      const current = await this.backend.read(entry.after.path, signal);
      if (current.revision !== entry.after.revision)
        throw Error(
          `file changed after the turn: ${entry.after.path}; no files restored`,
        );
      changes.push({
        path: entry.before.path,
        content: entry.before.content,
        expectedRevision: entry.after.revision,
        mode: entry.before.mode,
      });
    }
    if (!this.backend.restoreAtomic)
      throw Error('this file backend does not support safe multi-file undo');
    await this.backend.restoreAtomic(changes, signal);
    this.turns.delete(preview.turnId);
    const held = this.handle();
    held?.ledger.rewindDrop(held.session, preview.turnId);
    // Earlier previews refer to revisions that no longer exist.
    this.previews.clear();
    return {
      turnId: preview.turnId,
      paths: changes.map((change) => change.path),
    };
  }

  /** An existing file whose text this journal cannot hold: binary, or too big. */
  private unrecordable(image: FileMutationSnapshot): boolean {
    return image.content === null && image.revision !== null;
  }

  /** Read as many images as the write touches; a file that cannot be read is undefined. */
  private async images(
    paths: string[],
    signal: AbortSignal,
  ): Promise<(FileMutationSnapshot | undefined)[]> {
    return await Promise.all(
      paths.map(async (path) => {
        try {
          return await this.backend.read(path, signal);
        } catch {
          return undefined;
        }
      }),
    );
  }

  private unavailable(turnId: string, why: string): void {
    this.invalid.add(turnId);
    if (!this.reasons.has(turnId)) this.reasons.set(turnId, why);
  }

  /** What `preview` says for a turn it cannot offer. The wording an older turn keeps. */
  private reason(turnId: string): string {
    return (
      this.reasons.get(turnId) ??
      'external edits interrupted this turn; file undo is unavailable'
    );
  }

  /** The ledger and conversation this journal may write to, when it has both. */
  private handle(): { session: string; ledger: RewindLedger } | undefined {
    const session = this.options.session?.();
    const ledger = this.options.ledger?.();
    return session && ledger ? { session, ledger } : undefined;
  }

  /** Take the stored turns back once per conversation, so a restart can still rewind. */
  private ensureLoaded(): void {
    const held = this.handle();
    if (!held || this.loaded === held.session) return;
    this.loaded = held.session;
    for (const turn of held.ledger.rewindLoad(held.session)) {
      // A turn this process already recorded is the newer word on those files.
      if (this.turns.has(turn.turnId)) continue;
      const entries = new Map<string, RewindEntry>();
      for (const entry of turn.entries) entries.set(entry.after.path, entry);
      this.turns.set(turn.turnId, entries);
    }
  }

  /** Drop a turn this journal can no longer offer, in memory and in the ledger. */
  private forget(turnId: string): void {
    this.turns.delete(turnId);
    const held = this.handle();
    if (held)
      try {
        held.ledger.rewindDrop(held.session, turnId);
      } catch {
        // The turn is already refused here; a stale row cannot be rewound to anything.
      }
  }

  private persist(turnId: string, entries: Map<string, RewindEntry>): void {
    const held = this.handle();
    if (!held) return;
    try {
      held.ledger.rewindSave(held.session, turnId, [...entries.values()]);
    } catch {
      // A store that cannot take the receipt costs only the rewind after a restart.
      // The files themselves are already written, so the turn stays successful.
    }
  }
}
