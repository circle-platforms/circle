import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  DEFAULT_CREDENTIAL_FILES,
  wildcard,
} from '../../../../src/approvals.ts';
import type {
  FileMutationChange,
  FileMutationRestore,
  FileMutationSnapshot,
} from '../../../../src/file_mutations.ts';
import { DocumentPathError, WorkspaceDocuments } from './documents.ts';

export interface ExternalFileGrant {
  id: string;
  sessionId: string;
  path: string;
  access: 'read' | 'readwrite';
}
interface Entry extends ExternalFileGrant {
  active: boolean;
  sessionEpoch: number;
  identity: string | null;
  parent: string;
  parentIdentity: string;
  documents: WorkspaceDocuments;
}
export interface ExternalFileGrantOptions {
  credentialFiles?: string[];
  protectedRoots?: string[];
  maxBytes?: number;
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
  );
};

/** Main-process exact-file capabilities. Only the native OS-picker path may call mint. */
export class ExternalFileGrants {
  private entries = new Map<string, Entry>();
  private sessionEpochs = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private options: ExternalFileGrantOptions = {}) {}

  private credentials(path: string): void {
    const patterns = [
      ...DEFAULT_CREDENTIAL_FILES,
      ...(this.options.credentialFiles ?? []),
    ];
    const portable = path.split(sep).join('/').toLowerCase();
    if (
      patterns.some((pattern) => {
        const configured = pattern.replace(/\\/g, '/').toLowerCase();
        return (
          wildcard(configured, portable) ||
          (!isAbsolute(pattern) && wildcard('*/' + configured, portable))
        );
      })
    )
      throw new DocumentPathError(
        'configured credential path cannot be granted',
      );
    const parts = path.split(sep);
    for (const part of parts)
      if (
        ['.git', '.circle', '.ssh', '.aws', '.gnupg'].includes(
          part.toLowerCase(),
        ) ||
        patterns.some((pattern) =>
          wildcard(pattern.toLowerCase(), part.toLowerCase()),
        )
      )
        throw new DocumentPathError(
          'credential or private application files cannot be granted',
        );
    for (const root of this.options.protectedRoots ?? []) {
      let canonical: string;
      try {
        canonical = realpathSync.native(resolve(root));
      } catch {
        canonical = resolve(root);
      }
      if (inside(canonical, path))
        throw new DocumentPathError(
          'private application data cannot be granted',
        );
    }
  }
  private check(entry: Entry, path = basename(entry.path)): void {
    if (this.closed || !entry.active || this.entries.get(entry.id) !== entry)
      throw new DocumentPathError(
        'external file grant was revoked; select the file again',
      );
    if (path !== basename(entry.path))
      throw new DocumentPathError(
        'external grant does not authorize this file',
      );
    this.credentials(entry.path);
    const parent = lstatSync(entry.parent, { bigint: true });
    if (
      parent.isSymbolicLink() ||
      !parent.isDirectory() ||
      `${parent.dev}:${parent.ino}` !== entry.parentIdentity ||
      realpathSync.native(entry.parent) !== entry.parent
    )
      throw new DocumentPathError(
        'external file parent moved; select the file again',
      );
  }
  private find(sessionId: string, path: string, write = false): Entry {
    // Paths are exact canonical names. Never resolve a newly supplied symlink to
    // make an unrelated renderer path match a grant.
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new DocumentPathError('use the exact granted external file path');
    const entry = [...this.entries.values()].find(
      (e) => e.sessionId === sessionId && e.path === path && e.active,
    );
    if (!entry)
      throw new DocumentPathError(
        'external file requires an explicit grant for this session',
      );
    this.check(entry);
    if (write && entry.access !== 'readwrite')
      throw new DocumentPathError('external file grant is read-only');
    return entry;
  }
  allows(
    sessionId: string,
    path: string,
    access: 'read' | 'write' = 'read',
  ): boolean {
    try {
      this.find(sessionId, path, access === 'write');
      return true;
    } catch {
      return false;
    }
  }
  list(sessionId: string): ExternalFileGrant[] {
    return [...this.entries.values()]
      .filter((e) => e.active && e.sessionId === sessionId)
      .map(({ id, sessionId, path, access }) => ({
        id,
        sessionId,
        path,
        access,
      }));
  }
  setCredentialFiles(patterns: string[]): void {
    this.options = { ...this.options, credentialFiles: [...patterns] };
  }

  async mint(
    sessionId: string,
    path: string,
    access: 'read' | 'readwrite',
  ): Promise<ExternalFileGrant> {
    if (this.closed) throw Error('external grants are closed');
    const sessionEpoch = this.sessionEpochs.get(sessionId) ?? 0;
    if (!sessionId || !['read', 'readwrite'].includes(access))
      throw Error('session and valid access are required');
    if (!isAbsolute(path))
      throw new DocumentPathError('native picker must supply an absolute file');
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n)
      throw new DocumentPathError(
        'only a regular non-linked file can be granted',
      );
    const canonical = await realpath(path);
    this.credentials(canonical);
    const parent = dirname(canonical);
    const parentStat = await lstat(parent, { bigint: true });
    const id = randomUUID();
    const entry = {
      id,
      sessionId,
      path: canonical,
      access,
      active: true,
      sessionEpoch,
      identity: `${info.dev}:${info.ino}`,
      parent,
      parentIdentity: `${parentStat.dev}:${parentStat.ino}`,
    } as Entry;
    entry.documents = new WorkspaceDocuments(parent, {
      credentialFiles: this.options.credentialFiles,
      maxBytes: this.options.maxBytes,
      access: {
        check: (path) => this.check(entry, path),
        checkFile: (path, identity) => {
          this.check(entry, path);
          if (identity !== entry.identity)
            throw new DocumentPathError(
              'external file identity changed; select the file again',
            );
        },
        committed: (path, identity) => {
          this.check(entry, path);
          entry.identity = identity;
        },
      },
    });
    if (
      this.closed ||
      (this.sessionEpochs.get(sessionId) ?? 0) !== sessionEpoch
    )
      throw new DocumentPathError(
        'external grant request expired with its session',
      );
    this.entries.set(id, entry);
    try {
      // Validate UTF-8, size and fstat authority before returning any capability.
      await entry.documents.read(basename(canonical));
    } catch (error) {
      await this.revoke(sessionId, id);
      throw error;
    }
    // Re-granting never extends an old preview's authority.
    for (const prior of [...this.entries.values()])
      if (
        prior.id !== id &&
        prior.sessionId === sessionId &&
        prior.path === canonical
      )
        await this.revoke(sessionId, prior.id);
    return { id, sessionId, path: canonical, access };
  }
  private invalidate(entry: Entry): void {
    entry.active = false;
    entry.documents.close();
    this.entries.delete(entry.id);
  }
  async revoke(sessionId: string, id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.sessionId !== sessionId)
      throw new DocumentPathError(
        'external grant does not belong to this session',
      );
    // Deny new calls immediately, then drain already dispatched filesystem work.
    // Once this acknowledgement resolves, an earlier mutation cannot land later.
    this.invalidate(entry);
    await this.queue;
  }
  async revokeSession(sessionId: string): Promise<void> {
    this.sessionEpochs.set(
      sessionId,
      (this.sessionEpochs.get(sessionId) ?? 0) + 1,
    );
    for (const entry of [...this.entries.values()])
      if (entry.sessionId === sessionId) this.invalidate(entry);
    await this.queue;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of [...this.entries.values()]) this.invalidate(entry);
    await this.queue;
  }

  private async snapshot(
    sessionId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<FileMutationSnapshot> {
    signal.throwIfAborted();
    const entry = this.find(sessionId, path);
    const d = await entry.documents.snapshot(basename(path), { signal });
    this.check(entry);
    return {
      path,
      content: d?.content ?? null,
      revision: d ? `${entry.id}:${d.revision}` : null,
      mode: d?.mode,
    };
  }
  async read(
    sessionId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<FileMutationSnapshot> {
    return this.serial(() => this.snapshot(sessionId, path, signal));
  }
  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.closed) throw Error('external grants are closed');
      return await action();
    } finally {
      release();
    }
  }
  apply(
    sessionId: string,
    changes: FileMutationChange[],
    signal: AbortSignal,
  ): Promise<void> {
    return this.transaction(sessionId, changes, signal, false);
  }
  restoreAtomic(
    sessionId: string,
    changes: FileMutationRestore[],
    signal: AbortSignal,
  ): Promise<void> {
    return this.transaction(sessionId, changes, signal, true);
  }
  private transaction(
    sessionId: string,
    changes: FileMutationRestore[],
    signal: AbortSignal,
    restore: boolean,
  ): Promise<void> {
    return this.serial(async () => {
      signal.throwIfAborted();
      if (
        !changes.length ||
        new Set(changes.map((c) => c.path)).size !== changes.length
      )
        throw Error('external file changes require distinct exact paths');
      const entries = changes.map((change) =>
        this.find(sessionId, change.path, true),
      );
      const before = await Promise.all(
        changes.map((change) => this.snapshot(sessionId, change.path, signal)),
      );
      for (const [index, change] of changes.entries())
        if (before[index]!.revision !== change.expectedRevision)
          throw Error(
            `external file changed since read_file: ${change.path}; no files changed`,
          );
      const completed: { index: number; after?: FileMutationSnapshot }[] = [];
      try {
        for (const [index, change] of changes.entries()) {
          const entry = entries[index]!;
          this.check(entry);
          signal.throwIfAborted();
          const edit = {
            ...change,
            path: basename(change.path),
            expectedRevision:
              change.expectedRevision === null
                ? null
                : change.expectedRevision.slice(entry.id.length + 1),
          };
          try {
            if (restore)
              await entry.documents.restoreAtomic([edit], { signal });
            else {
              const result = await entry.documents.applyChanges([edit], {
                signal,
              });
              if (result.status !== 'applied')
                throw Object.assign(
                  Error(result.failures.map((f) => f.message).join('; ')),
                  { committedPaths: result.committedPaths },
                );
            }
          } catch (error) {
            if (
              (error as { committedPaths?: string[] }).committedPaths?.includes(
                basename(change.path),
              )
            )
              completed.push({ index });
            throw error;
          }
          const done: { index: number; after?: FileMutationSnapshot } = {
            index,
          };
          completed.push(done);
          done.after = await this.snapshot(sessionId, change.path, signal);
        }
      } catch (error) {
        const compensationFailures: string[] = [];
        for (const done of completed.reverse()) {
          const prior = before[done.index]!;
          const entry = entries[done.index]!;
          try {
            this.check(entry);
            if (!done.after)
              throw Error(
                'cannot verify committed after-image; explicit recovery is required',
              );
            await entry.documents.restoreAtomic([
              {
                path: basename(prior.path),
                content: prior.content,
                expectedRevision:
                  done.after.revision === null
                    ? null
                    : done.after.revision.slice(entry.id.length + 1),
                mode: prior.mode,
              },
            ]);
          } catch (failure) {
            compensationFailures.push(`${prior.path}: ${String(failure)}`);
          }
        }
        throw Object.assign(
          Error(
            `external file transaction failed: ${String(error)}; ${compensationFailures.length ? 'compensation incomplete: ' + compensationFailures.join('; ') : 'completed file changes compensated'}`,
          ),
          {
            committedPaths: completed.map((done) => changes[done.index]!.path),
            compensationFailures,
          },
        );
      }
    });
  }
}
