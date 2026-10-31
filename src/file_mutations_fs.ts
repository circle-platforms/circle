import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Sandbox } from './sandbox.js';
import type {
  FileMutations,
  FileMutationChange,
  FileMutationRestore,
  FileMutationSnapshot,
} from './file_mutations.js';

/**
 * The largest file whose text is kept so a turn can be undone. A bigger write still
 * happens: the turn is only marked as one Circle cannot rewind.
 */
export const RECORD_MAX_BYTES = 2 * 1024 * 1024;

/** A write Circle can put back exactly: the bytes that were there, and their bits. */
interface Receipt {
  path: string;
  /** null: the file was not there. */
  bytes: Buffer | null;
  mode: number | undefined;
}

const hash = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * The host filesystem, for a Circle with no native workspace backend: the terminal, line
 * mode, print mode and RPC. Approval and path policy stay with the tools that call this;
 * it only says what is on disk and puts bytes back.
 *
 * `read` reports an existing file it cannot bring back byte for byte (a NUL inside it, or
 * more than `RECORD_MAX_BYTES`) with `content` null and a `revision`. A journal needs the
 * difference: "nothing to undo" is not "cannot undo". `null` in both fields means missing,
 * and an `expectedRevision` of null means "must still be missing".
 */
export class FileSystemFileMutations implements FileMutations {
  constructor(private sandbox: Sandbox) {}

  async read(path: string, signal: AbortSignal): Promise<FileMutationSnapshot> {
    signal.throwIfAborted();
    this.sandbox.checkCredentialPath(path);
    if (!existsSync(path)) return { path, content: null, revision: null };
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error(`not a file: ${path}`);
    const bytes = readFileSync(path);
    const mode = stats.mode & 0o7777;
    const revision = hash(bytes);
    // A NUL is the cheapest honest sign of bytes no text tool meant to write.
    if (bytes.length > RECORD_MAX_BYTES || bytes.includes(0))
      return { path, content: null, revision, mode };
    return { path, content: bytes.toString('utf8'), revision, mode };
  }

  /** The file's revision, or null when it is not there. A directory is not a file. */
  private current(path: string): string | null {
    if (!existsSync(path)) return null;
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error(`not a file: ${path}`);
    return hash(readFileSync(path));
  }

  async apply(
    changes: FileMutationChange[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    for (const change of changes) this.sandbox.checkMutablePath(change.path);
    this.checked(changes);
    const started: Receipt[] = [];
    try {
      for (const change of changes)
        started.push(this.put(change.path, change.content));
    } catch (error) {
      this.rollback(started);
      throw error;
    }
  }

  async restoreAtomic(
    changes: FileMutationRestore[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    for (const change of changes) this.sandbox.checkMutablePath(change.path);
    this.checked(changes);
    const started: Receipt[] = [];
    try {
      for (const change of changes) {
        started.push(this.put(change.path, change.content));
        // The bits come from the before-image the journal recorded, never from a caller.
        if (change.mode !== undefined && existsSync(change.path))
          chmodSync(change.path, change.mode);
      }
    } catch (error) {
      this.rollback(started);
      throw error;
    }
  }

  /** Every version is read before the first byte is written: a mismatch changes nothing. */
  private checked(
    changes: { path: string; expectedRevision: string | null }[],
  ): void {
    const stale = changes
      .filter((change) => this.current(change.path) !== change.expectedRevision)
      .map((change) => change.path);
    if (stale.length)
      throw new Error(
        `file changed since it was read: ${stale.join(', ')}; no files written`,
      );
  }

  /** One file, with what was there before it written down as a receipt. */
  private put(path: string, content: string | null): Receipt {
    const receipt: Receipt = {
      path,
      bytes: existsSync(path) ? readFileSync(path) : null,
      mode: (() => {
        try {
          return statSync(path).isFile()
            ? statSync(path).mode & 0o7777
            : undefined;
        } catch {
          return undefined;
        }
      })(),
    };
    if (content === null) {
      if (receipt.bytes !== null) unlinkSync(path);
      return receipt;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return receipt;
  }

  /** Undo the writes already made in this batch, newest first. */
  private rollback(started: Receipt[]): void {
    for (const receipt of started.reverse()) {
      try {
        if (receipt.bytes === null) {
          if (existsSync(receipt.path)) unlinkSync(receipt.path);
          continue;
        }
        mkdirSync(dirname(receipt.path), { recursive: true });
        writeFileSync(receipt.path, receipt.bytes);
        if (receipt.mode !== undefined) chmodSync(receipt.path, receipt.mode);
      } catch {
        // The first failure is the one worth reporting; a half-restored batch says so.
      }
    }
  }
}
