import { planPatch, patchFilePaths, patchSummary } from './apply_patch.js';
import type { Sandbox } from './sandbox.js';
import type { Tool, ToolContext } from './types.js';

export interface FileMutationSnapshot {
  /** Canonical absolute path within the backend's granted workspace. */
  path: string;
  content: string | null;
  revision: string | null;
}

export interface FileMutationChange {
  path: string;
  content: string | null;
  expectedRevision: string | null;
}

/** Optional native workspace backend. CLI file semantics stay unchanged without it. */
export interface FileMutations {
  /** A missing file returns null content and revision; denied paths must reject. */
  read(path: string, signal: AbortSignal): Promise<FileMutationSnapshot>;
  /** Compare all versions before writing; throw on any failure, naming committed paths. */
  apply(changes: FileMutationChange[], signal: AbortSignal): Promise<void>;
}

const argument = (
  args: Record<string, unknown>,
  ...names: string[]
): string => {
  for (const name of names)
    if (typeof args[name] === 'string') return args[name] as string;
  throw Error(`missing string parameter: ${names.join(' / ')}`);
};

/** Read versions belong to each real session, including child-agent sessions. */
export class FileMutationTools {
  private versions = new Map<string, Map<string, FileMutationSnapshot>>();
  constructor(
    private sandbox: Sandbox,
    private backend: FileMutations,
  ) {}

  private session(context: ToolContext): Map<string, FileMutationSnapshot> {
    let versions = this.versions.get(context.sessionId);
    if (!versions) {
      versions = new Map();
      this.versions.set(context.sessionId, versions);
    }
    return versions;
  }

  async read(
    path: string,
    context: ToolContext,
  ): Promise<FileMutationSnapshot> {
    context.signal.throwIfAborted();
    this.sandbox.checkCredentialPath(path);
    const value = await this.backend.read(path, context.signal);
    context.signal.throwIfAborted();
    if (value.content === null || value.revision === null)
      throw Error(`file does not exist: ${path}`);
    this.session(context).set(path, value);
    return value;
  }

  private async snapshot(
    path: string,
    context: ToolContext,
    requireRead = false,
  ): Promise<FileMutationSnapshot> {
    this.sandbox.checkMutablePath(path);
    const previous = this.session(context).get(path);
    if (requireRead && !previous)
      throw Error('read_file must be called before editing this file');
    const current = await this.backend.read(path, context.signal);
    context.signal.throwIfAborted();
    if (previous && previous.revision !== current.revision)
      throw Error(
        `file changed since read_file: ${path}; read it again before writing`,
      );
    // An unread write is based on the preparation-time disk snapshot. It is
    // still checked after approval; it is never a blind post-approval snapshot.
    return previous ?? current;
  }

  private async commit(
    changes: FileMutationChange[],
    context: ToolContext,
  ): Promise<void> {
    context.signal.throwIfAborted();
    await this.backend.apply(changes, context.signal);
    const versions = this.session(context);
    for (const change of changes) {
      versions.delete(change.path);
      if (change.content === null) continue;
      try {
        const current = await this.backend.read(change.path, context.signal);
        // Only the content the model just wrote is a known model-side version.
        if (current.content === change.content && current.revision !== null)
          versions.set(change.path, current);
      } catch {
        /* A committed write must not become a failure because read-back failed. */
      }
    }
  }

  readonly prepareWrite: NonNullable<Tool['prepare']> = async (
    args,
    context,
  ) => {
    const path = this.sandbox.resolvePath(argument(args, 'file_path', 'path'));
    const content = argument(args, 'content');
    const original = await this.snapshot(path, context);
    const changes = [{ path, content, expectedRevision: original.revision }];
    return async (_args, approved) => {
      await this.commit(changes, approved);
      return `Wrote ${path}`;
    };
  };

  readonly prepareEdit: NonNullable<Tool['prepare']> = async (
    args,
    context,
  ) => {
    const path = this.sandbox.resolvePath(argument(args, 'file_path', 'path'));
    const original = await this.snapshot(path, context, true);
    const content = original.content;
    if (content === null) throw Error('cannot edit a missing file');
    const old = argument(args, 'old_string', 'oldString');
    const replacement = argument(args, 'new_string', 'newString');
    if (!old) throw Error('old_string cannot be empty');
    const count = content.split(old).length - 1;
    if (!count) throw Error('oldString not found in content');
    if (count > 1 && !args.replace_all && !args.replaceAll)
      throw Error(
        'Found multiple matches for oldString. Provide more surrounding lines or use replaceAll.',
      );
    const changes = [
      {
        path,
        content:
          args.replace_all || args.replaceAll
            ? content.replaceAll(old, replacement)
            : content.replace(old, replacement),
        expectedRevision: original.revision,
      },
    ];
    return async (_args, approved) => {
      await this.commit(changes, approved);
      return `Edited ${path}`;
    };
  };

  readonly preparePatch: NonNullable<Tool['prepare']> = async (
    args,
    context,
  ) => {
    const patch = argument(args, 'patchText');
    const snapshots = new Map<string, FileMutationSnapshot>();
    for (const path of patchFilePaths(patch, this.sandbox))
      snapshots.set(path, await this.snapshot(path, context));
    const planned = planPatch(patch, this.sandbox, (path) => {
      if (!snapshots.has(path))
        throw Error('patch referenced an unprepared path');
      return snapshots.get(path)!.content;
    });
    const changes = planned.map(({ path, content }) => ({
      path,
      content,
      expectedRevision: snapshots.get(path)!.revision,
    }));
    return async (_args, approved) => {
      await this.commit(changes, approved);
      return patchSummary(planned);
    };
  };
}
