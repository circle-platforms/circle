import { randomUUID } from 'node:crypto';
import type {
  FileMutations,
  FileMutationSnapshot,
  FileMutationRestore,
} from './file_mutations.js';

interface RewindEntry {
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

/** Text-tool journal. Never reads Git state or pretends shell effects are reversible. */
export class FileRewindJournal {
  private turns = new Map<string, Map<string, RewindEntry>>();
  private previews = new Map<
    string,
    { turnId: string; entries: RewindEntry[] }
  >();
  private activeTurn: string | undefined;
  private invalid = new Set<string>();
  readonly files: FileMutations;
  constructor(private backend: FileMutations) {
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
      },
    };
  }

  beginTurn(turnId: string): void {
    if (!turnId) throw Error('a real turn ID is required');
    this.activeTurn = turnId;
  }
  availableTurns(): string[] {
    return [...this.turns.keys()].filter((id) => !this.invalid.has(id));
  }
  endTurn(): void {
    this.activeTurn = undefined;
  }

  /** Bind one journal to one runtime session. Use beginTurn only at actual turn entry. */

  async preview(
    turnId: string,
    signal: AbortSignal,
  ): Promise<FileRewindPreview> {
    if (this.activeTurn)
      throw Error('wait until the running turn finishes before undoing files');
    if (this.invalid.has(turnId))
      throw Error(
        'external edits interrupted this turn; file undo is unavailable',
      );
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
    // Earlier previews refer to revisions that no longer exist.
    this.previews.clear();
    return {
      turnId: preview.turnId,
      paths: changes.map((change) => change.path),
    };
  }
}
